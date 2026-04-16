/**
 * Tests for the admin dispatch-policy endpoints (Stream 2 PR 4 — D9 kill switch).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { adminRoutes } from '../../api/routes/admin.js';
import { ConfigSchema, type Config } from '../../config.js';
import { resetDispatchPolicy, isAutonomousDispatchPaused } from '../../map/dispatch-policy.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('admin-dispatch-policy');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'admin-dispatch-policy.db');
const ADMIN_KEY = 'test-admin-key-dp';

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function makeApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(adminRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('Admin dispatch-policy endpoints', () => {
  let app: FastifyInstance;
  let normalAgent: { apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());
    const { apiKey } = await agentsDAL.createAgent({
      name: 'normie',
      description: 'no admin',
    });
    normalAgent = { apiKey };
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    resetDispatchPolicy();
  });

  describe('GET /admin/dispatch-policy', () => {
    it('returns the current pause state with admin key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/dispatch-policy',
        headers: { 'X-Admin-Key': ADMIN_KEY },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ autonomous_dispatch_paused: false });
    });

    it('rejects without admin key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/dispatch-policy',
        headers: { Authorization: `Bearer ${normalAgent.apiKey}` },
      });
      // requireAdmin sends 403 for non-admin agents
      expect([401, 403]).toContain(res.statusCode);
    });
  });

  describe('POST /admin/dispatch-policy', () => {
    it('flips the toggle on and off', async () => {
      let res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/dispatch-policy',
        headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
        payload: { paused: true },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).autonomous_dispatch_paused).toBe(true);
      expect(isAutonomousDispatchPaused()).toBe(true);

      res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/dispatch-policy',
        headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
        payload: { paused: false },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).autonomous_dispatch_paused).toBe(false);
      expect(isAutonomousDispatchPaused()).toBe(false);
    });

    it('rejects non-boolean paused', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/dispatch-policy',
        headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
        payload: { paused: 'yes please' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('rejects without admin key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/dispatch-policy',
        headers: { Authorization: `Bearer ${normalAgent.apiKey}`, 'Content-Type': 'application/json' },
        payload: { paused: true },
      });
      expect([401, 403]).toContain(res.statusCode);
    });
  });
});
