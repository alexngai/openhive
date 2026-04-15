/**
 * Tests for Cascade REST routes.
 *
 * Covers:
 * - GET /cascade/streams with filters (swarm, status, task_ref)
 * - GET /cascade/streams/:id returns stream + stats
 * - GET /cascade/streams/:id/changes paginated
 * - GET /cascade/streams/:id/conflicts
 * - GET /cascade/tasks/:resourceId/:nodeId/commits (changelog precursor)
 * - GET /cascade/conflicts triage endpoint
 * - 404 for unknown stream ids
 * - Auth required on all routes
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { cascadeRoutes } from '../../api/routes/cascade.js';
import { handleCascadeRequest, CASCADE_METHODS } from '../../map/cascade-handler.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_ROOT = testRoot('cascade-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'cascade-routes.db');

async function createTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(cascadeRoutes);
    },
    { prefix: '/api/v1' }
  );
  return app;
}

describe('Cascade REST Routes', () => {
  let app: FastifyInstance;
  let apiKey: string;
  const swarmId = 'swarm-routes-test';
  const agentId = 'agent-routes-test';

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { apiKey: key } = await agentsDAL.createAgent({
      name: 'cascade-routes-test',
      description: 'Agent for cascade routes tests',
    });
    apiKey = key;
    app = await createTestApp();

    // Seed projections by running handlers directly.
    const ctx = { swarmId, agentId };
    const taskRef = { resource_id: 'res-routes', node_id: 'task-routes' };

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      {
        stream_id: 'route-s1',
        name: 'route feat',
        agent_id: 'worker-r',
        base_commit: 'base',
        metadata: { task_ref: taskRef },
      },
      ctx
    );
    handleCascadeRequest(
      CASCADE_METHODS.STREAM_COMMITTED,
      {
        stream_id: 'route-s1',
        commit_hash: 'rc1',
        change_id: 'chg-r1',
        agent_id: 'worker-r',
        message_summary: 'first',
        files_touched: ['a.ts'],
        parent_commit: 'base',
        metadata: { task_ref: taskRef },
      },
      ctx
    );
    handleCascadeRequest(
      CASCADE_METHODS.STREAM_COMMITTED,
      {
        stream_id: 'route-s1',
        commit_hash: 'rc2',
        change_id: 'chg-r2',
        agent_id: 'worker-r',
        message_summary: 'second',
        files_touched: ['b.ts', 'a.ts'],
        parent_commit: 'rc1',
        metadata: { task_ref: taskRef },
      },
      ctx
    );
    handleCascadeRequest(
      CASCADE_METHODS.STREAM_CONFLICTED,
      {
        stream_id: 'route-s1',
        conflict_id: 'cf-routes',
        conflicted_files: ['a.ts'],
        agent_id: 'worker-r',
        source: 'sync',
      },
      ctx
    );

    // Second stream on a different swarm to test filtering.
    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      {
        stream_id: 'route-s2',
        name: 'other feat',
        agent_id: 'worker-q',
      },
      { swarmId: 'other-swarm', agentId: 'other-agent' }
    );
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('auth', () => {
    it('returns 401 without a bearer token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/cascade/streams' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /cascade/streams', () => {
    it('lists streams with total count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/streams',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('filters by source_swarm_id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cascade/streams?source_swarm_id=${swarmId}`,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.every((s: { source_swarm_id: string }) => s.source_swarm_id === swarmId)).toBe(
        true
      );
    });

    it('filters by task_resource_id + task_node_id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/streams?task_resource_id=res-routes&task_node_id=task-routes',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].stream_id).toBe('route-s1');
    });
  });

  describe('GET /cascade/streams/:id', () => {
    it('returns the stream row with stats', async () => {
      // First find the stream row id
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/cascade/streams?source_swarm_id=${swarmId}`,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const [firstStream] = list.json().data;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cascade/streams/${firstStream.id}`,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(firstStream.id);
      expect(body.stats).toBeDefined();
      expect(body.stats.total_commits).toBe(2);
      expect(body.stats.open_conflicts).toBe(1);
    });

    it('returns 404 for unknown stream id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/streams/does-not-exist',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /cascade/streams/:id/changes', () => {
    it('returns changes in order', async () => {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/cascade/streams?source_swarm_id=${swarmId}`,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const [firstStream] = list.json().data;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cascade/streams/${firstStream.id}/changes`,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].commit_hash).toBe('rc1');
      expect(body.data[1].commit_hash).toBe('rc2');
    });
  });

  describe('GET /cascade/streams/:id/conflicts', () => {
    it('returns conflicts for the stream', async () => {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/cascade/streams?source_swarm_id=${swarmId}`,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const [firstStream] = list.json().data;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cascade/streams/${firstStream.id}/conflicts`,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].conflict_id).toBe('cf-routes');
      expect(body.data[0].conflicted_files).toEqual(['a.ts']);
    });
  });

  describe('GET /cascade/tasks/:resourceId/:nodeId/commits', () => {
    it('returns commit range bound to a task', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/tasks/res-routes/task-routes/commits',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      const [range] = body.data;
      expect(range.stream_id).toBe('route-s1');
      expect(range.first_commit).toBe('rc1');
      expect(range.last_commit).toBe('rc2');
      expect(range.files_union.sort()).toEqual(['a.ts', 'b.ts']);
      expect(range.change_ids).toEqual(['chg-r1', 'chg-r2']);
    });

    it('returns empty array for unknown task', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/tasks/nope/nope/commits',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
    });
  });

  describe('GET /cascade/tasks/:resourceId/:nodeId/changelog', () => {
    it('returns structured + markdown by default', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/tasks/res-routes/task-routes/changelog',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toBeDefined();
      expect(body.data.has_work).toBe(true);
      expect(body.data.totals.commits).toBeGreaterThan(0);
      expect(body.markdown).toBeDefined();
      expect(typeof body.markdown).toBe('string');
      expect(body.markdown).toContain('## Commits');
    });

    it('returns raw markdown when format=markdown', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/tasks/res-routes/task-routes/changelog?format=markdown&title=My+Task',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/markdown');
      expect(res.body).toContain('# My Task');
      expect(res.body).toContain('## Commits');
    });

    it('returns json-only without markdown when format=json', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/tasks/res-routes/task-routes/changelog?format=json',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toBeDefined();
      expect(body.markdown).toBeUndefined();
    });

    it('returns has_work=false for unknown tasks (not 404)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/tasks/nope/nope/changelog?format=json',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.has_work).toBe(false);
      expect(body.data.commits).toEqual([]);
    });

    it('rejects invalid format with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/tasks/res-routes/task-routes/changelog?format=xml',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /cascade/conflicts', () => {
    it('returns open conflicts (default status=pending)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cascade/conflicts',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].status).toBe('pending');
    });

    it('filters by source_swarm_id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cascade/conflicts?source_swarm_id=${swarmId}`,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });
  });
});
