/**
 * E2E Integration Test: Full MAP Auth Flow
 *
 * Tests the complete client-server integration as a MAP-compatible agent
 * would experience it, covering both open and verified trust models.
 *
 * This simulates a claude-code-swarm sidecar connecting to an OpenHive hub
 * using raw WebSocket + JSON-RPC 2.0, exercising the full protocol flow:
 *
 *   Open mode:   ?token=<key>&swarm_id=<id> → hub/welcome → ping/pong
 *   Verified:    ?token=<key> → map/connect → authRequired → map/authenticate → ping/pong
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

/** Wait for the next server-pushed notification (no id). */
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

/** Collect all messages for a duration. */
function collectMessages(ws: WebSocket, durationMs: number): Promise<any[]> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    const handler = (data: Buffer | string) => {
      try { messages.push(JSON.parse(data.toString())); } catch {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

// ============================================================================
// Open Mode Integration
// ============================================================================

describe('E2E Integration: Open Mode — full client flow', () => {
  const TEST_ROOT = testRoot('map-e2e-integ-open');
  const TEST_DB = testDbPath(TEST_ROOT, 'integ-open.db');
  const PORT = 19670;
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB);

    const result = await agentsDAL.createAgent({ name: 'integ-open-agent' });
    apiKey = result.apiKey;

    const config = ConfigSchema.parse({
      port: PORT, host: '127.0.0.1', database: TEST_DB,
      instance: { name: 'Integration Test' },
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
    await new Promise((r) => setTimeout(r, 100)); // let close handlers settle
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  /** Connect in open mode and capture the hub/welcome notification. */
  async function openModeConnect(swarmId: string): Promise<{ ws: WebSocket; welcome: any }> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`);
    const welcomePromise = waitNotification(ws, 5000);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Open timeout')), 5000);
    });
    const welcome = await welcomePromise;
    return { ws, welcome };
  }

  it('simulates a sidecar connecting with session ID as swarm identity', async () => {
    const sessionId = `session-${Date.now()}`;
    const { ws, welcome } = await openModeConnect(sessionId);
    expect(welcome.method).toBe('hub/welcome');
    expect(welcome.params.swarm_id).toBe(sessionId);

    // Verify bidirectional messaging works (ping → pong)
    const pongPromise = waitNotification(ws);
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }));
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    ws.close();
  });

  it('simulates reconnect: same swarm_id across two connections', async () => {
    const swarmId = `reconnect-${Date.now()}`;

    const { ws: ws1, welcome: w1 } = await openModeConnect(swarmId);
    expect(w1.params.swarm_id).toBe(swarmId);
    ws1.close();
    await new Promise((r) => setTimeout(r, 200));

    const { ws: ws2, welcome: w2 } = await openModeConnect(swarmId);
    expect(w2.params.swarm_id).toBe(swarmId);
    ws2.close();
  });

  it('simulates two concurrent swarms from same agent (different IDs)', async () => {
    const { ws: ws1, welcome: w1 } = await openModeConnect('swarm-a');
    const { ws: ws2, welcome: w2 } = await openModeConnect('swarm-b');

    expect(w1.params.swarm_id).toBe('swarm-a');
    expect(w2.params.swarm_id).toBe('swarm-b');

    // Both can ping independently
    const pong1Promise = waitNotification(ws1);
    const pong2Promise = waitNotification(ws2);
    ws1.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }));
    ws2.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }));

    expect((await pong1Promise).method).toBe('pong');
    expect((await pong2Promise).method).toBe('pong');

    ws1.close();
    ws2.close();
  });
});

// ============================================================================
// Verified Mode Integration
// ============================================================================

describe('E2E Integration: Verified Mode — full client flow', () => {
  const TEST_ROOT = testRoot('map-e2e-integ-verified');
  const TEST_DB = testDbPath(TEST_ROOT, 'integ-verified.db');
  const PORT = 19671;
  let app: FastifyInstance;
  let apiKey: string;
  let swarmToken: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB);

    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));

    const result = await agentsDAL.createAgent({ name: 'integ-verified-agent' });
    apiKey = result.apiKey;

    const { serialized } = createSwarmToken('integ-swarm-001', { scopes: ['map:*'] });
    swarmToken = serialized;

    const config = ConfigSchema.parse({
      port: PORT, host: '127.0.0.1', database: TEST_DB,
      instance: { name: 'Verified Integration Test' },
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
    await new Promise((r) => setTimeout(r, 100)); // let close handlers settle
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    _resetTokenService();
  });

  it('simulates a sidecar completing the full verified auth flow', async () => {
    // Step 1: Connect with API key (hub access)
    const ws = await openWs(`ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`);

    // Step 2: Send map/connect — no auth, let server tell us what it needs
    const connectResp = await rpc(ws, 'map/connect', {
      protocolVersion: 1,
      participantType: 'agent',
      name: 'integ-swarm-001',
    });

    expect(connectResp.result).toBeDefined();
    expect(connectResp.result.authRequired).toBeDefined();
    expect(connectResp.result.authRequired.required).toBe(true);
    const methods = connectResp.result.authRequired.methods;
    expect(methods.length).toBeGreaterThan(0);

    // Step 3: Respond with the server's preferred method + our credential
    const authResp = await rpc(ws, 'map/authenticate', {
      method: methods[0],  // Server tells us — we don't decide
      credential: swarmToken,
    });

    expect(authResp.result).toBeDefined();
    expect(authResp.result.success).toBe(true);
    // participantId is a MAPServer-generated ULID session ID
    expect(authResp.result.participantId).toBeTruthy();
    // The swarm identity is in principal.id
    expect(authResp.result.principal.id).toBe('integ-swarm-001');

    // Step 4: Register an agent (sets up the notification interceptor in verified mode)
    const regResp = await rpc(ws, 'map/agents/register', {
      name: 'integ-verify-agent',
      role: 'worker',
    });
    expect(regResp.result.agent).toBeDefined();

    // Small delay for event handler to set up interceptor
    await new Promise((r) => setTimeout(r, 100));

    // Step 5: Verify the connection is fully functional (ping notification → pong notification)
    const pongPromise = waitNotification(ws);
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }));
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    ws.close();
  });

  it('simulates two swarms with different tokens connecting concurrently', async () => {
    // Issue a second token for a different swarm identity
    const { serialized: token2 } = createSwarmToken('integ-swarm-002', { scopes: ['map:observe:*'] });

    // Swarm 1
    const ws1 = await openWs(`ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`);
    const c1 = await rpc(ws1, 'map/connect', { protocolVersion: 1, name: 'swarm-001' });
    const a1 = await rpc(ws1, 'map/authenticate', {
      method: c1.result.authRequired.methods[0],
      credential: swarmToken,
    });
    // participantId is a ULID session ID; identity is in principal.id
    expect(a1.result.participantId).toBeTruthy();
    expect(a1.result.principal.id).toBe('integ-swarm-001');

    // Swarm 2
    const ws2 = await openWs(`ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`);
    const c2 = await rpc(ws2, 'map/connect', { protocolVersion: 1, name: 'swarm-002' });
    const a2 = await rpc(ws2, 'map/authenticate', {
      method: c2.result.authRequired.methods[0],
      credential: token2,
    });
    expect(a2.result.participantId).toBeTruthy();
    expect(a2.result.principal.id).toBe('integ-swarm-002');

    // Register agents on both to activate notification interceptors
    await rpc(ws1, 'map/agents/register', { name: 'swarm1-agent', role: 'worker' });
    await rpc(ws2, 'map/agents/register', { name: 'swarm2-agent', role: 'worker' });
    await new Promise((r) => setTimeout(r, 100));

    // Both are independently functional (ping notification → pong notification)
    const p1 = waitNotification(ws1);
    const p2 = waitNotification(ws2);
    ws1.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }));
    ws2.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }));

    expect((await p1).method).toBe('pong');
    expect((await p2).method).toBe('pong');

    ws1.close();
    ws2.close();
  });

  it('simulates token delegation: parent issues child token, child connects', async () => {
    const { serialized: parentToken } = createSwarmToken('parent-swarm', {
      scopes: ['map:*'],
    });

    // Delegate a narrower token for a child agent
    const { delegateToken } = await import('../../map/token-service.js');
    const { serialized: childToken } = delegateToken(parentToken, {
      agentId: 'child-worker-001',
      scopes: ['map:observe:*', 'map:message:*'],
      ttlMinutes: 10,
    });

    // Child connects with the delegated token
    const ws = await openWs(`ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`);
    const conn = await rpc(ws, 'map/connect', { protocolVersion: 1, name: 'child-worker' });
    const auth = await rpc(ws, 'map/authenticate', {
      method: conn.result.authRequired.methods[0],
      credential: childToken,
    });

    expect(auth.result.success).toBe(true);
    // participantId is a ULID session ID; identity is in principal.id
    expect(auth.result.participantId).toBeTruthy();
    expect(auth.result.principal.id).toBe('child-worker-001');
    expect(auth.result.principal.claims.scopes).toContain('map:observe:*');
    expect(auth.result.principal.claims.scopes).toContain('map:message:*');
    expect(auth.result.principal.claims.delegationDepth).toBeGreaterThan(0);

    ws.close();
  });

  // Helper: complete verified auth and return connected ws
  async function verifiedConnect(token: string): Promise<WebSocket> {
    const ws = await openWs(`ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`);
    const c = await rpc(ws, 'map/connect', { protocolVersion: 1 });
    await rpc(ws, 'map/authenticate', {
      method: c.result.authRequired.methods[0],
      credential: token,
    });
    return ws;
  }

  // ── Issue 1: Disconnect responds before closing ────────────────────

  it('responds to map/disconnect with success and resumeToken', async () => {
    const ws = await verifiedConnect(swarmToken);

    // Send disconnect and expect a response
    const response = await rpc(ws, 'map/disconnect', {});
    expect(response.result).toBeDefined();
    expect(response.result.success).toBe(true);
    // MAPServer returns a resumeToken for session resumption
    expect(response.result.resumeToken).toBeTruthy();

    // MAPServer marks the session as disconnected but doesn't close the transport.
    // The client is responsible for closing the WebSocket.
    ws.close();
  });

  // ── Issue 4: Agent lifecycle (register, update, unregister) ────────

  it('handles agents/register and returns agent info', async () => {
    const ws = await verifiedConnect(swarmToken);

    const regResp = await rpc(ws, 'map/agents/register', {
      name: 'Worker One',
      role: 'executor',
    });

    expect(regResp.result).toBeDefined();
    // agent.id is a MAPServer-generated ULID, not a user-provided ID
    expect(regResp.result.agent.id).toBeTruthy();
    expect(regResp.result.agent.name).toBe('Worker One');
    expect(regResp.result.agent.role).toBe('executor');
    // MAPServer sets initial state to 'idle', not 'active'
    expect(regResp.result.agent.state).toBe('idle');

    ws.close();
  });

  it('handles agents/update to change agent state', async () => {
    const ws = await verifiedConnect(swarmToken);

    // Register first — get the server-assigned agent ID
    const regResp = await rpc(ws, 'map/agents/register', {
      name: 'State Agent',
      role: 'worker',
    });
    const agentId = regResp.result.agent.id;

    // Update state: idle → busy
    const updateResp = await rpc(ws, 'map/agents/update', {
      agentId,
      state: 'busy',
    });

    expect(updateResp.result).toBeDefined();
    expect(updateResp.result.agent.state).toBe('busy');

    // Update state: busy → idle
    const idleResp = await rpc(ws, 'map/agents/update', {
      agentId,
      state: 'idle',
    });
    expect(idleResp.result.agent.state).toBe('idle');

    ws.close();
  });

  it('rejects agents/update for unregistered agent', async () => {
    const ws = await verifiedConnect(swarmToken);

    const resp = await rpc(ws, 'map/agents/update', {
      agentId: 'ghost-agent',
      state: 'busy',
    });

    expect(resp.error).toBeDefined();
    // MAPServer's AgentRegistry throws "Agent not found: <id>"
    expect(resp.error.message).toContain('not found');

    ws.close();
  });

  it('handles agents/unregister', async () => {
    const ws = await verifiedConnect(swarmToken);

    // Register — get the server-assigned agent ID
    const regResp = await rpc(ws, 'map/agents/register', {
      name: 'Temp Agent',
      role: 'worker',
    });
    const agentId = regResp.result.agent.id;

    // Unregister
    const unregResp = await rpc(ws, 'map/agents/unregister', {
      agentId,
    });
    expect(unregResp.result).toBeDefined();
    expect(unregResp.result.success).toBe(true);

    // Updating after unregister should fail
    const updateResp = await rpc(ws, 'map/agents/update', {
      agentId,
      state: 'busy',
    });
    expect(updateResp.error).toBeDefined();

    ws.close();
  });

  // ── Issue 3: Revocation rejects connection ─────────────────────────

  it('rejects a revoked token during verified auth', async () => {
    const { serialized: revokableToken } = createSwarmToken('revoke-integ-swarm');

    // Revoke it
    const { revokeToken } = await import('../../map/token-service.js');
    revokeToken('revoke-integ-swarm');

    const ws = await openWs(`ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`);
    const c = await rpc(ws, 'map/connect', { protocolVersion: 1 });

    // MAPServer returns an error response for revoked tokens (not a close)
    const authResp = await rpc(ws, 'map/authenticate', {
      method: c.result.authRequired.methods[0],
      credential: revokableToken,
    });

    expect(authResp.result).toBeDefined();
    expect(authResp.result.success).toBe(false);

    ws.close();
  });
});
