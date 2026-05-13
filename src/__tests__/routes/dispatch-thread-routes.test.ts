/**
 * Route-level tests for dispatch coordination thread endpoints:
 *   - POST /dispatches/:id/thread/turns
 *   - GET  /dispatches/:id/thread/presence
 *
 * Uses real SQLite + real agent-inbox + mocked MAP transport / WS broadcast.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted so they're available in vi.mock factories)
// ---------------------------------------------------------------------------

const { broadcastSpy, mockGetInbound, mockGetInboundStale } = vi.hoisted(() => ({
  broadcastSpy: vi.fn(),
  mockGetInbound: vi.fn(),
  mockGetInboundStale: vi.fn(),
}));

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, event: unknown) => broadcastSpy(channel, event),
  broadcast: vi.fn(),
}));

vi.mock('../../map/connection-registry.js', () => ({
  getInbound: (...args: unknown[]) => mockGetInbound(...args),
  getInboundIncludingStale: (...args: unknown[]) => mockGetInboundStale(...args),
}));

vi.mock('../../map/sync-listener.js', () => ({
  sendToSwarm: vi.fn(),
}));

vi.mock('../../map/service.js', () => ({
  mapHubEvents: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as dispatches from '../../db/dal/dispatches.js';
import { dispatchesRoutes } from '../../api/routes/dispatches.js';
import { initMail, getMailStorage } from '../../mail/index.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const TEST_ROOT = testRoot('dispatch-thread-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'dispatch-thread-routes.db');

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function makeApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(dispatchesRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('Dispatch thread routes', () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    await initMail();
    app = await makeApp(makeConfig());
    const { agent: a, apiKey } = await agentsDAL.createAgent({
      name: 'thread-route-test-agent',
    });
    agent = { id: a.id, apiKey };
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM dispatches').run();
    broadcastSpy.mockClear();
    mockGetInbound.mockReset();
    mockGetInboundStale.mockReset();
  });

  function seedDispatch(overrides?: Partial<Parameters<typeof dispatches.createDispatch>[0]>) {
    return dispatches.createDispatch({
      spec_resource_id: 'res_t',
      spec_id: 'spec-t',
      target_swarm_id: 'swarm-t',
      initiator_type: 'user',
      initiator_id: agent.id,
      ...overrides,
    });
  }

  function authHeaders() {
    return { Authorization: `Bearer ${agent.apiKey}` };
  }

  // =========================================================================
  // POST /dispatches/:id/thread/turns
  // =========================================================================

  describe('POST /dispatches/:id/thread/turns', () => {
    it('requires authentication', async () => {
      const d = seedDispatch();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        payload: { content: 'hello' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 for nonexistent dispatch', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/dispatches/nonexistent/thread/turns',
        headers: authHeaders(),
        payload: { content: 'hello' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 for cancelled dispatch', async () => {
      const d = seedDispatch();
      dispatches.cancelDispatch(d.id);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: 'hello' },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toContain('cancelled');
    });

    it('returns 400 for empty content', async () => {
      const d = seedDispatch();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for whitespace-only content', async () => {
      const d = seedDispatch();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: '   ' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for missing content field', async () => {
      const d = seedDispatch();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates conversation lazily and posts turn', async () => {
      const d = seedDispatch();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: 'What is the status?' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.conversation_id).toBeDefined();
      expect(body.dispatch_id).toBe(d.id);

      // Verify turn was stored
      const storage = getMailStorage();
      const turns = storage.getTurns(body.conversation_id);
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe('What is the status?');
    });

    it('returns same conversation_id on second call (idempotent)', async () => {
      const d = seedDispatch();

      const res1 = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: 'First message' },
      });
      const res2 = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: 'Second message' },
      });

      const body1 = JSON.parse(res1.body);
      const body2 = JSON.parse(res2.body);
      expect(body2.conversation_id).toBe(body1.conversation_id);

      // Two turns in same conversation
      const storage = getMailStorage();
      const turns = storage.getTurns(body1.conversation_id);
      expect(turns).toHaveLength(2);
    });

    it('defaults importance to high when not specified', async () => {
      const d = seedDispatch();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: 'Check this' },
      });

      const body = JSON.parse(res.body);
      const storage = getMailStorage();
      const turns = storage.getTurns(body.conversation_id);
      expect(turns[0].importance).toBe('high');
    });

    it('accepts valid importance values', async () => {
      const d = seedDispatch();

      for (const importance of ['low', 'normal', 'high', 'urgent']) {
        await app.inject({
          method: 'POST',
          url: `/api/v1/dispatches/${d.id}/thread/turns`,
          headers: authHeaders(),
          payload: { content: `msg-${importance}`, importance },
        });
      }

      // Find the conversation_id from dispatch
      const updated = dispatches.findDispatchById(d.id)!;
      const storage = getMailStorage();
      const turns = storage.getTurns(updated.conversation_id!);
      expect(turns).toHaveLength(4);
      expect(turns[0].importance).toBe('low');
      expect(turns[1].importance).toBe('normal');
      expect(turns[2].importance).toBe('high');
      expect(turns[3].importance).toBe('urgent');
    });

    it('falls back to high for invalid importance', async () => {
      const d = seedDispatch();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: 'test', importance: 'CRITICAL' },
      });

      const body = JSON.parse(res.body);
      const storage = getMailStorage();
      const turns = storage.getTurns(body.conversation_id);
      expect(turns[0].importance).toBe('high');
    });

    it('broadcasts dispatch.thread.turn on map:dispatches', async () => {
      const d = seedDispatch();

      await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: 'Broadcast test' },
      });

      const dispatchBroadcasts = broadcastSpy.mock.calls.filter(
        (args: unknown[]) => {
          const [channel, event] = args as [string, { type: string }];
          return channel === 'map:dispatches' && event.type === 'dispatch.thread.turn';
        },
      );
      expect(dispatchBroadcasts.length).toBeGreaterThanOrEqual(1);

      const [, event] = dispatchBroadcasts[0] as [string, { data: { dispatch_id: string } }];
      expect(event.data.dispatch_id).toBe(d.id);
    });

    it('trims content whitespace', async () => {
      const d = seedDispatch();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: '  hello world  ' },
      });

      const body = JSON.parse(res.body);
      const storage = getMailStorage();
      const turns = storage.getTurns(body.conversation_id);
      expect(turns[0].content).toBe('hello world');
    });
  });

  // =========================================================================
  // GET /dispatches/:id/thread/presence
  // =========================================================================

  describe('GET /dispatches/:id/thread/presence', () => {
    it('requires authentication', async () => {
      const d = seedDispatch();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/dispatches/${d.id}/thread/presence`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 for nonexistent dispatch', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches/nonexistent/thread/presence',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns empty participants when no conversation exists', async () => {
      const d = seedDispatch();

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/dispatches/${d.id}/thread/presence`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dispatch_id).toBe(d.id);
      expect(body.conversation_id).toBeNull();
      expect(body.participants).toEqual([]);
    });

    it('returns participants with online presence when swarm is connected', async () => {
      const d = seedDispatch();

      // Create a conversation first via thread/turns
      await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: 'seed conversation' },
      });

      // Mock swarm as connected
      mockGetInbound.mockReturnValue({ swarmId: 'swarm-t' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/dispatches/${d.id}/thread/presence`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.conversation_id).toBeDefined();
      // Participants should have presence enriched
      for (const p of body.participants) {
        expect(p.presence).toBe('online');
      }
    });

    it('returns stale presence when swarm has stale connection', async () => {
      const d = seedDispatch();

      await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: 'seed' },
      });

      // No active connection, but stale exists
      mockGetInbound.mockReturnValue(undefined);
      mockGetInboundStale.mockReturnValue({ swarmId: 'swarm-t', stale: true });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/dispatches/${d.id}/thread/presence`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      for (const p of body.participants) {
        expect(p.presence).toBe('stale');
      }
    });

    it('returns offline presence when no connection exists', async () => {
      const d = seedDispatch();

      await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/thread/turns`,
        headers: authHeaders(),
        payload: { content: 'seed' },
      });

      mockGetInbound.mockReturnValue(undefined);
      mockGetInboundStale.mockReturnValue(undefined);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/dispatches/${d.id}/thread/presence`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      for (const p of body.participants) {
        expect(p.presence).toBe('offline');
      }
    });
  });
});
