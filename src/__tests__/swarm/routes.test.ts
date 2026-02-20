import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { SwarmManager } from '../../swarm/manager.js';
import * as dal from '../../swarm/dal.js';
import type { Config } from '../../config.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('swarm-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'swarm-routes-test.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-routes-data');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SLEEP_SCRIPT = path.join(FIXTURES_DIR, 'sleep-server.js');

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
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      openswarm_command: `node ${SLEEP_SCRIPT}`,
      data_dir: TEST_DATA_DIR,
      port_range: [19200, 19210] as [number, number],
      max_swarms: 5,
      health_check_interval: 100000,
      max_health_failures: 3,
    },
  } as Config;
}

// Auth middleware that reads Bearer token
function createAuthPreHandler(agents: Map<string, { id: string; name: string }>) {
  return async function authMiddleware(request: any, reply: any) {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const token = auth.slice(7);
    const agent = agents.get(token);
    if (!agent) {
      return reply.status(401).send({ error: 'Invalid token' });
    }
    request.agent = agent;
  };
}

describe('Swarm Hosting API Routes', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let testAgent: { id: string; apiKey: string; name: string };
  let otherAgent: { id: string; apiKey: string; name: string };
  const agentsByKey = new Map<string, { id: string; name: string }>();

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    config = createTestConfig();

    // Create test agents
    const agentResult = await agentsDAL.createAgent({
      name: 'route-test-agent',
      description: 'Agent for route tests',
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey, name: 'route-test-agent' };
    agentsByKey.set(agentResult.apiKey, { id: agentResult.agent.id, name: 'route-test-agent' });

    const otherResult = await agentsDAL.createAgent({
      name: 'other-route-agent',
      description: 'Another agent for ownership tests',
    });
    otherAgent = { id: otherResult.agent.id, apiKey: otherResult.apiKey, name: 'other-route-agent' };
    agentsByKey.set(otherResult.apiKey, { id: otherResult.agent.id, name: 'other-route-agent' });

    // Create test hive
    hivesDAL.createHive({
      name: 'route-test-hive',
      description: 'Test hive for route tests',
      owner_id: testAgent.id,
    });

    // Initialize SwarmManager
    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      'http://localhost:3000'
    );

    // Create Fastify app with auth middleware that maps API keys to agents
    app = Fastify({ logger: false });

    // Decorate request with agent
    app.decorateRequest('agent', null);

    // Add auth hook for all routes
    app.addHook('preHandler', async (request: any, reply: any) => {
      const auth = request.headers.authorization;
      if (auth && auth.startsWith('Bearer ')) {
        const token = auth.slice(7);
        const agent = agentsByKey.get(token);
        if (agent) {
          request.agent = agent;
        }
      }
    });

    // Attach swarm manager to the fastify instance
    (app as any).swarmManager = swarmManager;

    await app.register(
      async (api) => {
        await api.register(swarmHostingRoutes, { config });
      },
      { prefix: '/api/v1' }
    );
  });

  afterAll(async () => {
    await swarmManager.shutdown();
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('GET /api/v1/map/hosted', () => {
    it('should return empty list initially', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/map/hosted',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.total).toBeDefined();
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/map/hosted',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/map/hosted/spawn', () => {
    it('should spawn a swarm and return its details', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: {
          name: 'api-spawned-swarm',
          adapter: 'macro-agent',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.id).toMatch(/^hswarm_/);
      expect(body.provider).toBe('local');
      expect(body.assigned_port).toBeGreaterThanOrEqual(19200);
      expect(body.created_at).toBeDefined();
    }, 35000);

    it('should reject invalid request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: {
          // missing required 'name'
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('should reject name exceeding max length', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: {
          name: 'x'.repeat(101),
        },
      });

      expect(response.statusCode).toBe(422);
    });
  });

  describe('GET /api/v1/map/hosted/:id', () => {
    it('should return details of a hosted swarm', async () => {
      // Create one first
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'detail-test-swarm' },
      });
      const spawned = JSON.parse(spawnRes.body);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${spawned.id}`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(spawned.id);
      expect(body.provider).toBe('local');
      expect(body.spawned_by).toBe(testAgent.id);
    }, 35000);

    it('should return 404 for non-existent ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/map/hosted/hswarm_nonexistent',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /api/v1/map/hosted/:id/stop', () => {
    it('should stop a hosted swarm', async () => {
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'stop-route-test' },
      });
      const spawned = JSON.parse(spawnRes.body);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${spawned.id}/stop`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.state).toBe('stopped');
    }, 40000);

    it('should return 404 for non-existent swarm', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/hswarm_nonexistent/stop',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 403 when not the owner', async () => {
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'ownership-stop-test' },
      });
      const spawned = JSON.parse(spawnRes.body);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${spawned.id}/stop`,
        headers: { authorization: `Bearer ${otherAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(403);
    }, 35000);
  });

  describe('GET /api/v1/map/hosted/:id/logs', () => {
    it('should return logs as text/plain', async () => {
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'logs-route-test' },
      });
      const spawned = JSON.parse(spawnRes.body);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${spawned.id}/logs`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
    }, 35000);

    it('should accept lines query param', async () => {
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'logs-lines-route-test' },
      });
      const spawned = JSON.parse(spawnRes.body);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${spawned.id}/logs?lines=10`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
    }, 35000);
  });

  describe('GET /api/v1/map/hosted with filters', () => {
    it('should filter by mine=true', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/map/hosted?mine=true',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      body.data.forEach((h: any) => {
        expect(h.spawned_by).toBe(testAgent.id);
      });
    });

    it('should filter by state', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/map/hosted?state=stopped',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      body.data.forEach((h: any) => {
        expect(h.state).toBe('stopped');
      });
    });

    it('should respect limit parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/map/hosted?limit=2',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.length).toBeLessThanOrEqual(2);
    });
  });
});
