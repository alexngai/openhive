/**
 * E2E Tests: MAP Verified Mode Authentication
 *
 * Starts a real Fastify server in verified trust mode and tests the full
 * MAP spec auth negotiation: map/connect → authRequired → map/authenticate.
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

const TEST_ROOT = testRoot('map-e2e-verified');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'e2e-verified.db');
const SERVER_PORT = 19660;

/** Send a JSON-RPC message and wait for a response with matching id. */
function sendAndReceive(
  ws: WebSocket,
  msg: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Response timeout')), timeoutMs);
    const handler = (data: Buffer | string) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === msg.id) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(parsed);
        }
      } catch { /* ignore */ }
    };
    ws.on('message', handler);
    setTimeout(() => ws.send(JSON.stringify(msg)), 10);
  });
}

/** Connect a WebSocket and wait for it to fully open + server handler setup. */
async function connectWs(url: string): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on('open', () => resolve(socket));
    socket.on('error', (err) => reject(err));
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
  // Small delay to ensure server-side async auth + ws.once('message') registration
  await new Promise((r) => setTimeout(r, 100));
  return ws;
}

describe('E2E: MAP Auth — Verified Mode', () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };
  let swarmToken: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));

    const config = ConfigSchema.parse({
      port: SERVER_PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'E2E Verified Test' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      cors: { enabled: false },
      mapHub: { enabled: true, trustModel: 'verified' },
    });

    const result = await agentsDAL.createAgent({ name: 'e2e-verified-agent' });
    testAgent = { id: result.agent.id, apiKey: result.apiKey };

    const { serialized } = createSwarmToken('e2e-test-swarm', { scopes: ['map:*'] });
    swarmToken = serialized;

    app = Fastify({ logger: false });
    app.decorateRequest('agent', null);
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    stopMapWebSocket();
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    _resetTokenService();
  });

  it('accepts connection without token in local auth mode (falls back to local agent)', async () => {
    // In local auth mode, the server falls back to the local agent when no token is provided.
    // The connection succeeds and proceeds to the verified mode map/connect flow.
    const ws = await connectWs(`ws://127.0.0.1:${SERVER_PORT}/ws/map`);

    // Should be able to send map/connect and get authRequired back
    const connectResponse = await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 1, method: 'map/connect',
      params: { protocolVersion: 1, participantType: 'agent' },
    });
    expect(connectResponse.result).toBeDefined();
    expect((connectResponse.result as any).authRequired).toBeDefined();

    ws.close();
  });

  it('completes full negotiation: map/connect → authRequired → map/authenticate', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}`,
    );

    // Step 1: Send map/connect — server should respond with authRequired
    const connectResponse = await sendAndReceive(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'map/connect',
      params: { protocolVersion: 1, participantType: 'agent', name: 'e2e-swarm' },
    });

    expect(connectResponse.result).toBeDefined();
    const connectResult = connectResponse.result as any;
    expect(connectResult.authRequired).toBeDefined();
    expect(connectResult.authRequired.methods).toContain('x-agent-iam');
    expect(connectResult.authRequired.required).toBe(true);

    // Step 2: Send map/authenticate with IAM token
    const authResponse = await sendAndReceive(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: 'map/authenticate',
      params: { method: 'x-agent-iam', credential: swarmToken },
    });

    expect(authResponse.result).toBeDefined();
    const authResult = authResponse.result as any;
    expect(authResult.success).toBe(true);
    expect(authResult.sessionId).toBeTruthy();
    // participantId is a MAPServer-generated ULID session ID, not the swarm's agent ID
    expect(authResult.participantId).toBeTruthy();
    // The swarm identity is in principal.id
    expect(authResult.principal.id).toBe('e2e-test-swarm');
    expect(authResult.principal.claims.scopes).toContain('map:*');

    ws.close();
  });

  it('accepts messages after successful auth and agent registration', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}`,
    );

    // Complete auth negotiation
    await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 1, method: 'map/connect', params: { protocolVersion: 1 },
    });
    await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 2, method: 'map/authenticate',
      params: { method: 'x-agent-iam', credential: swarmToken },
    });

    // Register an agent — this triggers the notification interceptor setup
    await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 3, method: 'map/agents/register',
      params: { name: 'ping-test-agent', role: 'worker' },
    });

    // Small delay to let the event handler set up the interceptor
    await new Promise((r) => setTimeout(r, 100));

    // Now send a ping notification — should get a pong notification back
    const pongPromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.method === 'pong') resolve(parsed);
      });
      setTimeout(() => resolve({ method: 'timeout' }), 3000);
    });

    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }));
    const pong = await pongPromise;
    expect(pong.method).toBe('pong');

    ws.close();
  });

  it('rejects invalid IAM token', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}`,
    );

    // map/connect
    await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 1, method: 'map/connect', params: { protocolVersion: 1 },
    });

    // map/authenticate with garbage — MAPServer returns an error response (not a close)
    const authResponse = await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 2, method: 'map/authenticate',
      params: { method: 'x-agent-iam', credential: 'not-a-valid-token' },
    });

    expect(authResponse.result).toBeDefined();
    const authResult = authResponse.result as any;
    expect(authResult.success).toBe(false);

    ws.close();
  });

  it('rejects unsupported auth method', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}`,
    );

    await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 1, method: 'map/connect', params: { protocolVersion: 1 },
    });

    // MAPServer returns an error response for unsupported auth methods (not a close)
    const authResponse = await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 2, method: 'map/authenticate',
      params: { method: 'bearer', credential: 'some-jwt' },
    });

    expect(authResponse.result).toBeDefined();
    const authResult = authResponse.result as any;
    expect(authResult.success).toBe(false);

    ws.close();
  });

  it('supports mid-session token refresh via map/authenticate', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}`,
    );

    // Complete initial auth negotiation
    await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 1, method: 'map/connect', params: { protocolVersion: 1 },
    });
    await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 2, method: 'map/authenticate',
      params: { method: 'x-agent-iam', credential: swarmToken },
    });

    // Now send a mid-session map/authenticate with a fresh token
    const { serialized: freshToken } = createSwarmToken('e2e-test-swarm', { scopes: ['map:*', 'map:observe:*'] });
    const refreshResponse = await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 10, method: 'map/authenticate',
      params: { method: 'x-agent-iam', credential: freshToken },
    });

    expect(refreshResponse.result).toBeDefined();
    const refreshResult = refreshResponse.result as any;
    expect(refreshResult.success).toBe(true);
    expect(refreshResult.principal.id).toBe('e2e-test-swarm');

    ws.close();
  });

  it('accepts ping as request after completing auth', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}`,
    );

    // Complete auth negotiation
    await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 1, method: 'map/connect', params: { protocolVersion: 1 },
    });
    await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 2, method: 'map/authenticate',
      params: { method: 'x-agent-iam', credential: swarmToken },
    });

    // MAPServer routes ping as a request to additionalHandlers
    const response = await sendAndReceive(ws, {
      jsonrpc: '2.0', id: 3, method: 'ping', params: {},
    });

    expect(response.result).toBeDefined();
    expect((response.result as any).pong).toBe(true);

    ws.close();
  });

  it('keeps connection open without map/connect (MAPServer does not enforce connect timeout)', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}`,
    );

    // MAPServer does not enforce a connect timeout — the connection stays open.
    // Verify the connection is still open after a short wait.
    await new Promise((r) => setTimeout(r, 500));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });
});
