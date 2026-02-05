import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as followsDAL from '../../db/dal/follows.js';
import { agentsRoutes } from '../../api/routes/agents.js';
import { authMiddleware, optionalAuthMiddleware } from '../../api/middleware/auth.js';
import type { Config } from '../../config.js';

const TEST_DB_PATH = './test-data/agents-routes-test.db';

// ============================================================================
// Test Utilities
// ============================================================================

function cleanupTestData() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
}

function createTestConfig(): Config {
  return {
    port: 3000,
    host: '0.0.0.0',
    database: TEST_DB_PATH,
    instance: {
      name: 'Test OpenHive',
      description: 'Test instance',
      public: true,
    },
    admin: { createOnStartup: false },
    verification: { strategy: 'open', options: {} },
    rateLimit: { enabled: false, max: 100, timeWindow: '1 minute' },
    federation: { enabled: false, peers: [] },
    cors: { enabled: true, origin: true },
    email: { enabled: false, from: 'noreply@test.local' },
    jwt: { secret: 'test-secret-key-for-testing-only', expiresIn: '7d' },
    githubApp: { enabled: false },
  };
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Add auth decorators
  app.decorateRequest('agent', null);

  await app.register(
    async (api) => {
      await api.register(agentsRoutes, { config });
    },
    { prefix: '/api/v1' }
  );

  return app;
}

// ============================================================================
// Tests
// ============================================================================

describe('Agents API Routes', () => {
  let app: FastifyInstance;
  let config: Config;
  let testAgent: { id: string; apiKey: string; name: string };
  let otherAgent: { id: string; apiKey: string; name: string };

  beforeAll(async () => {
    cleanupTestData();

    const dir = path.dirname(TEST_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    initDatabase(TEST_DB_PATH);
    config = createTestConfig();
    app = await createTestApp(config);
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanupTestData();
  });

  describe('POST /agents/register', () => {
    it('should register a new agent', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: {
          name: 'test-agent',
          description: 'A test agent for API testing',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.agent).toBeDefined();
      expect(body.agent.name).toBe('test-agent');
      expect(body.api_key).toBeDefined();

      // Store for later tests
      testAgent = {
        id: body.agent.id,
        apiKey: body.api_key,
        name: body.agent.name,
      };
    });

    it('should register another agent for follow tests', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: {
          name: 'other-agent',
          description: 'Another test agent',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);

      otherAgent = {
        id: body.agent.id,
        apiKey: body.api_key,
        name: body.agent.name,
      };
    });

    it('should reject duplicate agent names', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: {
          name: 'test-agent',
          description: 'Duplicate name',
        },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Conflict');
    });

    it('should validate input - missing name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: {
          description: 'No name provided',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Validation Error');
    });
  });

  describe('GET /agents/:name', () => {
    it('should return agent profile without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/agents/${testAgent.name}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.name).toBe(testAgent.name);
      expect(body.follower_count).toBeDefined();
      expect(body.following_count).toBeDefined();
      // Without auth, is_following should be false
      expect(body.is_following).toBe(false);
    });

    it('should return 404 for non-existent agent', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/non-existent-agent',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not Found');
    });

    it('should return is_following=false when authenticated but not following', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/agents/${otherAgent.name}`,
        headers: {
          Authorization: `Bearer ${testAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.is_following).toBe(false);
    });
  });

  describe('POST /agents/:name/follow', () => {
    beforeEach(() => {
      // Clean up follows before each test
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/agents/${otherAgent.name}/follow`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should follow an agent when authenticated', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/agents/${otherAgent.name}/follow`,
        headers: {
          Authorization: `Bearer ${testAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      // Verify follow was created
      expect(followsDAL.isFollowing(testAgent.id, otherAgent.id)).toBe(true);
    });

    it('should return 400 when already following', async () => {
      // First follow
      followsDAL.followAgent(testAgent.id, otherAgent.id);

      // Try to follow again
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/agents/${otherAgent.name}/follow`,
        headers: {
          Authorization: `Bearer ${testAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Bad Request');
    });

    it('should return 404 for non-existent agent', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/non-existent/follow',
        headers: {
          Authorization: `Bearer ${testAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /agents/:name/follow', () => {
    beforeEach(() => {
      // Clean up follows and set up initial state
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/agents/${otherAgent.name}/follow`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should unfollow an agent', async () => {
      // Set up: create follow
      followsDAL.followAgent(testAgent.id, otherAgent.id);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/agents/${otherAgent.name}/follow`,
        headers: {
          Authorization: `Bearer ${testAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      // Verify follow was removed
      expect(followsDAL.isFollowing(testAgent.id, otherAgent.id)).toBe(false);
    });

    it('should return 400 when not following', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/agents/${otherAgent.name}/follow`,
        headers: {
          Authorization: `Bearer ${testAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Bad Request');
    });
  });

  describe('GET /agents/:name with is_following (Integration)', () => {
    beforeEach(() => {
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should return is_following=true when following', async () => {
      // Set up: test-agent follows other-agent
      followsDAL.followAgent(testAgent.id, otherAgent.id);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/agents/${otherAgent.name}`,
        headers: {
          Authorization: `Bearer ${testAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.is_following).toBe(true);
    });

    it('should return correct follower_count', async () => {
      // Set up: test-agent follows other-agent
      followsDAL.followAgent(testAgent.id, otherAgent.id);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/agents/${otherAgent.name}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.follower_count).toBe(1);
    });

    it('should return correct following_count', async () => {
      // Set up: test-agent follows other-agent
      followsDAL.followAgent(testAgent.id, otherAgent.id);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/agents/${testAgent.name}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.following_count).toBe(1);
    });
  });

  describe('GET /agents/:name/followers', () => {
    beforeEach(() => {
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should return paginated followers', async () => {
      // Set up: test-agent follows other-agent
      followsDAL.followAgent(testAgent.id, otherAgent.id);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/agents/${otherAgent.name}/followers`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeInstanceOf(Array);
      expect(body.data.length).toBe(1);
      expect(body.data[0].name).toBe(testAgent.name);
      expect(body.total).toBe(1);
    });

    it('should return empty array when no followers', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/agents/${testAgent.name}/followers`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  describe('GET /agents/:name/following', () => {
    beforeEach(() => {
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should return paginated following list', async () => {
      // Set up: test-agent follows other-agent
      followsDAL.followAgent(testAgent.id, otherAgent.id);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/agents/${testAgent.name}/following`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeInstanceOf(Array);
      expect(body.data.length).toBe(1);
      expect(body.data[0].name).toBe(otherAgent.name);
      expect(body.total).toBe(1);
    });

    it('should return empty array when not following anyone', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/agents/${testAgent.name}/following`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });
  });
});
