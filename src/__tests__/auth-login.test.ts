/**
 * E2E tests for self-hosted password login (Remote Control A3).
 *
 * - POST /auth/login verifies a human account's password and mints a
 *   short-lived, scoped ingest key (ohk_...). No new token type — the existing
 *   auth middleware already validates + scope-gates these keys.
 * - POST /admin/operators provisions human operator accounts (create/update).
 *
 * See docs/design/remote-control.md.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

vi.mock('../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock('../realtime/swarm-events.js', () => ({
  broadcastSwarmLifecycleEvent: vi.fn(),
}));

import { initDatabase, closeDatabase } from '../db/index.js';
import * as agentsDAL from '../db/dal/agents.js';
import { validateIngestKey } from '../db/dal/ingest-keys.js';
import { authRoutes } from '../api/routes/auth.js';
import { adminRoutes } from '../api/routes/admin.js';
import { ConfigSchema, type Config } from '../config.js';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';

const TEST_ROOT = testRoot('auth-login');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'auth-login.db');
const ADMIN_KEY = 'auth-login-admin-key';

async function makeAuthApp(authMode: 'local' | 'swarmhub' = 'local'): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(authRoutes, { config: { authMode } });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

function makeAdminConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Auth Login Test', description: 'Tests' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'swarmhub' }, // force admin-key checks (no local-mode bypass)
    rateLimit: { enabled: false },
    cors: { enabled: false },
  });
}

async function makeAdminApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(adminRoutes, { config: makeAdminConfig() });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('Self-hosted password login (A3)', () => {
  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    // Seed a non-admin operator and an admin operator.
    await agentsDAL.createHumanAccount({
      name: 'operator',
      email: 'operator@example.com',
      password: 'CorrectHorse1',
    });
    const boss = await agentsDAL.createHumanAccount({
      name: 'boss',
      email: 'boss@example.com',
      password: 'AdminPass1',
    });
    agentsDAL.updateAgent(boss.id, { is_admin: true });
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('POST /auth/login', () => {
    it('logs in with a correct password and mints a valid ohk_ key with * scope', async () => {
      const app = await makeAuthApp('local');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'operator', password: 'CorrectHorse1' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.token).toMatch(/^ohk_/);
      expect(body.agent.name).toBe('operator');
      expect(body.expires_in).toBe(24 * 3600);

      // The minted key validates and carries '*' scope so the web console
      // (which hits /agents, /hives, ...) works. Admin routes stay gated by
      // requireAdmin on the agent, not by this scope.
      const key = validateIngestKey(body.token);
      expect(key).toBeTruthy();
      expect(key?.scopes).toEqual(['*']);
      await app.close();
    });

    it('flags admin operators as admin in the returned agent', async () => {
      const app = await makeAuthApp('local');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'boss', password: 'AdminPass1' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.agent.is_admin).toBe(true);
      expect(validateIngestKey(body.token)?.scopes).toEqual(['*']);
      await app.close();
    });

    it('accepts email as the username', async () => {
      const app = await makeAuthApp('local');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'operator@example.com', password: 'CorrectHorse1' },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('rejects a wrong password with 401', async () => {
      const app = await makeAuthApp('local');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'operator', password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('rejects an unknown username with 401', async () => {
      const app = await makeAuthApp('local');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'nobody', password: 'whatever' },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('is unavailable in swarmhub mode (400)', async () => {
      const app = await makeAuthApp('swarmhub');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'operator', password: 'CorrectHorse1' },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('validates required fields (400)', async () => {
      const app = await makeAuthApp('local');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'operator' },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe('POST /admin/operators', () => {
    it('creates a new operator (201) that can then log in', async () => {
      const admin = await makeAdminApp();
      const create = await admin.inject({
        method: 'POST',
        url: '/api/v1/admin/operators',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { username: 'provisioned', password: 'FirstPass1' },
      });
      expect(create.statusCode).toBe(201);
      expect(JSON.parse(create.payload).operator.name).toBe('provisioned');
      await admin.close();

      const auth = await makeAuthApp('local');
      const login = await auth.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'provisioned', password: 'FirstPass1' },
      });
      expect(login.statusCode).toBe(200);
      await auth.close();
    });

    it('updates an existing operator password (200); old password stops working', async () => {
      const admin = await makeAdminApp();
      const update = await admin.inject({
        method: 'POST',
        url: '/api/v1/admin/operators',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { username: 'provisioned', password: 'SecondPass2' },
      });
      expect(update.statusCode).toBe(200);
      await admin.close();

      const auth = await makeAuthApp('local');
      const old = await auth.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'provisioned', password: 'FirstPass1' },
      });
      expect(old.statusCode).toBe(401);
      const fresh = await auth.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'provisioned', password: 'SecondPass2' },
      });
      expect(fresh.statusCode).toBe(200);
      await auth.close();
    });

    it('409s when the username belongs to a non-human account', async () => {
      await agentsDAL.createAgent({ name: 'a-bot', description: 'agent-type account' });
      const admin = await makeAdminApp();
      const res = await admin.inject({
        method: 'POST',
        url: '/api/v1/admin/operators',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { username: 'a-bot', password: 'whatever1' },
      });
      expect(res.statusCode).toBe(409);
      await admin.close();
    });

    it('rejects without the admin key (401)', async () => {
      const admin = await makeAdminApp();
      const res = await admin.inject({
        method: 'POST',
        url: '/api/v1/admin/operators',
        payload: { username: 'x', password: 'y' },
      });
      expect(res.statusCode).toBe(401);
      await admin.close();
    });
  });
});
