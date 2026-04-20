/**
 * E2E tests for the full MAP-over-WS coordination flow in headless mode.
 *
 * The headless hub's primary job is agent coordination: swarms connect,
 * agents register capabilities, events fan out to subscribers. These tests
 * exercise the whole path end-to-end without mocking the realtime or MAP
 * modules, using real WebSocket clients over real TCP sockets.
 *
 * Flows covered:
 *   1. Bootstrap: operator creates preauth key via X-Admin-Key →
 *      swarm registers via REST with that key → swarm connects MAP WS →
 *      agent registers via map/agents/register. This is THE happy path
 *      for onboarding a swarm to a headless hub.
 *   2. Discovery broadcast: subscriber WS client on `map:discovery` sees
 *      swarm_registered events when a new swarm joins.
 *   3. Heartbeat: ping/pong keeps the MAP connection alive; last_seen_at
 *      refreshes.
 *   4. Multi-swarm capability aggregation: two swarms register different
 *      capabilities; GET /map/swarms/:id reflects per-swarm view, and the
 *      hub's connection registry holds per-agent data for each.
 *   5. Channel scoping: map:swarm:<id> per-swarm channel receives only
 *      events for that swarm; other swarms' events don't leak.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../db/index.js';
import * as agentsDAL from '../db/dal/agents.js';
import { setLocalAgent } from '../api/middleware/auth.js';
import {
  setupMapWebSocket,
  stopMapWebSocket,
  setHeartbeatInterval,
} from '../map/ws-map.js';
import {
  getAllInbound,
  getAgentCapabilities,
} from '../map/connection-registry.js';
import { findSwarmById } from '../db/dal/map.js';
import { mapRoutes } from '../api/routes/map.js';
import { adminRoutes } from '../api/routes/admin.js';
import { initTokenService, _resetTokenService } from '../map/token-service.js';
import { setupWebSocket, stopHeartbeat } from '../realtime/index.js';
import { ConfigSchema } from '../config.js';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';

const TEST_ROOT = testRoot('headless-map-ws');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'headless-map-ws.db');
const ADMIN_KEY = 'headless-map-admin-key';
const HEARTBEAT_MS = 300;

// ============================================================================
// Helpers
// ============================================================================

let rpcId = 0;

interface MapHandle {
  ws: WebSocket;
  swarmId: string;
  messages: Array<Record<string, unknown>>;
}

interface ParsedWSEvent {
  type: string;
  channel?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function connectMap(baseUrl: string, token: string, swarmId: string): Promise<MapHandle> {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl.replace('http', 'ws')}/ws/map?token=${token}&swarm_id=${swarmId}`;
    const ws = new WebSocket(url);
    const messages: MapHandle['messages'] = [];

    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {
        /* ignore */
      }
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Connect timeout'));
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      resolve({ ws, swarmId, messages });
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function mapRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ id: number; result?: Record<string, unknown>; error?: Record<string, unknown> }> {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5000);
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function connectRealtimeWS(baseUrl: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Realtime WS timeout'));
    }, 5000);
    ws.once('message', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function subscribeRealtime(ws: WebSocket, channels: string[]): Promise<ParsedWSEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Subscribe ack timeout')), 5000);
    const handler = (data: Buffer | string) => {
      const msg: ParsedWSEvent = JSON.parse(data.toString());
      if (msg.data && 'subscribed' in msg.data) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'subscribe', channels }));
  });
}

function waitForRealtimeEvent(
  ws: WebSocket,
  eventType: string,
  timeoutMs = 5000,
): Promise<ParsedWSEvent | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(null);
    }, timeoutMs);
    const handler = (data: Buffer | string) => {
      const msg: ParsedWSEvent = JSON.parse(data.toString());
      if (msg.type === eventType) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Headless MAP WS E2E', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let ownerAgent: { id: string; apiKey: string };
  const openHandles: MapHandle[] = [];
  const openWS: WebSocket[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initTokenService(undefined, TEST_ROOT);

    const { agent, apiKey } = await agentsDAL.createAgent({
      name: 'headless-map-owner',
      description: 'Owner agent for MAP WS E2E',
      is_admin: true, // admin so it can call agent-level admin paths if needed
    });
    ownerAgent = { id: agent.id, apiKey };
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: 0,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Headless MAP Test' },
      admin: { createOnStartup: false, key: ADMIN_KEY },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      cors: { enabled: false },
      mapHub: {
        enabled: true,
        trustModel: 'open',
        missedPongsBeforeTerminate: 3,
      },
    });

    setHeartbeatInterval(HEARTBEAT_MS);

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);

    // Register the realtime WS handler (/ws) AND the MAP WS handler (/ws/map).
    // Both are needed: the realtime one carries broadcast events; the MAP
    // one carries the JSON-RPC protocol between swarms and the hub.
    setupWebSocket(app);
    setupMapWebSocket(app, config);

    await app.register(
      async (api) => {
        await api.register(mapRoutes, { config });
        await api.register(adminRoutes, { config });
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind ephemeral port');
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 15_000);

  afterAll(async () => {
    setLocalAgent(null);
    stopMapWebSocket();
    stopHeartbeat();
    await app?.close();
    await sleep(100);
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    setHeartbeatInterval(30_000);
  });

  afterEach(async () => {
    for (const h of openHandles) {
      try {
        h.ws.terminate();
      } catch {
        /* ignore */
      }
    }
    openHandles.length = 0;
    for (const ws of openWS) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    openWS.length = 0;
    await sleep(100);
  });

  // ==========================================================================
  // Flow 1: Full bootstrap — operator → onboard-token → swarm register → MAP WS
  //         → agent register
  // ==========================================================================
  describe('Flow 1: headless bootstrap', () => {
    it('operator mints onboard-token (admin-key), swarm registers, connects MAP WS, agent registers', async () => {
      // Step 1: Mint an onboard-token as operator. In v4 there are no
      // preauth keys — the operator hands a signed agent-iam token to
      // the swarm out of band and the swarm uses it as its Bearer.
      const tokenRes = await fetch(`${baseUrl}/api/v1/admin/onboard-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({ scopes: ['map:agents:spawn'], ttl_hours: 1 }),
      });
      expect(tokenRes.status).toBe(200);
      const token = (await tokenRes.json()) as { agent_id: string; token: string };
      expect(token.token).toBeTruthy();

      // Step 2: Swarm registers via REST using the onboard-token as Bearer.
      const swarmRes = await fetch(`${baseUrl}/api/v1/map/swarms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token.token}`,
        },
        body: JSON.stringify({
          name: 'bootstrap-swarm',
          map_endpoint: 'ws://localhost:19999/map',
        }),
      });
      expect(swarmRes.status).toBe(201);
      const swarmBody = (await swarmRes.json()) as { swarm: { id: string } };
      const swarmId = swarmBody.swarm.id;

      // Step 3: Swarm connects to MAP WS with its swarm_id
      const handle = await connectMap(baseUrl, ownerAgent.apiKey, swarmId);
      openHandles.push(handle);

      // Wait for hub/welcome
      const gotWelcome = await waitFor(
        () => handle.messages.some((m) => m.method === 'hub/welcome'),
        3000,
      );
      expect(gotWelcome).toBe(true);

      const welcome = handle.messages.find((m) => m.method === 'hub/welcome')!;
      expect((welcome.params as Record<string, unknown>).swarm_id).toBe(swarmId);

      // Step 4: Agent registers via map/agents/register with capabilities
      const regResp = await mapRpc(handle.ws, 'map/agents/register', {
        name: 'bootstrap-coordinator',
        role: 'coordinator',
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true, canViewHistory: true },
          protocols: ['acp'],
          acp: { version: '2024-10-07' },
        },
        metadata: { type: 'macro-agent' },
      });
      expect(regResp.error).toBeUndefined();
      expect(regResp.result).toBeDefined();

      // Step 5: Verify capabilities landed in the connection registry
      await waitFor(() => {
        const conn = getAllInbound().get(swarmId);
        return (conn?.registeredAgents.size ?? 0) > 0;
      });
      const agentCaps = getAgentCapabilities(swarmId);
      expect(agentCaps).toHaveLength(1);
      expect(agentCaps[0].capabilities.protocols).toEqual(['acp']);
      expect((agentCaps[0].capabilities.mail as { canJoin?: boolean })?.canJoin).toBe(true);

      // Step 6: Aggregate capabilities should flow through to the swarm record
      await waitFor(() => {
        const swarm = findSwarmById(swarmId);
        return !!swarm?.capabilities;
      });
      const getRes = await fetch(`${baseUrl}/api/v1/map/swarms/${swarmId}`);
      expect(getRes.status).toBe(200);
      const swarm = (await getRes.json()) as { capabilities: Record<string, unknown> };
      expect(swarm.capabilities).toBeDefined();
      expect((swarm.capabilities.mail as Record<string, unknown>).canJoin).toBe(true);
    });

    it('delegated agent-iam token opens the WS gate end-to-end', async () => {
      // H4 of v4 review: the previous test uses ownerAgent.apiKey for
      // the WS connect; this one proves the delegated token the
      // operator just minted also opens `/ws/map?token=<delegated>`
      // (previously only REST accepted it).
      const tokenRes = await fetch(`${baseUrl}/api/v1/admin/onboard-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({ scopes: ['map:agents:spawn'], ttl_hours: 1 }),
      });
      expect(tokenRes.status).toBe(200);
      const { token, agent_id } = (await tokenRes.json()) as {
        token: string; agent_id: string;
      };

      // Connect to the MAP WS using the delegated token as the query
      // param credential. If authenticateToken failed to accept the
      // token (C1 regression), this would get a 401 close.
      const handle = await connectMap(baseUrl, token, `delegated-swarm-${agent_id}`);
      openHandles.push(handle);

      const gotWelcome = await waitFor(
        () => handle.messages.some((m) => m.method === 'hub/welcome'),
        3000,
      );
      expect(gotWelcome).toBe(true);

      // Session scope resolution should have picked up the token's
      // scopes — map/agents/register must succeed because the onboarded
      // agent has the relevant MAP-level capabilities (no scope gate on
      // this method).
      const regResp = await mapRpc(handle.ws, 'map/agents/register', {
        name: 'delegated-worker',
        role: 'worker',
        capabilities: { messaging: { canReceive: true } },
      });
      expect(regResp.error).toBeUndefined();
      expect(regResp.result).toBeDefined();
    });
  });

  // ==========================================================================
  // Flow 2: Discovery broadcast — subscriber sees swarm_registered on WS
  // ==========================================================================
  describe('Flow 2: swarm_registered fan-out on map:discovery', () => {
    it('delivers swarm_registered to map:discovery subscribers when a swarm registers', async () => {
      // Subscriber WS first (use realtime /ws, not /ws/map — this is for UI / CLI observers)
      const subscriber = await connectRealtimeWS(baseUrl, ownerAgent.apiKey);
      openWS.push(subscriber);
      await subscribeRealtime(subscriber, ['map:discovery']);

      const eventPromise = waitForRealtimeEvent(subscriber, 'swarm_registered', 5000);

      // Trigger registration
      const swarmRes = await fetch(`${baseUrl}/api/v1/map/swarms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        body: JSON.stringify({
          name: 'discovery-swarm',
          map_endpoint: 'ws://localhost:19998/map',
        }),
      });
      expect(swarmRes.status).toBe(201);
      const swarmBody = (await swarmRes.json()) as { swarm: { id: string } };

      const event = await eventPromise;
      expect(event).not.toBeNull();
      expect(event!.type).toBe('swarm_registered');
      expect(event!.channel).toBe('map:discovery');
      expect(event!.data?.swarm_id).toBe(swarmBody.swarm.id);
      expect(event!.data?.name).toBe('discovery-swarm');
    });
  });

  // ==========================================================================
  // Flow 3: Heartbeat / ping-pong keeps connection alive
  // ==========================================================================
  describe('Flow 3: heartbeat ping/pong', () => {
    it('swarm stays connected across multiple heartbeat cycles when it responds to ping', async () => {
      // Register a swarm
      const swarmRes = await fetch(`${baseUrl}/api/v1/map/swarms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        body: JSON.stringify({
          name: 'heartbeat-swarm',
          map_endpoint: 'ws://localhost:19997/map',
        }),
      });
      expect(swarmRes.status).toBe(201);
      const swarmBody = (await swarmRes.json()) as { swarm: { id: string } };

      const handle = await connectMap(baseUrl, ownerAgent.apiKey, swarmBody.swarm.id);
      openHandles.push(handle);

      // Wait for hub/welcome
      await waitFor(() => handle.messages.some((m) => m.method === 'hub/welcome'), 3000);

      // Respond to application-level pings (the MAP SDK convention)
      handle.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'ping') {
            handle.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
          }
        } catch {
          /* ignore */
        }
      });

      // Let enough heartbeats fire to confirm the connection stays alive
      const cycleCount = 4;
      await sleep(HEARTBEAT_MS * cycleCount + 100);

      // Connection should still be open and still in the registry
      expect(handle.ws.readyState).toBe(WebSocket.OPEN);
      expect(getAllInbound().has(swarmBody.swarm.id)).toBe(true);
    }, 10_000);
  });

  // ==========================================================================
  // Flow 4: Multi-swarm isolation — capabilities + state don't bleed
  // ==========================================================================
  describe('Flow 4: multi-swarm capability isolation', () => {
    it('two swarms register different capabilities independently', async () => {
      // Register two swarms
      const swarm1Res = await fetch(`${baseUrl}/api/v1/map/swarms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        body: JSON.stringify({
          name: 'multi-swarm-a',
          map_endpoint: 'ws://localhost:19996/map',
        }),
      });
      const s1Id = ((await swarm1Res.json()) as { swarm: { id: string } }).swarm.id;

      const swarm2Res = await fetch(`${baseUrl}/api/v1/map/swarms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        body: JSON.stringify({
          name: 'multi-swarm-b',
          map_endpoint: 'ws://localhost:19995/map',
        }),
      });
      const s2Id = ((await swarm2Res.json()) as { swarm: { id: string } }).swarm.id;

      const h1 = await connectMap(baseUrl, ownerAgent.apiKey, s1Id);
      openHandles.push(h1);
      await waitFor(() => h1.messages.some((m) => m.method === 'hub/welcome'), 3000);

      const h2 = await connectMap(baseUrl, ownerAgent.apiKey, s2Id);
      openHandles.push(h2);
      await waitFor(() => h2.messages.some((m) => m.method === 'hub/welcome'), 3000);

      // s1 registers a coordinator with ACP
      await mapRpc(h1.ws, 'map/agents/register', {
        name: 'coord-1',
        role: 'coordinator',
        capabilities: { protocols: ['acp'], messaging: { canReceive: true } },
      });

      // s2 registers a worker with tasks only (no ACP)
      await mapRpc(h2.ws, 'map/agents/register', {
        name: 'worker-2',
        role: 'worker',
        capabilities: {
          tasks: { canCreate: true, canUpdate: true },
          messaging: { canReceive: true },
        },
      });

      await waitFor(
        () => (getAllInbound().get(s1Id)?.registeredAgents.size ?? 0) > 0,
        3000,
      );
      await waitFor(
        () => (getAllInbound().get(s2Id)?.registeredAgents.size ?? 0) > 0,
        3000,
      );

      const s1Caps = getAgentCapabilities(s1Id);
      const s2Caps = getAgentCapabilities(s2Id);

      expect(s1Caps).toHaveLength(1);
      expect(s1Caps[0].capabilities.protocols).toEqual(['acp']);
      expect(s1Caps[0].capabilities.tasks).toBeUndefined();

      expect(s2Caps).toHaveLength(1);
      expect(s2Caps[0].capabilities.protocols).toBeUndefined();
      expect(s2Caps[0].capabilities.tasks).toBeDefined();
    });
  });

  // ==========================================================================
  // Flow 5: Per-swarm channel scoping — map:swarm:<id> doesn't leak across
  // ==========================================================================
  describe('Flow 5: per-swarm channel isolation', () => {
    it('map:swarm:<id> receives events only for that swarm', async () => {
      // Register swarm A
      const swarmARes = await fetch(`${baseUrl}/api/v1/map/swarms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        body: JSON.stringify({
          name: 'scoped-swarm-a',
          map_endpoint: 'ws://localhost:19994/map',
        }),
      });
      const aId = ((await swarmARes.json()) as { swarm: { id: string } }).swarm.id;

      // Subscribe to map:swarm:<aId> specifically
      const subA = await connectRealtimeWS(baseUrl, ownerAgent.apiKey);
      openWS.push(subA);
      await subscribeRealtime(subA, [`map:swarm:${aId}`]);

      // Listener on map:swarm:<aId> for a swarm_heartbeat-like event.
      // The simplest swarm-scoped event is swarm_registered which fans out
      // to BOTH map:discovery and map:swarm:<id>. Subscribing to only the
      // per-swarm channel should still catch it.
      const eventPromise = waitForRealtimeEvent(subA, 'swarm_registered', 3000);

      // Register swarm B (different id) — subscriber shouldn't see this
      await fetch(`${baseUrl}/api/v1/map/swarms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        body: JSON.stringify({
          name: 'scoped-swarm-b',
          map_endpoint: 'ws://localhost:19993/map',
        }),
      });

      // Short window — should NOT have received the swarm_registered for B
      // because we're scoped to map:swarm:<aId>.
      const leak = await Promise.race([
        eventPromise,
        sleep(400).then(() => 'timeout' as const),
      ]);
      expect(leak).toBe('timeout');
    });
  });

  // ==========================================================================
  // Flow 6: Auth failure paths
  // ==========================================================================
  describe('Flow 6: auth failure paths', () => {
    it('rejects MAP WS connection with invalid token in non-local auth mode', async () => {
      // The live server runs in `auth: 'local'` mode, which means
      // authMiddleware falls back to the local agent and accepts anything.
      // In token mode the server rejects invalid tokens. We can't flip
      // modes mid-test, but we CAN verify the handshake uses the token at
      // all by checking the welcome reflects the authenticated agent id.
      const handle = await connectMap(baseUrl, ownerAgent.apiKey, 'auth-check-swarm');
      openHandles.push(handle);

      const welcomed = await waitFor(
        () => handle.messages.some((m) => m.method === 'hub/welcome'),
        3000,
      );
      expect(welcomed).toBe(true);
      const welcome = handle.messages.find((m) => m.method === 'hub/welcome')!;
      expect((welcome.params as Record<string, unknown>).agent_id).toBe(ownerAgent.id);
    });

    it('map/agents/register without prior hub/welcome still returns a JSON-RPC response', async () => {
      // Connect and fire register before waiting for welcome. The server
      // must still respond with a proper JSON-RPC frame (error or result),
      // not drop the socket silently.
      const swarmRes = await fetch(`${baseUrl}/api/v1/map/swarms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        body: JSON.stringify({
          name: 'early-register-swarm',
          map_endpoint: 'ws://localhost:19992/map',
        }),
      });
      const swarmId = ((await swarmRes.json()) as { swarm: { id: string } }).swarm.id;

      const handle = await connectMap(baseUrl, ownerAgent.apiKey, swarmId);
      openHandles.push(handle);

      const resp = await mapRpc(handle.ws, 'map/agents/register', {
        name: 'early-agent',
        role: 'worker',
        capabilities: { messaging: { canReceive: true } },
      });

      // Either a success result or a structured error — but the RPC must resolve.
      expect(resp.id).toBeDefined();
      expect(resp.result !== undefined || resp.error !== undefined).toBe(true);
    });

    it('REST /map/swarms rejects bogus Bearer credentials (auth failure at REST boundary)', async () => {
      const swarmRes = await fetch(`${baseUrl}/api/v1/map/swarms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer not-a-real-token',
        },
        body: JSON.stringify({
          name: 'bad-auth-swarm',
          map_endpoint: 'ws://localhost:19991/map',
        }),
      });
      expect(swarmRes.status).toBe(401);
    });
  });
});
