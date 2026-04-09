/**
 * Integration Tests: Connection Persistence & Health Flows
 *
 * Spins up a real Fastify server with /ws/map (short heartbeat interval) and
 * connects raw WebSocket clients to test full end-to-end flows:
 *
 * 1. Graceful heartbeat — connections survive missed pongs up to threshold
 * 2. Connection health API — GET /map/connections returns live health data
 * 3. Hub/reconnect notification — sent before termination
 * 4. Connection degraded/recovered — broadcast on map:discovery channel
 * 5. Debounced heartbeat — DB writes are batched
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket, setHeartbeatInterval } from '../../map/ws-map.js';
import { getAllInbound, getConnectionHealth } from '../../map/connection-registry.js';
import { findSwarmById } from '../../db/dal/map.js';
import { mapRoutes } from '../../api/routes/map.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('conn-persist-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'conn-persist-e2e.db');
const SERVER_PORT = 19670;
const HEARTBEAT_MS = 200; // Short interval for fast tests

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ClientHandle {
  ws: WebSocket;
  messages: Array<{ method: string; params: Record<string, unknown> }>;
}

/**
 * Connect a raw WebSocket client to the hub. Returns a handle with
 * the WebSocket and a messages array that is populated from the start
 * (before the 'open' event resolves) so hub/welcome is never missed.
 */
function connectClient(token: string, swarmId?: string): Promise<ClientHandle> {
  return new Promise((resolve, reject) => {
    const qs = swarmId ? `&swarm_id=${swarmId}` : '';
    const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${token}${qs}`);

    // Start collecting messages immediately — before 'open' fires
    const messages: Array<{ method: string; params: Record<string, unknown> }> = [];
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method) messages.push(msg);
      } catch { /* ignore non-JSON */ }
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timeout'));
    }, 5000);
    ws.on('open', () => { clearTimeout(timeout); resolve({ ws, messages }); });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

/** Wait for a condition with timeout. */
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

// ============================================================================
// Test Suite
// ============================================================================

describe('Connection Persistence E2E', () => {
  let app: FastifyInstance;
  let config: Config;
  let ingestToken: string;
  let agentId: string;
  const clientHandles: ClientHandle[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'conn-persist-e2e-agent',
      description: 'Agent for connection persistence e2e tests',
    });
    agentId = agent.id;

    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'conn-persist-e2e',
      agent_id: agent.id,
    });
    ingestToken = plaintext_key;

    // Set local agent for REST API auth
    setLocalAgent(agent);

    config = ConfigSchema.parse({
      port: SERVER_PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'ConnPersist E2E', description: 'Test' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: {
        enabled: true,
        trustModel: 'open',
        missedPongsBeforeTerminate: 3,
        heartbeatDebounceMs: 1000, // Minimum allowed by schema
      },
    });

    setHeartbeatInterval(HEARTBEAT_MS);

    app = Fastify({ logger: false });
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.register(
      async (api) => { await api.register(mapRoutes, { config }); },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  });

  afterAll(async () => {
    for (const h of clientHandles) {
      try { h.ws.terminate(); } catch { /* ignore */ }
    }
    clientHandles.length = 0;

    setLocalAgent(null);
    stopMapWebSocket();
    await app?.close();
    await sleep(100);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    setHeartbeatInterval(30_000);
  });

  afterEach(async () => {
    for (const h of clientHandles) {
      try { h.ws.terminate(); } catch { /* ignore */ }
    }
    clientHandles.length = 0;
    await sleep(100);
  });

  // Helper: connect and wait for hub/welcome, returning swarmId
  async function connectAndWelcome(swarmHint: string): Promise<{ handle: ClientHandle; swarmId: string }> {
    const handle = await connectClient(ingestToken, swarmHint);
    clientHandles.push(handle);
    await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));
    const welcome = handle.messages.find(m => m.method === 'hub/welcome');
    expect(welcome).toBeDefined();
    return { handle, swarmId: welcome!.params.swarm_id as string };
  }

  // ─────────────────────────────────────────────────────────────────────
  // 1. Connection establishes and stays alive through heartbeat cycles
  // ─────────────────────────────────────────────────────────────────────

  it('client stays connected through multiple heartbeat cycles', async () => {
    const { handle, swarmId } = await connectAndWelcome('persist-stay-alive');

    await sleep(HEARTBEAT_MS * 5);

    expect(handle.ws.readyState).toBe(WebSocket.OPEN);
    expect(getAllInbound().get(swarmId)).toBeDefined();
    expect(findSwarmById(swarmId)?.status).toBe('online');
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────────
  // 2. Hub sends ping notifications and client stays alive via pong
  // ─────────────────────────────────────────────────────────────────────

  it('hub sends application-level pings and client receives them', async () => {
    const handle = await connectClient(ingestToken, 'persist-ping');
    clientHandles.push(handle);

    const gotPing = await waitFor(() => handle.messages.some(m => m.method === 'ping'), 3000);
    expect(gotPing).toBe(true);
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────────
  // 3. Connection health API returns live data for connected swarm
  // ─────────────────────────────────────────────────────────────────────

  it('GET /map/connections returns connected swarm health', async () => {
    const { swarmId } = await connectAndWelcome('persist-health-api');

    await sleep(HEARTBEAT_MS * 2);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.inbound.length).toBeGreaterThanOrEqual(1);
    const health = body.inbound.find((c: any) => c.swarmId === swarmId);
    expect(health).toBeDefined();
    expect(health.missedPongs).toBe(0);
    expect(health.transport).toBe('inbound');
    expect(health.connectedAt).toBeDefined();
    expect(health.lastMessageAt).toBeDefined();
    expect(body.summary.inbound_count).toBeGreaterThanOrEqual(1);
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────────
  // 4. Single swarm health endpoint
  // ─────────────────────────────────────────────────────────────────────

  it('GET /map/connections/:swarmId returns health for specific swarm', async () => {
    const { swarmId } = await connectAndWelcome('persist-single-health');

    await sleep(HEARTBEAT_MS * 2);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/connections/${swarmId}`,
    });

    expect(res.statusCode).toBe(200);
    const health = JSON.parse(res.payload);
    expect(health.swarmId).toBe(swarmId);
    expect(health.missedPongs).toBe(0);
    expect(health.maxMissedPongs).toBe(3);
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────────
  // 5. Unknown swarm returns 404
  // ─────────────────────────────────────────────────────────────────────

  it('GET /map/connections/:swarmId returns 404 for disconnected swarm', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections/nonexistent-swarm-id',
    });

    expect(res.statusCode).toBe(404);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. Swarm becomes unreachable after client disconnects
  // ─────────────────────────────────────────────────────────────────────

  it('swarm transitions to unreachable when client disconnects', async () => {
    const handle = await connectClient(ingestToken, 'persist-disconnect');
    // Don't push to clientHandles — we manage lifecycle manually
    await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));
    const swarmId = handle.messages.find(m => m.method === 'hub/welcome')!.params.swarm_id as string;

    expect(findSwarmById(swarmId)?.status).toBe('online');

    handle.ws.close();
    await sleep(300);

    expect(findSwarmById(swarmId)?.status).toBe('unreachable');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/connections/${swarmId}`,
    });
    expect(res.statusCode).toBe(404);
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────────
  // 7. Client that stops responding to pongs gets hub/reconnect then terminated
  // ─────────────────────────────────────────────────────────────────────

  it('unresponsive client is terminated and swarm becomes unreachable', async () => {
    const handle = await connectClient(ingestToken, 'persist-unresponsive');
    // Don't push to clientHandles — we manage lifecycle manually
    await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));
    const swarmId = handle.messages.find(m => m.method === 'hub/welcome')!.params.swarm_id as string;

    const conn = getAllInbound().get(swarmId);
    expect(conn).toBeDefined();

    // Suppress the pong handler so isAlive stays false.
    // The ws library auto-responds to protocol-level pings with pongs,
    // which sets isAlive=true. We need to remove that handler and
    // force isAlive=false to simulate an unresponsive client.
    conn!.ws.removeAllListeners('pong');
    const forceDeadInterval = setInterval(() => {
      if (conn) (conn.ws as any).isAlive = false;
    }, HEARTBEAT_MS / 4);

    // Wait for the connection to be removed from the registry
    // (proves the full termination flow completed)
    const terminated = await waitFor(
      () => !getAllInbound().has(swarmId),
      HEARTBEAT_MS * (config.mapHub.missedPongsBeforeTerminate + 5) + 2000,
    );

    clearInterval(forceDeadInterval);

    expect(terminated).toBe(true);

    // Swarm should be unreachable in DB
    expect(findSwarmById(swarmId)?.status).toBe('unreachable');

    // hub/reconnect should be delivered — ws.close() flushes the send buffer
    // before closing, unlike ws.terminate() which drops it
    await sleep(200); // allow close frame + buffered messages to arrive
    const reconnectMsg = handle.messages.find(m => m.method === 'hub/reconnect');
    expect(reconnectMsg).toBeDefined();
    expect(reconnectMsg!.params.reason).toBe('heartbeat_timeout');
    expect(reconnectMsg!.params.missed_pongs).toBe(config.mapHub.missedPongsBeforeTerminate);
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────────
  // 8. Multiple concurrent connections each get independent health
  // ─────────────────────────────────────────────────────────────────────

  it('multiple connections have independent health tracking', async () => {
    const { swarmId: swarmId1 } = await connectAndWelcome('persist-multi-1');
    const { swarmId: swarmId2 } = await connectAndWelcome('persist-multi-2');

    expect(swarmId1).not.toBe(swarmId2);

    await sleep(HEARTBEAT_MS * 2);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections',
    });

    const body = JSON.parse(res.payload);
    const health1 = body.inbound.find((c: any) => c.swarmId === swarmId1);
    const health2 = body.inbound.find((c: any) => c.swarmId === swarmId2);

    expect(health1).toBeDefined();
    expect(health2).toBeDefined();
    expect(health1.missedPongs).toBe(0);
    expect(health2.missedPongs).toBe(0);
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────────
  // 9. Heartbeat DB debouncing — swarm stays online despite debounce delay
  // ─────────────────────────────────────────────────────────────────────

  it('debounced heartbeat keeps swarm online over multiple cycles', async () => {
    const { swarmId } = await connectAndWelcome('persist-debounce');

    // Wait for many heartbeat cycles (well past debounce window)
    await sleep(HEARTBEAT_MS * 8);

    const swarm = findSwarmById(swarmId);
    expect(swarm?.status).toBe('online');

    // last_seen_at should be recent
    const lastSeen = new Date(swarm!.last_seen_at).getTime();
    expect(Date.now() - lastSeen).toBeLessThan(5000);
  }, 10_000);
});
