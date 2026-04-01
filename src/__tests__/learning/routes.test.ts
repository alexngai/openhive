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

function createTestConfig(overrides?: Record<string, unknown>): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false, key: 'test-admin-key' },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    learning: { enabled: true },
    ...overrides,
  });
}

// ============================================================================
// Enabled suite (admin agent, full Atlas)
// ============================================================================

describe('Learning API Routes', () => {
  let app: FastifyInstance;
  let atlasService: AtlasService;
  let config: Config;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await createAgent({ name: 'test-agent', description: 'test', is_admin: true });
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

  // ── Stats ──

  describe('GET /learning/stats', () => {
    it('should return Atlas stats', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('memory');
      expect(body).toHaveProperty('learning');
    });
  });

  // ── Health / Monitoring ──

  describe('GET /learning/health', () => {
    it('should return detailed monitoring status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
      expect(body).toHaveProperty('trajectories_processed');
      expect(body).toHaveProperty('playbook_count');
      expect(body).toHaveProperty('experience_count');
      expect(body).toHaveProperty('session_banks');
      expect(body).toHaveProperty('maintenance');
      expect(Array.isArray(body.session_banks)).toBe(true);
      expect(body.maintenance).toHaveProperty('scheduled');
      expect(body.maintenance).toHaveProperty('schedule');
    });
  });

  // ── Playbooks ──

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

    it('should respect pagination and sort params', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/playbooks?limit=10&offset=5&sort=recency',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(5);
    });

    it('should filter by domain', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/playbooks?domain=nonexistent-domain',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(0);
    });
  });

  describe('GET /learning/playbooks/:id', () => {
    it('should return 404 for nonexistent playbook', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/playbooks/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Knowledge ──

  describe('GET /learning/knowledge', () => {
    it('should return knowledge notes (empty initially)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/knowledge' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
    });

    it('should accept search parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/knowledge?search=test&limit=5',
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /learning/knowledge/:id', () => {
    it('should return 404 for nonexistent note', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/knowledge/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Experiences ──

  describe('GET /learning/experiences', () => {
    it('should return experiences (empty initially)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/experiences' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('should filter by domain', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/experiences?domain=nonexistent',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(0);
    });
  });

  // ── Activity Timeline ──

  describe('GET /learning/activity', () => {
    it('should return activity log (empty initially)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/learning/activity' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // ── Admin-only mutations ──

  describe('POST /learning/batch', () => {
    it('should trigger batch learning (admin)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/learning/batch' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toBeDefined();
    });
  });

  describe('POST /learning/maintenance', () => {
    it('should trigger maintenance (admin)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/learning/maintenance' });
      // 200 if pipeline supports it, 501 if not
      expect([200, 501]).toContain(res.statusCode);
    });
  });

  // ── Full data flow: trajectory → experiences + activity ──

  describe('trajectory data flow', () => {
    it('should populate experiences and activity after processing trajectory', async () => {
      const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
      const trajectory = createTrajectory({
        task: createTask({ domain: 'test', description: 'Route test trajectory' }),
        steps: [createStep({ action: 'test action', observation: 'test observation' })],
        outcome: successOutcome('done'),
        agentId: 'route-test-agent',
      });
      await atlasService.processTrajectory(trajectory);

      // Experiences should include the new one
      const expRes = await app.inject({ method: 'GET', url: '/api/v1/learning/experiences' });
      expect(expRes.statusCode).toBe(200);
      const expBody = JSON.parse(expRes.body);
      expect(expBody.total).toBeGreaterThanOrEqual(1);

      // Stats should reflect it
      const statsRes = await app.inject({ method: 'GET', url: '/api/v1/learning/stats' });
      const stats = JSON.parse(statsRes.body);
      expect(stats.memory.experienceCount).toBeGreaterThanOrEqual(1);

      // Activity log should have an 'instant' entry
      const actRes = await app.inject({ method: 'GET', url: '/api/v1/learning/activity' });
      expect(actRes.statusCode).toBe(200);
      const actBody = JSON.parse(actRes.body);
      expect(actBody.total).toBeGreaterThanOrEqual(1);
      const instantEvent = actBody.data.find((e: any) => e.type === 'instant');
      expect(instantEvent).toBeDefined();
      expect(instantEvent.summary).toBe('Trajectory processed');
      expect(instantEvent.data).toHaveProperty('domain', 'test');
      expect(instantEvent.data).toHaveProperty('outcome', 'success');
    });

    it('should record batch activity after batch trigger', async () => {
      await app.inject({ method: 'POST', url: '/api/v1/learning/batch' });

      const actRes = await app.inject({ method: 'GET', url: '/api/v1/learning/activity' });
      const actBody = JSON.parse(actRes.body);
      const batchEvent = actBody.data.find((e: any) => e.type === 'batch');
      expect(batchEvent).toBeDefined();
      expect(batchEvent.summary).toBe('Batch learning completed');
    });

    it('should respect activity pagination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/activity?limit=1&offset=0',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.length).toBeLessThanOrEqual(1);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(0);
    });
  });
});

// ============================================================================
// Disabled suite (learning engine off)
// ============================================================================

describe('Learning API Routes — disabled', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const disabledRoot = testRoot('learning-routes-disabled');
    cleanTestRoot(disabledRoot);
    const dbPath = testDbPath(disabledRoot, 'test.db');
    initDatabase(dbPath);

    const { agent } = await createAgent({ name: 'test-agent2', description: 'test', is_admin: true });
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      database: dbPath,
      instance: { name: 'Test', description: 'Test' },
      admin: { createOnStartup: false, key: 'test-admin-key' },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      learning: { enabled: false },
    });

    app = Fastify({ logger: false });
    app.decorateRequest('agent', null);

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

  it('should return 503 for playbooks when learning is disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/playbooks' });
    expect(res.statusCode).toBe(503);
  });

  it('should return 503 for knowledge when learning is disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/knowledge' });
    expect(res.statusCode).toBe(503);
  });

  it('should return 503 for experiences when learning is disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/experiences' });
    expect(res.statusCode).toBe(503);
  });

  it('should return 503 for activity when learning is disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/activity' });
    expect(res.statusCode).toBe(503);
  });

  it('should return 503 for batch when learning is disabled', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/learning/batch' });
    expect(res.statusCode).toBe(503);
  });

  it('should return 503 for maintenance when learning is disabled', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/learning/maintenance' });
    expect(res.statusCode).toBe(503);
  });

  it('should return available=false for health when disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.available).toBe(false);
    expect(body).toHaveProperty('reason');
  });
});

// ============================================================================
// Auth enforcement suite (non-admin agent)
// ============================================================================

describe('Learning API Routes — non-admin auth', () => {
  let app: FastifyInstance;
  let atlasService: AtlasService;

  beforeAll(async () => {
    const authRoot = testRoot('learning-routes-auth');
    cleanTestRoot(authRoot);
    const dbPath = testDbPath(authRoot, 'test.db');
    initDatabase(dbPath);

    // Create a non-admin agent
    const { agent } = await createAgent({ name: 'test-nonadmin', description: 'test', is_admin: false });
    setLocalAgent(agent);

    const config = createTestConfig({ database: dbPath });
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
  });

  it('should allow non-admin to read stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/stats' });
    expect(res.statusCode).toBe(200);
  });

  it('should allow non-admin to read playbooks', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/playbooks' });
    expect(res.statusCode).toBe(200);
  });

  it('should allow non-admin to read experiences', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/experiences' });
    expect(res.statusCode).toBe(200);
  });

  it('should allow non-admin to read activity', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/learning/activity' });
    expect(res.statusCode).toBe(200);
  });

  it('should deny non-admin from triggering batch', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/learning/batch' });
    expect(res.statusCode).toBe(403);
  });

  it('should deny non-admin from triggering maintenance', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/learning/maintenance' });
    expect(res.statusCode).toBe(403);
  });
});
