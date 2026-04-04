/**
 * E2E Routing Tests: WebSocket Message Routing Through MAPServer
 *
 * Verifies that sync, coordination, tasks, and mail messages
 * are correctly routed through the MAPServer-based WebSocket handler.
 *
 * Routing paths:
 *   - Notifications (no `id`): notification interceptor handles sync, coordination, ping, mail
 *   - Requests (with `id`): MAPServer's additionalHandlers handle tasks, ping
 *   - Mail requests (with `id`): MAPServer returns method-not-found (mail is notification-only)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService, createSwarmToken, _resetTokenService } from '../../map/token-service.js';
import { generateSecret } from 'agent-iam';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Helpers — raw MAP client over WebSocket
// ============================================================================

let rpcId = 0;
function nextId() { return ++rpcId; }

/** Open a WebSocket and wait for it to be ready. */
async function openWs(url: string): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
    setTimeout(() => reject(new Error('Connect timeout')), 5000);
  });
  // Wait for server-side async handler (bcrypt auth) to set up listeners
  await new Promise((r) => setTimeout(r, 150));
  return ws;
}

/** Send a JSON-RPC request and await the response by id. */
function rpc(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId();
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

/** Wait for the next server-pushed notification (no id) matching a method. */
function waitNotification(ws: WebSocket, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Notification timeout')), timeoutMs);
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString());
      if (!msg.id && msg.method) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

/** Send a notification (no id) through the WebSocket. */
function sendNotification(ws: WebSocket, method: string, params: Record<string, unknown>): void {
  ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

// ============================================================================
// Open Mode: Notification Routing
// ============================================================================

describe('E2E Routing: Open Mode — notification and request routing', () => {
  const TEST_ROOT = testRoot('map-e2e-routing-open');
  const TEST_DB = testDbPath(TEST_ROOT, 'routing-open.db');
  const PORT = 19680;
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB);

    const result = await agentsDAL.createAgent({ name: 'routing-open-agent' });
    apiKey = result.apiKey;

    const config = ConfigSchema.parse({
      port: PORT, host: '127.0.0.1', database: TEST_DB,
      instance: { name: 'Routing Open Test' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      cors: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open' },
    });

    app = Fastify({ logger: false });
    app.decorateRequest('agent', null);
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.listen({ port: PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    stopMapWebSocket();
    await new Promise((r) => setTimeout(r, 100));
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  /** Connect in open mode and consume the hub/welcome notification. */
  async function openModeConnect(swarmId: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`);
    const welcomePromise = waitNotification(ws, 5000);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Open timeout')), 5000);
    });
    await welcomePromise; // consume the hub/welcome
    return ws;
  }

  // ── Sync notification routing ────────────────────────────────────

  it('routes sync notifications without crashing the connection', async () => {
    const ws = await openModeConnect(`sync-open-${Date.now()}`);

    // Send a sync notification (matches isMapSyncMessage format).
    // The handler will warn about unknown resource, but should NOT crash.
    sendNotification(ws, 'x-openhive/memory.sync', {
      resource_id: 'res_nonexistent_123',
      agent_id: 'agent_test_001',
      commit_hash: 'abc123def456',
      timestamp: new Date().toISOString(),
    });

    // Verify the connection is still alive by doing a ping/pong
    const pongPromise = waitNotification(ws);
    sendNotification(ws, 'ping', {});
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    ws.close();
  });

  it('routes skill.sync notifications without crashing the connection', async () => {
    const ws = await openModeConnect(`skill-sync-open-${Date.now()}`);

    sendNotification(ws, 'x-openhive/skill.sync', {
      resource_id: 'res_skill_nonexistent',
      agent_id: 'agent_test_002',
      commit_hash: 'deadbeef1234',
      timestamp: new Date().toISOString(),
    });

    const pongPromise = waitNotification(ws);
    sendNotification(ws, 'ping', {});
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    ws.close();
  });

  it('routes trajectory/checkpoint notifications without crashing the connection', async () => {
    const ws = await openModeConnect(`traj-sync-open-${Date.now()}`);

    sendNotification(ws, 'trajectory/checkpoint', {
      resource_id: 'res_traj_nonexistent',
      agent_id: 'agent_test_003',
      commit_hash: 'cafebabe5678',
      timestamp: new Date().toISOString(),
      checkpoint: { id: 'ckpt_1', agent: 'test-agent' },
    });

    const pongPromise = waitNotification(ws);
    sendNotification(ws, 'ping', {});
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    ws.close();
  });

  // ── MAP scope task message routing ────────────────────────────

  it('routes MAP scope task messages without crashing the connection', async () => {
    const ws = await openModeConnect(`task-open-${Date.now()}`);

    // Send a MAP scope task message (isMapTaskEvent format)
    ws.send(JSON.stringify({
      id: `msg-${Date.now()}`,
      from: 'swarm-test',
      to: { scope: 'swarm:test' },
      timestamp: new Date().toISOString(),
      payload: { type: 'task.created', task: { id: 't-1', title: 'Test task', status: 'open' } },
    }));

    // Verify the connection is still alive
    const pongPromise = waitNotification(ws);
    sendNotification(ws, 'ping', {});
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    ws.close();
  });

  // ── Ping/pong in open mode ───────────────────────────────────────

  it('handles ping/pong in open mode (interceptor active immediately)', async () => {
    const ws = await openModeConnect(`ping-open-${Date.now()}`);

    const pongPromise = waitNotification(ws);
    sendNotification(ws, 'ping', {});
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    // Send a second ping to verify repeated pings work
    const pong2Promise = waitNotification(ws);
    sendNotification(ws, 'ping', {});
    const pong2 = await pong2Promise;
    expect(pong2.method).toBe('pong');

    ws.close();
  });

});

// ============================================================================
// Verified Mode: Notification and Request Routing
// ============================================================================

describe('E2E Routing: Verified Mode — notification and request routing', () => {
  const TEST_ROOT = testRoot('map-e2e-routing-verified');
  const TEST_DB = testDbPath(TEST_ROOT, 'routing-verified.db');
  const PORT = 19681;
  let app: FastifyInstance;
  let apiKey: string;
  let swarmToken: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB);

    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));

    const result = await agentsDAL.createAgent({ name: 'routing-verified-agent' });
    apiKey = result.apiKey;

    const { serialized } = createSwarmToken('routing-swarm-001', { scopes: ['map:*'] });
    swarmToken = serialized;

    const config = ConfigSchema.parse({
      port: PORT, host: '127.0.0.1', database: TEST_DB,
      instance: { name: 'Routing Verified Test' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      cors: { enabled: false },
      mapHub: { enabled: true, trustModel: 'verified' },
    });

    app = Fastify({ logger: false });
    app.decorateRequest('agent', null);
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.listen({ port: PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    stopMapWebSocket();
    await new Promise((r) => setTimeout(r, 100));
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    _resetTokenService();
  });

  /** Complete verified auth + register and return a fully set-up WebSocket. */
  async function verifiedConnectAndRegister(): Promise<WebSocket> {
    const ws = await openWs(`ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`);

    // map/connect
    const connectResp = await rpc(ws, 'map/connect', {
      protocolVersion: 1,
      participantType: 'agent',
      name: `routing-swarm-${Date.now()}`,
    });
    expect(connectResp.result).toBeDefined();

    // map/authenticate
    const authResp = await rpc(ws, 'map/authenticate', {
      method: connectResp.result.authRequired.methods[0],
      credential: swarmToken,
    });
    expect(authResp.result.success).toBe(true);

    // map/agents/register — this sets up the notification interceptor
    const regResp = await rpc(ws, 'map/agents/register', {
      name: `routing-agent-${Date.now()}`,
      role: 'worker',
    });
    expect(regResp.result.agent).toBeDefined();

    // Wait for interceptor setup
    await new Promise((r) => setTimeout(r, 150));

    return ws;
  }

  // ── Mail request routing ─────────────────────────────────────────

  it('routes mail requests — returns error proving handler was reached', async () => {
    const ws = await verifiedConnectAndRegister();

    // Mail requests with `id` go through MAPServer. Since mail/* methods are
    // NOT registered as additionalHandlers, MAPServer returns method-not-found.
    // This proves the request reached MAPServer and was processed.
    const resp = await rpc(ws, 'mail/conversations/list', {});

    expect(resp.jsonrpc).toBe('2.0');
    // We expect an error (method not found in MAPServer, or mail not initialized)
    // Either way, routing worked — we got a response, not a timeout.
    expect(resp.error).toBeDefined();

    ws.close();
  });

  // ── Sync notification in verified mode ───────────────────────────

  it('routes sync notifications after auth+register without crashing', async () => {
    const ws = await verifiedConnectAndRegister();

    // Send a sync notification (no id) — handled by notification interceptor
    sendNotification(ws, 'x-openhive/memory.sync', {
      resource_id: 'res_verified_sync_test',
      agent_id: 'agent_verified_001',
      commit_hash: 'aabbccdd1122',
      timestamp: new Date().toISOString(),
    });

    // Verify connection is still alive
    const pongPromise = waitNotification(ws);
    sendNotification(ws, 'ping', {});
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    ws.close();
  });

  it('routes MAP scope task messages after auth+register without crashing', async () => {
    const ws = await verifiedConnectAndRegister();

    ws.send(JSON.stringify({
      id: `msg-${Date.now()}`,
      from: 'swarm-verified',
      to: { scope: 'swarm:test' },
      timestamp: new Date().toISOString(),
      payload: { type: 'task.status', taskId: 't-1', previous: 'open', current: 'in_progress' },
    }));

    const pongPromise = waitNotification(ws);
    sendNotification(ws, 'ping', {});
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    ws.close();
  });

  // ── Mail notification routing ────────────────────────────────────

  it('routes mail notifications (no id) without crashing', async () => {
    const ws = await verifiedConnectAndRegister();

    // Mail notifications go through the notification interceptor.
    // getMailJsonRpc() will throw "Mail module not initialized" but the
    // interceptor catches the error. Connection should survive.
    sendNotification(ws, 'mail/conversations/create', {
      participants: ['agent-a', 'agent-b'],
      subject: 'Test conversation',
    });

    const pongPromise = waitNotification(ws);
    sendNotification(ws, 'ping', {});
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    ws.close();
  });

  // ── Ping as request (with id) routes through additionalHandlers ──

  it('routes ping as a request (with id) through MAPServer', async () => {
    const ws = await verifiedConnectAndRegister();

    // Ping with `id` goes through MAPServer's additionalHandlers (not interceptor)
    const resp = await rpc(ws, 'ping', {});

    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.result).toBeDefined();
    expect(resp.result.pong).toBe(true);

    ws.close();
  });
});
