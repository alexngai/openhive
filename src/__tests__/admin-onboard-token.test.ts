/**
 * E2E tests for `POST /admin/onboard-token` (PR 4 of the v4 rollout).
 *
 * Operator bootstrap path: admin key → hub mints a delegated agent-iam
 * token the operator hands to a new swarm's subprocess. Replaces the
 * retired preauth-key flow.
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
import { adminRoutes } from '../api/routes/admin.js';
import {
  initTokenService,
  _resetTokenService,
  verifyToken,
} from '../map/token-service.js';
import { ConfigSchema, type Config } from '../config.js';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';

const TEST_ROOT = testRoot('admin-onboard-token');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'onboard.db');
const ADMIN_KEY = 'onboard-token-admin-key';

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Onboard Test', description: 'Tests' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'swarmhub' }, // avoid local-mode auto-auth
    rateLimit: { enabled: false },
    cors: { enabled: false },
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

describe('POST /admin/onboard-token', () => {
  beforeAll(() => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initTokenService(undefined, TEST_ROOT);
  });

  afterAll(() => {
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('mints a new agent + token with default map:agents:spawn and 24h TTL', async () => {
    const app = await makeApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.agent_id).toBeTruthy();
    expect(body.token).toBeTruthy();
    expect(body.method).toBe('bearer');
    expect(body.scopes).toEqual(['map:agents:spawn']);
    expect(body.ttl_hours).toBe(24);
    expect(body.env.AGENT_TOKEN).toBe(body.token);
    expect(body.env.MAP_CREDENTIAL).toBe(body.token);

    // Token verifies
    const verified = verifyToken(body.token);
    expect(verified.valid).toBe(true);
    expect(verified.token?.agentId).toBe(body.agent_id);
    expect(verified.token?.scopes).toEqual(['map:agents:spawn']);

    // Agent row exists
    const row = agentsDAL.findAgentById(body.agent_id);
    expect(row).toBeTruthy();
    expect(row?.metadata?.onboarded_via).toBe('admin-token');

    await app.close();
  });

  it('accepts --agent-name and uses it', async () => {
    const app = await makeApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { agent_name: 'named-onboard-agent' },
    });
    const body = JSON.parse(res.payload);
    const row = agentsDAL.findAgentById(body.agent_id);
    expect(row?.name).toBe('named-onboard-agent');
    await app.close();
  });

  it('reuses an existing agent when --agent-id is given', async () => {
    const existing = await agentsDAL.createAgent({
      name: 'preexisting-agent',
      description: 'Created before onboard-token call',
    });
    const app = await makeApp(makeConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { agent_id: existing.agent.id },
    });
    const body = JSON.parse(res.payload);
    expect(body.agent_id).toBe(existing.agent.id);

    // The agent's `onboarded_via` is NOT set because we reused — row is unchanged
    const row = agentsDAL.findAgentById(existing.agent.id);
    expect(row?.metadata?.onboarded_via).toBeUndefined();

    await app.close();
  });

  it('404s when --agent-id references a nonexistent agent', async () => {
    const app = await makeApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { agent_id: 'does-not-exist' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('accepts custom narrow scope list', async () => {
    const app = await makeApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { scopes: ['map:tasks:create', 'map:tasks:list'] },
    });
    const body = JSON.parse(res.payload);
    expect(body.scopes).toEqual(['map:tasks:create', 'map:tasks:list']);
    const verified = verifyToken(body.token);
    expect(verified.token?.scopes).toEqual(['map:tasks:create', 'map:tasks:list']);
    await app.close();
  });

  it('clamps ttl_hours to the 1..720 range (30 days cap)', async () => {
    const app = await makeApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { ttl_hours: 999999 },
    });
    // ttl_hours > 720 should be rejected at validation
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects without admin key', async () => {
    const app = await makeApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects with wrong admin key', async () => {
    const app = await makeApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      headers: { 'x-admin-key': 'wrong' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
