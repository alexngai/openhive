/**
 * REST endpoints for `workspace_policy`:
 *   GET   /api/v1/map/swarms/:id/workspace-policy
 *   PATCH /api/v1/map/swarms/:id/workspace-policy
 *
 * Pinned behaviors:
 *   1. GET returns `{ workspace_policy: null }` when the column is unset.
 *   2. PATCH with a valid policy persists it; subsequent GET returns it.
 *   3. PATCH with `{ workspace_policy: null }` clears the column.
 *   4. PATCH with a malformed policy (mode='allow_listed' + empty
 *      `allowed_repos`) returns 400 with the field path.
 *   5. PATCH from an agent that doesn't own the swarm returns 403
 *      `NOT_SWARM_OWNER`.
 *   6. GET on an unknown swarm returns 404 `SWARM_NOT_FOUND`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock('../../realtime/swarm-events.js', () => ({
  broadcastSwarmLifecycleEvent: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import { mapRoutes } from '../../api/routes/map.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('workspace-policy-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'workspace-policy-routes.db');

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Policy Routes Test', description: 'Tests' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
  });
}

async function makeApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    async (api) => {
      await api.register(mapRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
  return app;
}

describe('GET/PATCH /map/swarms/:id/workspace-policy', () => {
  let app: FastifyInstance;
  let ownerAgentId: string;
  let strangerAgentId: string;
  let swarmId: string;
  let strangerApiKey: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const owner = await agentsDAL.createAgent({ name: 'policy-routes-owner', is_admin: false });
    ownerAgentId = owner.agent.id;

    const stranger = await agentsDAL.createAgent({ name: 'policy-routes-stranger', is_admin: false });
    strangerAgentId = stranger.agent.id;
    strangerApiKey = stranger.apiKey;

    setLocalAgent(owner.agent);

    const swarm = mapDAL.createSwarm(ownerAgentId, {
      name: 'policy-routes-swarm',
      map_endpoint: 'ws://policy-routes-test/',
      map_transport: 'websocket',
    });
    swarmId = swarm.id;

    app = await makeApp(makeConfig());
  });

  afterAll(async () => {
    if (app) await app.close();
    setLocalAgent(null);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ── GET ───────────────────────────────────────────────────────────────────

  it('GET returns null when the column is unset', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspace_policy: null });
  });

  it('GET on unknown swarm returns SWARM_NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/swarms/swarm_nonexistent/workspace-policy',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('SWARM_NOT_FOUND');
  });

  // ── PATCH: write + clear ──────────────────────────────────────────────────

  it('PATCH with a valid allow_listed policy persists it', async () => {
    const policy = {
      mode: 'allow_listed' as const,
      allowed_repos: ['https://github.com/foo/bar'],
    };
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
      headers: { 'content-type': 'application/json' },
      payload: policy,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspace_policy: policy });

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
    });
    expect(get.json()).toEqual({ workspace_policy: policy });
  });

  it('PATCH with a wrapper {workspace_policy: <policy>} also works', async () => {
    const policy = {
      mode: 'pinned' as const,
      pinned_repo: 'https://github.com/foo/baz',
    };
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
      headers: { 'content-type': 'application/json' },
      payload: { workspace_policy: policy },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspace_policy: policy });
  });

  it('PATCH with {workspace_policy: null} clears the column', async () => {
    // Pre-write a policy
    getDatabase().prepare(
      'UPDATE map_swarms SET workspace_policy = ? WHERE id = ?',
    ).run(JSON.stringify({ mode: 'open' }), swarmId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
      headers: { 'content-type': 'application/json' },
      payload: { workspace_policy: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspace_policy: null });

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
    });
    expect(get.json()).toEqual({ workspace_policy: null });
  });

  // ── PATCH: validation ─────────────────────────────────────────────────────

  it("PATCH with mode='allow_listed' and empty allowed_repos returns 400", async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
      headers: { 'content-type': 'application/json' },
      payload: { mode: 'allow_listed', allowed_repos: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation Error');
    const issues: Array<{ path: string[]; message: string }> = res.json().details;
    expect(issues.some((i) => i.path.includes('allowed_repos'))).toBe(true);
  });

  it('PATCH with unknown mode returns 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
      headers: { 'content-type': 'application/json' },
      payload: { mode: 'whatever' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH with empty body returns 400 and does NOT silently clear the policy', async () => {
    // Pre-write a policy.
    const prior = { mode: 'open' as const };
    getDatabase().prepare(
      'UPDATE map_swarms SET workspace_policy = ? WHERE id = ?',
    ).run(JSON.stringify(prior), swarmId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);

    // Pre-existing policy must still be in place.
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
    });
    expect(get.json()).toEqual({ workspace_policy: prior });
  });

  it('PATCH with bare null body returns 400 (must use {workspace_policy: null} to clear)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
      headers: { 'content-type': 'application/json' },
      payload: null,
    });
    expect(res.statusCode).toBe(400);
  });

  // ── PATCH: authorization ──────────────────────────────────────────────────

  it('PATCH from a non-owner agent returns NOT_SWARM_OWNER', async () => {
    // setLocalAgent points at the owner. Pass an explicit Bearer for the
    // stranger; authMiddleware honors Bearer over local-auth fall-through.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/map/swarms/${swarmId}/workspace-policy`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${strangerApiKey}`,
      },
      payload: { mode: 'open' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_SWARM_OWNER');
    void strangerAgentId; // referenced for clarity in setup
  });
});
