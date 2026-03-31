import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { createAgent } from '../../db/dal/agents.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { AtlasService } from '../../learning/atlas-service.js';
import { learningRoutes } from '../../api/routes/learning.js';
import { ConfigSchema, type Config } from '../../config.js';

const TEST_ROOT = testRoot('learning-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'test.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    learning: { enabled: true },
  });
}

describe('Learning API Routes', () => {
  let app: FastifyInstance;
  let atlasService: AtlasService;
  let config: Config;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await createAgent({ name: 'test-agent', description: 'test' });
    setLocalAgent(agent);

    config = createTestConfig();
    atlasService = new AtlasService(config, agent.id);
    await atlasService.init();

    app = Fastify({ logger: false });
    app.decorateRequest('agent', null);
    (app as unknown as { atlasService: AtlasService }).atlasService = atlasService;

    await app.register(
      async (api) => {
        await api.register(learningRoutes, { config });
      },
      { prefix: '/api/v1' },
    );
  });

  afterAll(async () => {
    await app.close();
    await atlasService.close();
    setLocalAgent(null);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('GET /learning/stats', () => {
    it('should return Atlas stats', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('memory');
      expect(body).toHaveProperty('learning');
    });
  });

  describe('GET /learning/health', () => {
    it('should return available=true when Atlas is running', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
      expect(body).toHaveProperty('trajectories_processed');
      expect(body).toHaveProperty('playbook_count');
    });
  });

  describe('GET /learning/playbooks', () => {
    it('should return paginated playbooks (empty initially)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/playbooks' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('limit');
      expect(body).toHaveProperty('offset');
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('should respect pagination params', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/playbooks?limit=10&offset=0&sort=confidence',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(0);
    });
  });

  describe('GET /learning/playbooks/:id', () => {
    it('should return 404 for nonexistent playbook', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/playbooks/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /learning/knowledge', () => {
    it('should return knowledge notes (empty initially)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/knowledge' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
    });
  });

  describe('GET /learning/experiences', () => {
    it('should return experiences (empty initially)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/experiences' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  describe('POST /learning/batch', () => {
    it('should trigger batch learning', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/learning/batch' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toBeDefined();
    });
  });

  describe('with trajectory data', () => {
    it('should show experiences after processing trajectory', async () => {
      // Feed a trajectory via Atlas
      const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
      const trajectory = createTrajectory({
        task: createTask({ domain: 'test', description: 'Route test trajectory' }),
        steps: [createStep({ action: 'test action', observation: 'test observation' })],
        outcome: successOutcome('done'),
        agentId: 'route-test-agent',
      });
      await atlasService.processTrajectory(trajectory);

      // Check experiences endpoint
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/experiences' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBeGreaterThanOrEqual(1);

      // Check stats reflect the trajectory
      const statsRes = await app.inject({ method: 'GET', url: '/api/v1/learning/stats' });
      const stats = JSON.parse(statsRes.body);
      expect(stats.memory.experienceCount).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('Learning API Routes — disabled', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Use a fresh DB for the disabled test
    const disabledRoot = testRoot('learning-routes-disabled');
    cleanTestRoot(disabledRoot);
    const dbPath = testDbPath(disabledRoot, 'test.db');
    initDatabase(dbPath);

    const { agent } = await createAgent({ name: 'test-agent2', description: 'test' });
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      database: dbPath,
      instance: { name: 'Test', description: 'Test' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      learning: { enabled: false },
    });

    app = Fastify({ logger: false });
    app.decorateRequest('agent', null);
    // No atlasService decorated → routes should return 503

    await app.register(
      async (api) => {
        await api.register(learningRoutes, { config });
      },
      { prefix: '/api/v1' },
    );
  });

  afterAll(async () => {
    await app.close();
    setLocalAgent(null);
    closeDatabase();
  });

  it('should return 503 for stats when learning is disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/stats' });
    expect(res.statusCode).toBe(503);
  });

  it('should return 503 for batch when learning is disabled', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/learning/batch' });
    expect(res.statusCode).toBe(503);
  });

  it('should return available=false for health when disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.available).toBe(false);
  });
});
