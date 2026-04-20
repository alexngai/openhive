/**
 * E2E tests for WebSocket fan-out on headless-mode admin routes.
 *
 * Proves the dispatch-cancel flow end-to-end without mocking the realtime
 * module:
 *   1. A WS client connects to /ws, authenticates with an agent API key,
 *      and subscribes to the `map:dispatches` channel.
 *   2. An operator cancels a dispatch via `POST /dispatches/:id/cancel`
 *      using ONLY `X-Admin-Key` (no Bearer token) — exercising the
 *      `authOrAdminKey` middleware change.
 *   3. The WS client receives the `dispatch.cancelled` event with the
 *      expected shape.
 *
 * Complements headless-mode-e2e.test.ts, which mocks `broadcastToChannel`
 * and therefore can't see that the real channel fan-out works when the
 * cancel request comes in without an authenticated agent on the request.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../db/index.js';
import * as agentsDAL from '../db/dal/agents.js';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { dispatchesRoutes } from '../api/routes/dispatches.js';
import { setupWebSocket, stopHeartbeat } from '../realtime/index.js';
import { ConfigSchema, type Config } from '../config.js';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';

const TEST_ROOT = testRoot('headless-ws-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'headless-ws.db');
const ADMIN_KEY = 'ws-e2e-admin-key';

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'WS E2E Hub', description: 'WS E2E test' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
  });
}

/** Connect a WS client and wait for the welcome message. */
function connectWS(baseUrl: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = token
      ? `${baseUrl.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`
      : `${baseUrl.replace('http', 'ws')}/ws`;

    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS connection timeout'));
    }, 5000);

    ws.once('message', () => {
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

interface ParsedWSEvent {
  type: string;
  channel?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

/** Subscribe to channels and wait for the subscription ack. */
function subscribe(ws: WebSocket, channels: string[]): Promise<ParsedWSEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Subscribe ack timeout')), 5000);

    const handler = (data: Buffer | string) => {
      const msg: ParsedWSEvent = JSON.parse(data.toString());
      if (msg.data && 'subscribed' in msg.data) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'subscribe', channels }));
  });
}

/** Wait for a specific event type; resolves null on timeout. */
function waitForEvent(
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

describe('Headless WS E2E', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let agent: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent: a, apiKey } = await agentsDAL.createAgent({
      name: 'ws-e2e-subscriber',
      description: 'WS client agent',
    });
    agent = { id: a.id, apiKey };

    const config = makeConfig();
    app = Fastify({ logger: false });
    app.decorateRequest('agent');

    // Register the real WebSocket plugin + handlers (no mocks).
    await app.register(websocket);
    setupWebSocket(app);

    await app.register(
      async (api) => {
        await api.register(dispatchesRoutes, { config });
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind ephemeral port');
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    stopHeartbeat();
    await app?.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('delivers dispatch.cancelled to map:dispatches subscribers when cancelled via X-Admin-Key', async () => {
    // Seed a running dispatch that can be cancelled
    const created = dispatchesDAL.createDispatch({
      spec_id: 'ws-spec',
      spec_resource_id: 'ws-resource',
      spec_captured_at: new Date().toISOString(),
      target_swarm_id: 'ws-swarm',
      initiator_type: 'user',
      initiator_id: agent.id,
    });

    // Connect WS, subscribe to map:dispatches
    const ws = await connectWS(baseUrl, agent.apiKey);
    try {
      await subscribe(ws, ['map:dispatches']);

      // Start listening BEFORE triggering the cancel so we don't race
      const eventPromise = waitForEvent(ws, 'dispatch.cancelled', 5000);

      // Cancel using ONLY the admin key — no Bearer token.
      // This is the path an operator CLI would take.
      const res = await fetch(`${baseUrl}/api/v1/dispatches/${created.id}/cancel`, {
        method: 'POST',
        headers: { 'X-Admin-Key': ADMIN_KEY },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { dispatch: { id: string; status: string } };
      expect(body.dispatch.status).toBe('cancelled');

      // The WS client should now see the broadcast
      const event = await eventPromise;
      expect(event).not.toBeNull();
      expect(event!.type).toBe('dispatch.cancelled');
      expect(event!.channel).toBe('map:dispatches');

      const data = event!.data as {
        dispatch: { id: string; status: string };
        target_swarm_id: string;
        cancelled_by: { type: string; id: string };
      };
      expect(data.dispatch.id).toBe(created.id);
      expect(data.dispatch.status).toBe('cancelled');
      expect(data.target_swarm_id).toBe('ws-swarm');

      // When admin key is used, cancelled_by should identify the operator,
      // not an agent — proving the request.agent-nil path wires through.
      expect(data.cancelled_by.type).toBe('operator');
      expect(data.cancelled_by.id).toBe('admin-key');
    } finally {
      ws.close();
      // Drain any lingering in-flight messages so close completes cleanly
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('does NOT deliver dispatch.cancelled to clients who did not subscribe', async () => {
    const created = dispatchesDAL.createDispatch({
      spec_id: 'ws-spec-2',
      spec_resource_id: 'ws-resource-2',
      spec_captured_at: new Date().toISOString(),
      target_swarm_id: 'ws-swarm-2',
      initiator_type: 'user',
      initiator_id: agent.id,
    });

    // Connect but do NOT subscribe to map:dispatches
    const ws = await connectWS(baseUrl, agent.apiKey);
    try {
      const eventPromise = waitForEvent(ws, 'dispatch.cancelled', 500);

      const res = await fetch(`${baseUrl}/api/v1/dispatches/${created.id}/cancel`, {
        method: 'POST',
        headers: { 'X-Admin-Key': ADMIN_KEY },
      });
      expect(res.status).toBe(200);

      const event = await eventPromise;
      expect(event).toBeNull();
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('delivers broadcast when cancelled via agent Bearer token (regression check)', async () => {
    const created = dispatchesDAL.createDispatch({
      spec_id: 'ws-spec-3',
      spec_resource_id: 'ws-resource-3',
      spec_captured_at: new Date().toISOString(),
      target_swarm_id: 'ws-swarm-3',
      initiator_type: 'user',
      initiator_id: agent.id,
    });

    const ws = await connectWS(baseUrl, agent.apiKey);
    try {
      await subscribe(ws, ['map:dispatches']);
      const eventPromise = waitForEvent(ws, 'dispatch.cancelled', 5000);

      // Cancel via Bearer instead of admin key — verify that path still works
      // (would be flagged if my authOrAdminKey change accidentally blocked it)
      const res = await fetch(`${baseUrl}/api/v1/dispatches/${created.id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.status).toBe(200);

      const event = await eventPromise;
      expect(event).not.toBeNull();
      expect(event!.type).toBe('dispatch.cancelled');
      const data = event!.data as { cancelled_by: { type: string; id: string } };
      // When a real agent is authenticated, cancelled_by.type should be 'user'
      // and reflect that agent's id — NOT the admin-key sentinel.
      expect(data.cancelled_by.type).toBe('user');
      expect(data.cancelled_by.id).toBe(agent.id);
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
