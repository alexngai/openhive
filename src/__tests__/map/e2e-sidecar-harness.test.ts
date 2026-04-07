/**
 * E2E Tests: Sidecar-Style Test Harness
 *
 * Mimics what a claude-code-swarm sidecar does using raw WebSocket +
 * JSON-RPC 2.0, exercising the full protocol flow that a real agent
 * runtime would follow:
 *
 *   1. Connect with ingest key + swarm_id
 *   2. Receive hub/welcome
 *   3. Register agent via map/agents/register with capabilities + metadata
 *   4. Send trajectory checkpoints
 *   5. Respond to ping/pong keepalive
 *   6. Handle hub/reconnect → reconnect with fresh backoff
 *   7. Survive heartbeat cycles
 *
 * This is the closest we can get to testing with the real cc-swarm
 * sidecar without the claude-code-swarm package installed.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket, setHeartbeatInterval } from '../../map/ws-map.js';
import { getAllInbound } from '../../map/connection-registry.js';
import { findSwarmById } from '../../db/dal/map.js';
import { mapRoutes } from '../../api/routes/map.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('e2e-sidecar-harness');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'sidecar-harness.db');
const PORT = 19678;
const HEARTBEAT_MS = 300;

// ============================================================================
// Sidecar Harness — mimics cc-swarm behavior over raw WebSocket
// ============================================================================

let rpcId = 0;

interface SidecarHandle {
  ws: WebSocket;
  swarmId: string;
  messages: Array<{ method?: string; id?: number; result?: any; error?: any; params?: any }>;
  close(): void;
}

/**
 * Connect to the hub mimicking a cc-swarm sidecar:
 * - Attaches message listener before open (catches hub/welcome)
 * - Auto-responds to ping with pong (like a real sidecar)
 * - Collects all JSON-RPC messages
 */
function connectSidecar(token: string, swarmId: string): Promise<SidecarHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/map?token=${token}&swarm_id=${swarmId}`);
    const messages: SidecarHandle['messages'] = [];

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        messages.push(msg);

        // Auto-respond to ping like a real sidecar does
        if (msg.method === 'ping') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
        }
      } catch { /* ignore non-JSON */ }
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Sidecar connect timeout'));
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      resolve({
        ws,
        swarmId,
        messages,
        close() { ws.close(); },
      });
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

/** Send a JSON-RPC request and await the response. */
function rpc(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
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

/** Send a JSON-RPC notification (no id, no response expected). */
function notify(ws: WebSocket, method: string, params: Record<string, unknown>): void {
  ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
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

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Sidecar-Style Harness', () => {
  let app: FastifyInstance;
  let ingestToken: string;
  const handles: SidecarHandle[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'sidecar-harness-agent',
      description: 'Agent for sidecar harness e2e',
    });

    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'sidecar-harness',
      agent_id: agent.id,
    });
    ingestToken = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Sidecar Harness E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
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
    setupMapWebSocket(app, config);
    await app.register(
      async (api) => { await api.register(mapRoutes, { config }); },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    for (const h of handles) {
      try { h.ws.terminate(); } catch { /* ignore */ }
    }
    handles.length = 0;

    setLocalAgent(null);
    stopMapWebSocket();
    await app?.close();
    await sleep(200);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    setHeartbeatInterval(30_000);
  });

  afterEach(async () => {
    for (const h of handles) {
      try { h.ws.terminate(); } catch { /* ignore */ }
    }
    handles.length = 0;
    await sleep(200);
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. Connect and receive hub/welcome
  // ─────────────────────────────────────────────────────────────────

  it('sidecar connects and receives hub/welcome with swarm identity', async () => {
    const swarmId = `sidecar-welcome-${Date.now()}`;
    const handle = await connectSidecar(ingestToken, swarmId);
    handles.push(handle);

    await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

    const welcome = handle.messages.find(m => m.method === 'hub/welcome');
    expect(welcome).toBeDefined();
    expect(welcome!.params.swarm_id).toBe(swarmId);
    expect(welcome!.params.agent_id).toBeDefined();
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────
  // 2. Register agent with capabilities + metadata (like real sidecar)
  // ─────────────────────────────────────────────────────────────────

  it('registers agent via MAP protocol with capabilities and metadata', async () => {
    const swarmId = `sidecar-register-${Date.now()}`;
    const handle = await connectSidecar(ingestToken, swarmId);
    handles.push(handle);

    await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

    // Register agent like cc-swarm does
    const regResp = await rpc(handle.ws, 'map/agents/register', {
      name: 'claude-code-worker',
      role: 'executor',
      capabilities: {
        'trajectory.canReport': true,
        'trajectory.canServeContent': true,
      },
      metadata: {
        project: 'openhive',
        branch: 'agents',
      },
    });

    expect(regResp.result).toBeDefined();
    expect(regResp.result.agent).toBeDefined();
    expect(regResp.result.agent.name).toBe('claude-code-worker');
    expect(regResp.result.agent.role).toBe('executor');

    // Hub should track the registered agent
    await waitFor(() => {
      const conn = getAllInbound().get(swarmId);
      return (conn?.registeredAgents.size ?? 0) > 0;
    });

    const conn = getAllInbound().get(swarmId);
    expect(conn!.registeredAgents.size).toBe(1);
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────
  // 3. Send trajectory checkpoint (like sessionlog hook does)
  // ─────────────────────────────────────────────────────────────────

  it('sends trajectory/checkpoint notification to hub', async () => {
    const swarmId = `sidecar-trajectory-${Date.now()}`;
    const handle = await connectSidecar(ingestToken, swarmId);
    handles.push(handle);

    await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

    // Send a trajectory checkpoint notification (fire-and-forget)
    notify(handle.ws, 'trajectory/checkpoint', {
      resource_id: 'res_session_001',
      agent_id: 'claude-code',
      commit_hash: 'abc123def456',
      timestamp: new Date().toISOString(),
      checkpoint: {
        id: 'cp-001',
        session_id: 'sess-001',
        agent: 'Claude Code',
        branch: 'agents',
        files_touched: ['src/map/ws-map.ts', 'src/map/sync-client.ts'],
        checkpoints_count: 1,
      },
    });

    // Give hub time to process the notification
    await sleep(200);

    // Connection should still be alive (notification shouldn't break anything)
    expect(handle.ws.readyState).toBe(WebSocket.OPEN);
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────
  // 4. Ping/pong keepalive (sidecar auto-responds)
  // ─────────────────────────────────────────────────────────────────

  it('sidecar auto-responds to ping keeping connection alive', async () => {
    const swarmId = `sidecar-keepalive-${Date.now()}`;
    const handle = await connectSidecar(ingestToken, swarmId);
    handles.push(handle);

    await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

    // Wait for several heartbeat cycles
    await sleep(HEARTBEAT_MS * 5);

    // Should have received pings
    const pings = handle.messages.filter(m => m.method === 'ping');
    expect(pings.length).toBeGreaterThanOrEqual(1);

    // Connection should still be alive
    expect(handle.ws.readyState).toBe(WebSocket.OPEN);
    expect(getAllInbound().has(swarmId)).toBe(true);
    expect(findSwarmById(swarmId)?.status).toBe('online');
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────
  // 5. Hub/reconnect received before termination
  // ─────────────────────────────────────────────────────────────────

  it('sidecar receives hub/reconnect when connection degrades', async () => {
    const swarmId = `sidecar-reconnect-${Date.now()}`;
    const handle = await connectSidecar(ingestToken, swarmId);
    // Don't push to handles — we manage lifecycle

    await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

    // Force missed pongs
    const conn = getAllInbound().get(swarmId);
    expect(conn).toBeDefined();
    conn!.ws.removeAllListeners('pong');
    const forceInterval = setInterval(() => {
      const c = getAllInbound().get(swarmId);
      if (c) (c.ws as any).isAlive = false;
    }, HEARTBEAT_MS / 4);

    // Wait for hub/reconnect or connection removal
    await waitFor(
      () => !getAllInbound().has(swarmId),
      HEARTBEAT_MS * 6 + 2000,
    );
    clearInterval(forceInterval);

    // Allow close frames to flush
    await sleep(300);

    // Should have received hub/reconnect before disconnection
    const reconnectMsg = handle.messages.find(m => m.method === 'hub/reconnect');
    expect(reconnectMsg).toBeDefined();
    expect(reconnectMsg!.params.reason).toBe('heartbeat_timeout');
    expect(reconnectMsg!.params.missed_pongs).toBe(3);

    // Swarm should be unreachable
    expect(findSwarmById(swarmId)?.status).toBe('unreachable');
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────
  // 6. Manual reconnect: same swarm_id, new connection
  // ─────────────────────────────────────────────────────────────────

  it('sidecar reconnects with same swarm_id and resumes', async () => {
    const swarmId = `sidecar-resume-${Date.now()}`;

    // First connection
    const handle1 = await connectSidecar(ingestToken, swarmId);
    await waitFor(() => handle1.messages.some(m => m.method === 'hub/welcome'));
    expect(findSwarmById(swarmId)?.status).toBe('online');

    // Disconnect
    handle1.close();
    await sleep(300);
    expect(findSwarmById(swarmId)?.status).toBe('unreachable');

    // Reconnect with same swarm_id
    const handle2 = await connectSidecar(ingestToken, swarmId);
    handles.push(handle2);
    await waitFor(() => handle2.messages.some(m => m.method === 'hub/welcome'));

    // Should be back online
    expect(findSwarmById(swarmId)?.status).toBe('online');
    expect(getAllInbound().has(swarmId)).toBe(true);

    // Can register agent on the new connection
    const regResp = await rpc(handle2.ws, 'map/agents/register', {
      name: 'resumed-worker',
      role: 'executor',
    });
    expect(regResp.result.agent).toBeDefined();
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────
  // 7. Full lifecycle: connect → register → checkpoint → degrade → reconnect
  // ─────────────────────────────────────────────────────────────────

  it('full sidecar lifecycle: connect → register → checkpoint → terminate → reconnect', async () => {
    const swarmId = `sidecar-lifecycle-${Date.now()}`;

    // Phase 1: Connect + register + send checkpoint
    const handle1 = await connectSidecar(ingestToken, swarmId);
    await waitFor(() => handle1.messages.some(m => m.method === 'hub/welcome'));

    await rpc(handle1.ws, 'map/agents/register', {
      name: 'lifecycle-worker',
      role: 'executor',
      capabilities: { 'trajectory.canReport': true },
      metadata: { project: 'openhive', branch: 'agents' },
    });

    notify(handle1.ws, 'trajectory/checkpoint', {
      resource_id: 'res_lifecycle',
      agent_id: 'lifecycle-worker',
      commit_hash: 'lifecycle123',
      timestamp: new Date().toISOString(),
      checkpoint: {
        id: 'cp-lifecycle',
        session_id: 'sess-lifecycle',
        agent: 'Claude Code',
        files_touched: ['src/server.ts'],
        checkpoints_count: 1,
      },
    });

    await sleep(200);
    expect(findSwarmById(swarmId)?.status).toBe('online');

    // Phase 2: Disconnect (simulate network drop)
    handle1.ws.terminate();
    await sleep(300);
    expect(findSwarmById(swarmId)?.status).toBe('unreachable');

    // Phase 3: Reconnect (sidecar restarts)
    const handle2 = await connectSidecar(ingestToken, swarmId);
    handles.push(handle2);
    await waitFor(() => handle2.messages.some(m => m.method === 'hub/welcome'));

    // Re-register agent
    const regResp = await rpc(handle2.ws, 'map/agents/register', {
      name: 'lifecycle-worker-resumed',
      role: 'executor',
    });
    expect(regResp.result.agent).toBeDefined();

    // Phase 4: Verify healthy
    await sleep(HEARTBEAT_MS * 3);
    expect(findSwarmById(swarmId)?.status).toBe('online');
    expect(handle2.ws.readyState).toBe(WebSocket.OPEN);

    // Health API should show the connection
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/connections/${swarmId}`,
    });
    expect(res.statusCode).toBe(200);
    const health = JSON.parse(res.payload);
    expect(health.missedPongs).toBe(0);
    expect(health.registeredAgentCount).toBeGreaterThanOrEqual(1);
  }, 20_000);

  // ─────────────────────────────────────────────────────────────────
  // 8. Connection health shows correct agent count after registration
  // ─────────────────────────────────────────────────────────────────

  it('health API shows registered agents from sidecar', async () => {
    const swarmId = `sidecar-health-agents-${Date.now()}`;
    const handle = await connectSidecar(ingestToken, swarmId);
    handles.push(handle);

    await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

    // Register two agents
    await rpc(handle.ws, 'map/agents/register', { name: 'worker-a', role: 'executor' });
    await rpc(handle.ws, 'map/agents/register', { name: 'worker-b', role: 'reviewer' });

    await waitFor(() => {
      const conn = getAllInbound().get(swarmId);
      return (conn?.registeredAgents.size ?? 0) >= 2;
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/connections/${swarmId}`,
    });

    expect(res.statusCode).toBe(200);
    const health = JSON.parse(res.payload);
    expect(health.registeredAgentCount).toBe(2);
    expect(health.registeredAgents.length).toBe(2);

    const names = health.registeredAgents.map((a: any) => a.name).sort();
    expect(names).toEqual(['worker-a', 'worker-b']);
  }, 10_000);
});
