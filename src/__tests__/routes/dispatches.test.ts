/**
 * Read-side tests for /dispatches routes (PR 1a). POST + cancel arrive in
 * later PRs and get their own coverage.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

const broadcastSpy = vi.fn();
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, event: unknown) => broadcastSpy(channel, event),
  broadcast: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as dispatches from '../../db/dal/dispatches.js';
import { dispatchesRoutes } from '../../api/routes/dispatches.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('dispatches-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'dispatches-routes.db');

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

describe('Dispatches routes', () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());
    const { agent: a, apiKey } = await agentsDAL.createAgent({
      name: 'dispatches-route-agent',
      description: 'route test',
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
  });

  describe('GET /dispatches', () => {
    it('requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/dispatches' });
      expect(res.statusCode).toBe(401);
    });

    it('returns empty list when none exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ data: [], total: 0, limit: 50, offset: 0 });
    });

    it('returns rows sorted by created_at desc', async () => {
      dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: agent.id,
      });
      // distinct timestamp
      await new Promise((r) => setTimeout(r, 1100));
      const newer = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-2', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: agent.id,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      const body = JSON.parse(res.body);
      expect(body.total).toBe(2);
      expect(body.data[0].id).toBe(newer.id);
    });

    it('filters by status, supporting comma-separated values', async () => {
      const queued = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: agent.id,
      });
      const running = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-2', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: agent.id,
      });
      dispatches.updateDispatchStatus(running.id, 'running');

      // single value
      const r1 = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches?status=queued',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      const b1 = JSON.parse(r1.body);
      expect(b1.total).toBe(1);
      expect(b1.data[0].id).toBe(queued.id);

      // comma-separated
      const r2 = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches?status=queued,running',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(JSON.parse(r2.body).total).toBe(2);
    });

    it('drops invalid status values silently', async () => {
      dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: agent.id,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches?status=bogus',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      // status filter ignored entirely → returns the queued dispatch
      expect(JSON.parse(res.body).total).toBe(1);
    });

    it('filters by target_swarm_id and spec_id', async () => {
      dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: agent.id,
      });
      dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-2', target_swarm_id: 'swarm_y',
        initiator_type: 'user', initiator_id: agent.id,
      });

      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches?target_swarm_id=swarm_y',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      const b = JSON.parse(r.body);
      expect(b.total).toBe(1);
      expect(b.data[0].target_swarm_id).toBe('swarm_y');
    });

    it('honors limit/offset', async () => {
      for (let i = 0; i < 5; i++) {
        dispatches.createDispatch({
          spec_resource_id: 'res_a', spec_id: `c-${i}`, target_swarm_id: 'swarm_x',
          initiator_type: 'user', initiator_id: agent.id,
        });
      }
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches?limit=2&offset=1',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      const b = JSON.parse(r.body);
      expect(b.total).toBe(5);
      expect(b.data).toHaveLength(2);
      expect(b.limit).toBe(2);
      expect(b.offset).toBe(1);
    });
  });

  describe('GET /dispatches/:id', () => {
    it('returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches/disp_unknown',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns the dispatch when found', async () => {
      const created = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: agent.id,
        spec_captured_at: '2026-04-15T20:00:00Z',
        prompt_override: 'extra context',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/dispatches/${created.id}`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dispatch.id).toBe(created.id);
      expect(body.dispatch.spec_captured_at).toBe('2026-04-15T20:00:00Z');
      expect(body.dispatch.prompt_override).toBe('extra context');
      expect(body.dispatch.session_ids).toEqual([]);
    });

    it('requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/dispatches/disp_anything' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ==========================================================================
  // POST /dispatches/:id/cancel  (PR 2)
  // ==========================================================================

  describe('POST /dispatches/:id/cancel', () => {
    it('marks the dispatch cancelled and broadcasts dispatch.cancelled', async () => {
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: agent.id,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/cancel`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dispatch.status).toBe('cancelled');

      expect(broadcastSpy).toHaveBeenCalledWith(
        'map:dispatches',
        expect.objectContaining({
          type: 'dispatch.cancelled',
          data: expect.objectContaining({
            cancelled_by: { type: 'user', id: agent.id },
          }),
        }),
      );
    });

    it('is idempotent on already-cancelled dispatches', async () => {
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: agent.id,
      });
      dispatches.cancelDispatch(d.id);
      broadcastSpy.mockClear();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${d.id}/cancel`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      // No re-broadcast on idempotent no-op
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('returns 409 for terminal dispatches (complete / failed)', async () => {
      const completed = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: agent.id,
      });
      dispatches.updateDispatchStatus(completed.id, 'complete', { summary: 'done' });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${completed.id}/cancel`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 404 for unknown dispatch', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/dispatches/disp_unknown/cancel',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('requires authentication', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/dispatches/anything/cancel' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ==========================================================================
  // POST /dispatches/:id/bootstrap — REMOVED
  // Bootstrap is now handled by the swarm-dispatch orchestrator (src/dispatch/setup.ts).
  // These tests verified the removed endpoint; kept as a comment for history.
});
