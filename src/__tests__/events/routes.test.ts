import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as eventsDAL from '../../db/dal/events.js';
import { eventsRoutes } from '../../api/routes/events.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock auth middleware to inject a test agent
vi.mock('../../api/middleware/auth.js', () => ({
  authMiddleware: async (request: any) => {
    request.agent = { id: 'agent_route_test', name: 'route-test-user' };
  },
  optionalAuthMiddleware: async (request: any) => {
    request.agent = { id: 'agent_route_test', name: 'route-test-user' };
  },
}));

const TEST_ROOT = testRoot('events-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'events-routes-test.db');

async function createTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent', null);

  await app.register(
    async (api) => {
      await api.register(eventsRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

describe('Events API Routes', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof import('better-sqlite3')>;
  let testAgentId: string;
  let testHiveId: string;

  beforeAll(async () => {
    db = initDatabase(TEST_DB_PATH);
    app = await createTestApp();

    // Seed required data
    testAgentId = 'agent_route_test';
    db.prepare(
      "INSERT OR IGNORE INTO agents (id, name, account_type) VALUES (?, 'route-test-user', 'human')",
    ).run(testAgentId);

    testHiveId = 'hive_route_test';
    db.prepare(
      "INSERT OR IGNORE INTO hives (id, name, owner_id, is_public) VALUES (?, 'route-test-hive', ?, 1)",
    ).run(testHiveId, testAgentId);

    // Create a swarm for subscription tests
    db.prepare(`
      INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, map_transport, status, owner_agent_id)
      VALUES ('swarm_route1', 'route-swarm', 'ws://localhost:9020', 'websocket', 'online', ?)
    `).run(testAgentId);
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ==========================================================================
  // Post Rules
  // ==========================================================================

  describe('Post Rules CRUD', () => {
    let createdRuleId: string;

    it('POST /events/post-rules — creates a post rule', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/events/post-rules',
        payload: {
          hive_id: testHiveId,
          source: 'github',
          event_types: ['push', 'pull_request.opened'],
          filters: { repos: ['org/repo'] },
          priority: 50,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toMatch(/^epr_/);
      expect(body.source).toBe('github');
      expect(body.event_types).toEqual(['push', 'pull_request.opened']);
      expect(body.filters).toEqual({ repos: ['org/repo'] });
      expect(body.created_by).toBe('api');
      createdRuleId = body.id;
    });

    it('POST /events/post-rules — rejects missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/events/post-rules',
        payload: { source: 'github' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('required');
    });

    it('GET /events/post-rules — lists all rules', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/events/post-rules',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /events/post-rules?hive_id= — filters by hive', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/events/post-rules?hive_id=${testHiveId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.every((r: any) => r.hive_id === testHiveId)).toBe(true);
    });

    it('PUT /events/post-rules/:id — updates a rule', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/events/post-rules/${createdRuleId}`,
        payload: {
          source: 'slack',
          priority: 200,
          enabled: false,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.source).toBe('slack');
      expect(body.priority).toBe(200);
      expect(body.enabled).toBe(false);
    });

    it('PUT /events/post-rules/:id — returns 404 for nonexistent rule', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/events/post-rules/epr_nonexistent',
        payload: { source: 'slack' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('DELETE /events/post-rules/:id — deletes a rule', async () => {
      // Create a rule to delete
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/events/post-rules',
        payload: {
          hive_id: testHiveId,
          source: 'github',
          event_types: ['issues.opened'],
        },
      });
      const toDelete = JSON.parse(createRes.body).id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/events/post-rules/${toDelete}`,
      });

      expect(res.statusCode).toBe(204);
    });

    it('DELETE /events/post-rules/:id — returns 404 for nonexistent rule', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/events/post-rules/epr_nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==========================================================================
  // Subscriptions
  // ==========================================================================

  describe('Subscriptions CRUD', () => {
    let createdSubId: string;

    it('POST /events/subscriptions — creates a hive-level subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/events/subscriptions',
        payload: {
          hive_id: testHiveId,
          source: 'github',
          event_types: ['push', 'pull_request.*'],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toMatch(/^esub_/);
      expect(body.swarm_id).toBeNull();
      expect(body.created_by).toBe('api');
      createdSubId = body.id;
    });

    it('POST /events/subscriptions — creates a swarm-specific subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/events/subscriptions',
        payload: {
          hive_id: testHiveId,
          swarm_id: 'swarm_route1',
          source: 'slack',
          event_types: ['message'],
          filters: { channels: ['C_GENERAL'] },
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.swarm_id).toBe('swarm_route1');
      expect(body.filters).toEqual({ channels: ['C_GENERAL'] });
    });

    it('POST /events/subscriptions — rejects missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/events/subscriptions',
        payload: { hive_id: testHiveId },
      });

      expect(res.statusCode).toBe(400);
    });

    it('GET /events/subscriptions — lists all subscriptions', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/events/subscriptions',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('GET /events/subscriptions?hive_id= — filters by hive', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/events/subscriptions?hive_id=${testHiveId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.every((s: any) => s.hive_id === testHiveId)).toBe(true);
    });

    it('GET /events/subscriptions?swarm_id= — filters by swarm', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/events/subscriptions?swarm_id=swarm_route1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.every((s: any) => s.swarm_id === 'swarm_route1')).toBe(true);
    });

    it('PUT /events/subscriptions/:id — updates a subscription', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/events/subscriptions/${createdSubId}`,
        payload: {
          event_types: ['push', 'pull_request.opened', 'issues.*'],
          enabled: false,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.event_types).toEqual(['push', 'pull_request.opened', 'issues.*']);
      expect(body.enabled).toBe(false);
    });

    it('PUT /events/subscriptions/:id — returns 404 for nonexistent', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/events/subscriptions/esub_nonexistent',
        payload: { enabled: false },
      });

      expect(res.statusCode).toBe(404);
    });

    it('DELETE /events/subscriptions/:id — deletes a subscription', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/events/subscriptions',
        payload: {
          hive_id: testHiveId,
          source: 'github',
          event_types: ['to_delete'],
        },
      });
      const toDelete = JSON.parse(createRes.body).id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/events/subscriptions/${toDelete}`,
      });

      expect(res.statusCode).toBe(204);
    });

    it('DELETE /events/subscriptions/:id — returns 404 for nonexistent', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/events/subscriptions/esub_nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==========================================================================
  // Delivery Log
  // ==========================================================================

  describe('Delivery Log', () => {
    beforeAll(() => {
      // Seed delivery log entries
      eventsDAL.logEventDelivery({
        delivery_id: 'del_route_log1',
        swarm_id: 'swarm_route1',
        source: 'github',
        event_type: 'push',
        status: 'sent',
      });
      eventsDAL.logEventDelivery({
        delivery_id: 'del_route_log2',
        swarm_id: 'swarm_route1',
        source: 'github',
        event_type: 'push',
        status: 'offline',
        error: 'Swarm not connected',
      });
    });

    it('GET /events/delivery-log — lists all deliveries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/events/delivery-log',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      expect(body.total).toBeGreaterThanOrEqual(2);
    });

    it('GET /events/delivery-log?delivery_id= — filters by delivery', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/events/delivery-log?delivery_id=del_route_log1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.length).toBe(1);
      expect(body.data[0].delivery_id).toBe('del_route_log1');
    });

    it('GET /events/delivery-log?swarm_id= — filters by swarm', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/events/delivery-log?swarm_id=swarm_route1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('GET /events/delivery-log?limit=&offset= — supports pagination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/events/delivery-log?swarm_id=swarm_route1&limit=1&offset=0',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.length).toBe(1);
      expect(body.total).toBeGreaterThanOrEqual(2);
    });
  });
});
