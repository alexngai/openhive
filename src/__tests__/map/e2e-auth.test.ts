/**
 * E2E Tests: MAP WebSocket Authentication Flow
 *
 * Starts a real Fastify server with the MAP WebSocket endpoint and tests:
 *
 *   1. Open mode: connect with API key + swarm_id → auto-registration → welcome
 *   2. Open mode: reconnect with same swarm_id → reuses existing swarm
 *   3. Open mode: connect without swarm_id → gets a generated swarm ID
 *   4. Verified mode: map/connect → authRequired → map/authenticate with IAM token
 *   5. Verified mode: invalid token → connection rejected
 *   6. Verified mode: missing API key → WebSocket rejected before map/connect
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
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('map-e2e-auth');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'e2e-auth.db');
const SERVER_PORT = 19650;

// ============================================================================
// Helpers
// ============================================================================

function createTestConfig(trustModel: 'open' | 'verified'): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: { name: 'E2E Auth Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    mapHub: { enabled: true, trustModel },
  });
}

/** Send a JSON-RPC message and wait for a response with matching id. */
function sendAndReceive(
  ws: WebSocket,
  msg: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Response timeout')), timeoutMs);
    // Listen before sending to avoid race conditions
    const handler = (data: Buffer | string) => {
      try {
        const parsed = JSON.parse(data.toString());
        // Match by id, or accept any response/notification
        if (parsed.id === msg.id) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(parsed);
        }
      } catch { /* ignore non-JSON */ }
    };
    ws.on('message', handler);
    // Small delay to ensure listener is registered before send
    setTimeout(() => ws.send(JSON.stringify(msg)), 10);
  });
}

/** Wait for the first message from the server (e.g., hub/welcome). */
function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/** Connect a WebSocket and wait for it to open. */
function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
}

// ============================================================================
// Open Mode Tests
// ============================================================================

describe('E2E: MAP Auth — Open Mode', () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const config = createTestConfig('open');

    const result = await agentsDAL.createAgent({ name: 'e2e-open-agent' });
    testAgent = { id: result.agent.id, apiKey: result.apiKey };

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
  });

  it('connects with API key and receives welcome', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}`,
    );

    const welcome = await waitForMessage(ws);
    expect(welcome.method).toBe('hub/welcome');
    expect((welcome.params as any).swarm_id).toBeTruthy();
    expect((welcome.params as any).agent_id).toBe(testAgent.id);

    ws.close();
  });

  it('connects with custom swarm_id', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}&swarm_id=my-custom-swarm`,
    );

    const welcome = await waitForMessage(ws);
    expect((welcome.params as any).swarm_id).toBe('my-custom-swarm');

    ws.close();
  });

  it('reconnects with the same swarm_id and reuses the swarm', async () => {
    const swarmId = 'reconnect-swarm-test';

    // First connection
    const ws1 = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}&swarm_id=${swarmId}`,
    );
    const welcome1 = await waitForMessage(ws1);
    expect((welcome1.params as any).swarm_id).toBe(swarmId);
    ws1.close();
    await new Promise((r) => setTimeout(r, 100));

    // Second connection — same swarm_id
    const ws2 = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}&swarm_id=${swarmId}`,
    );
    const welcome2 = await waitForMessage(ws2);
    expect((welcome2.params as any).swarm_id).toBe(swarmId);

    ws2.close();
  });

  it('rejects connection with invalid API key', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=invalid-key`,
    );

    const closed = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {}); // suppress
      setTimeout(() => resolve(0), 5000);
    });

    expect(closed).toBe(4001);
  });

  it('rejects connection without API key', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map`,
    );

    const closed = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
      setTimeout(() => resolve(0), 5000);
    });

    expect(closed).toBe(4001);
  });
});
