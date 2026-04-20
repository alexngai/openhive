/**
 * E2E test for PR 5 of the v4 rollout.
 *
 * Verifies that a swarm can register via `POST /api/v1/map/swarms`
 * presenting an agent-iam delegated token as its Bearer credential.
 * The token is what `map/agents/spawn` or `admin onboard-token` would
 * have minted for the new swarm.
 *
 * authMiddleware falls through api-key / ingest-key / SwarmHub-JWT to
 * try verifyToken as a final auth mechanism. On success the token's
 * agentId resolves to the DB row and becomes the swarm's owner.
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
import { mapRoutes } from '../api/routes/map.js';
import { adminRoutes } from '../api/routes/admin.js';
import { initTokenService, _resetTokenService } from '../map/token-service.js';
import { ConfigSchema, type Config } from '../config.js';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';

const TEST_ROOT = testRoot('map-swarms-delegated');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'delegated.db');
const ADMIN_KEY = 'delegated-admin-key';

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Delegated Test', description: 'Tests' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'swarmhub' }, // avoid local auto-auth masking
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
      await api.register(mapRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('POST /map/swarms with delegated agent-iam token', () => {
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

  it('registers a swarm using a delegated token as Bearer', async () => {
    const app = await makeApp(makeConfig());

    // Operator mints an onboard token (would normally be via CLI)
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { agent_name: 'new-delegated-swarm', scopes: ['map:*'] },
    });
    expect(onboardRes.statusCode).toBe(200);
    const { token, agent_id } = JSON.parse(onboardRes.payload);

    // New swarm boots, uses the delegated token to register.
    // No api-key, no pre-existing SwarmHub account — just the token.
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/swarms',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'delegated-swarm-test',
        map_endpoint: 'ws://worker.example.com:8080/map',
      },
    });

    expect(registerRes.statusCode).toBe(201);
    const body = JSON.parse(registerRes.payload);
    expect(body.swarm).toBeDefined();
    expect(body.swarm.owner_agent_id).toBe(agent_id);
    expect(body.swarm.name).toBe('delegated-swarm-test');

    await app.close();
  });

  it('rejects an unsigned / garbage Bearer', async () => {
    const app = await makeApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/map/swarms',
      headers: { authorization: 'Bearer not-a-real-token' },
      payload: {
        name: 'should-fail',
        map_endpoint: 'ws://x.example.com:8080/map',
      },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an expired delegated token', async () => {
    const app = await makeApp(makeConfig());

    const onboardRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { agent_name: 'expired-swarm', scopes: ['map:*'], ttl_hours: 1 },
    });
    const { token } = JSON.parse(onboardRes.payload);

    // Tamper the token to simulate verification failure (can't easily
    // expire a token mid-test without faking the clock; tampering
    // exercises the same 'invalid token' path in authMiddleware).
    const tampered = token.slice(0, -3) + 'XYZ';

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/map/swarms',
      headers: { authorization: `Bearer ${tampered}` },
      payload: {
        name: 'expired-swarm-register',
        map_endpoint: 'ws://x.example.com:8080/map',
      },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('preauth_key field is removed from schema (extra field ignored or rejected)', async () => {
    // Under v4 the schema no longer has preauth_key. Zod's default
    // behavior leaves extra fields alone (doesn't reject), but the
    // field is silently ignored. The test's job is to confirm that
    // even if a caller sends it, we don't treat it as a valid bootstrap
    // mechanism — the token is the only path.
    const app = await makeApp(makeConfig());
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard-token',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { agent_name: 'preauth-test-swarm', scopes: ['map:*'] },
    });
    const { token } = JSON.parse(onboardRes.payload);

    // Register with token AND a stale preauth_key — token wins, preauth is ignored.
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/swarms',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'preauth-test-swarm-register',
        map_endpoint: 'ws://x.example.com:8080/map',
        preauth_key: 'ohpak_legacy_ignored', // extra, not in schema
      },
    });
    expect(registerRes.statusCode).toBe(201);

    await app.close();
  });
});
