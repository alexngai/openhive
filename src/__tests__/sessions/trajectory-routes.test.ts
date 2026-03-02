/**
 * Tests for trajectory session API routes.
 *
 * Covers GET /sessions/overview, GET /sessions/:id/trajectory-checkpoints,
 * and GET /sessions/:id/trajectory-stats.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as trajectoryDAL from '../../db/dal/trajectory-checkpoints.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('trajectory-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'trajectory-routes.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test OpenHive', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    async (api) => {
      await api.register(sessionsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('Trajectory Session Routes', () => {
  let app: FastifyInstance;
  let agentId: string;
  let sessionId1: string;
  let sessionId2: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'traj-route-agent',
      description: 'Agent for trajectory route tests',
    });
    agentId = agent.id;

    // Create session resources
    const s1 = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'route-session-1',
      git_remote_url: 'local://test/s1',
      owner_agent_id: agentId,
    });
    sessionId1 = s1.id;

    const s2 = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'route-session-2',
      git_remote_url: 'local://test/s2',
      owner_agent_id: agentId,
    });
    sessionId2 = s2.id;

    // Add checkpoints to session 1
    for (let i = 0; i < 5; i++) {
      trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: sessionId1,
        checkpoint_id: `chk_rt_${i}`,
        commit_hash: `rt_hash_${i}`,
        agent: `agent-${i % 2 === 0 ? 'alpha' : 'beta'}`,
        branch: 'main',
        files_touched: [`file_${i}.ts`],
        token_usage: { input_tokens: 100 * (i + 1), output_tokens: 50 * (i + 1) },
      });
    }

    // Session 2 has no checkpoints (empty)

    const config = createTestConfig();
    app = await createTestApp(config);
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /sessions/overview
  // ═══════════════════════════════════════════════════════════════

  describe('GET /sessions/overview', () => {
    it('should return all sessions with checkpoint stats', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/overview',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.total).toBeGreaterThanOrEqual(2);

      // Find our sessions
      const s1 = body.data.find((s: { id: string }) => s.id === sessionId1);
      const s2 = body.data.find((s: { id: string }) => s.id === sessionId2);

      expect(s1).toBeDefined();
      expect(s1.name).toBe('route-session-1');
      expect(s1.total_checkpoints).toBe(5);
      expect(s1.total_input_tokens).toBeGreaterThan(0);
      expect(s1.total_output_tokens).toBeGreaterThan(0);

      expect(s2).toBeDefined();
      expect(s2.name).toBe('route-session-2');
      expect(s2.total_checkpoints).toBe(0);
    });

    it('should support pagination via limit and offset', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/overview?limit=1&offset=0',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBe(1);
      expect(body.total).toBeGreaterThanOrEqual(2);
    });

    it('should clamp limit to 100', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/overview?limit=999',
      });

      expect(res.statusCode).toBe(200);
      // Just verify it doesn't error out — the controller clamps to 100
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /sessions/:id/trajectory-checkpoints
  // ═══════════════════════════════════════════════════════════════

  describe('GET /sessions/:id/trajectory-checkpoints', () => {
    it('should list checkpoints for a session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId1}/trajectory-checkpoints`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(5);
      expect(body.total).toBe(5);

      // Verify checkpoint shape
      const cp = body.data[0];
      expect(cp.id).toBeTruthy();
      expect(cp.checkpoint_id).toBeTruthy();
      expect(cp.commit_hash).toBeTruthy();
      expect(cp.agent).toBeTruthy();
      expect(cp.synced_at).toBeTruthy();
    });

    it('should return empty for session with no checkpoints', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId2}/trajectory-checkpoints`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should support pagination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId1}/trajectory-checkpoints?limit=2&offset=0`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBe(2);
      expect(body.total).toBe(5);

      // Second page
      const res2 = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId1}/trajectory-checkpoints?limit=2&offset=2`,
      });

      const body2 = res2.json();
      expect(body2.data.length).toBe(2);
      expect(body2.data[0].id).not.toBe(body.data[0].id);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/nonexistent/trajectory-checkpoints',
      });

      expect(res.statusCode).toBe(404);
    });

    it('should return 404 for non-session resource', async () => {
      // Create a memory_bank resource
      const mem = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'not-a-session',
        git_remote_url: 'https://example.com/mem.git',
        owner_agent_id: agentId,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${mem.id}/trajectory-checkpoints`,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /sessions/:id/trajectory-stats
  // ═══════════════════════════════════════════════════════════════

  describe('GET /sessions/:id/trajectory-stats', () => {
    it('should return aggregated stats for a session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId1}/trajectory-stats`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.total_checkpoints).toBe(5);
      // Sum of 100+200+300+400+500 = 1500
      expect(body.total_input_tokens).toBe(1500);
      // Sum of 50+100+150+200+250 = 750
      expect(body.total_output_tokens).toBe(750);
      expect(body.total_files_touched).toBe(5); // file_0..file_4
      expect(body.latest_agent).toBeTruthy();
      expect(body.first_synced_at).toBeTruthy();
      expect(body.last_synced_at).toBeTruthy();
    });

    it('should return zeros for empty session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId2}/trajectory-stats`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.total_checkpoints).toBe(0);
      expect(body.total_input_tokens).toBe(0);
      expect(body.total_output_tokens).toBe(0);
      expect(body.total_files_touched).toBe(0);
      expect(body.latest_agent).toBeNull();
    });

    it('should return 404 for non-existent session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/nonexistent/trajectory-stats',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
