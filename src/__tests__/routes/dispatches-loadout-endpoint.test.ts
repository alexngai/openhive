/**
 * GET /api/v1/dispatches/:id/loadout — Tier 1 permissions pass-through (gap E).
 *
 * The hub doesn't enforce permissions; the swarm sidecar pulls the
 * materialized loadout from this endpoint and applies the rules locally
 * (writes `.claude/settings.local.json` or equivalent). The endpoint
 * surfaces the same `MaterializedLoadout` artifact the dispatch runtime
 * uses internally, so hub-side and runtime-side views agree.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
  broadcast: vi.fn(),
}));

import {
  bundleLoadout,
  resolveStandaloneLoadout,
} from 'openteams';
import type { LoadoutDefinition, MAPResource } from 'openteams';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import { dispatchesRoutes } from '../../api/routes/dispatches.js';
import { ConfigSchema, type Config } from '../../config.js';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsBundleStore,
} from '../../openteams/map-handlers.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('dispatches-loadout-endpoint');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'dispatches-loadout-endpoint.db');

const LOADOUT: LoadoutDefinition = {
  name: 'endpoint-lo',
  capabilities: ['file.read'],
  permissions: {
    allow: ['Read(**)'],
    deny: ['Bash(git push:*)'],
    ask: ['Write(.env)'],
  },
  prompt_addendum: 'be thorough',
};

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function makeApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(dispatchesRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('GET /dispatches/:id/loadout (Tier 1 permissions pass-through)', () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());
    const a = await agentsDAL.createAgent({
      name: 'endpoint-agent',
      description: 'endpoint test',
    });
    agent = { id: a.agent.id, apiKey: a.apiKey };
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM dispatches').run();
    _resetOpenteamsMapHandlers();
  });

  it('404 for unknown dispatch id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dispatches/disp_nope/loadout',
      headers: { Authorization: `Bearer ${agent.apiKey}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns null materialized when the dispatch has no loadout binding', async () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c-1',
      target_swarm_id: 'swarm_a',
      initiator_type: 'user',
      initiator_id: agent.id,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/dispatches/${d.id}/loadout`,
      headers: { Authorization: `Bearer ${agent.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.materialized).toBeNull();
    expect(body.team_bundle_id).toBeNull();
    expect(body.role).toBeNull();
  });

  it('returns the materialized loadout (incl. permissions) when bound', async () => {
    const bundle = bundleLoadout(resolveStandaloneLoadout(LOADOUT), {
      version: '0.0.0',
      name: 'endpoint-lo',
    });
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);

    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c-2',
      target_swarm_id: 'swarm_a',
      initiator_type: 'user',
      initiator_id: agent.id,
      loadout_bundle_id: bundle.id,
      team_bundle_id: 'sha256:teamhash',
      role: 'executor',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/dispatches/${d.id}/loadout`,
      headers: { Authorization: `Bearer ${agent.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.materialized).not.toBeNull();
    expect(body.materialized.name).toBe('endpoint-lo');
    expect(body.materialized.permissions).toEqual({
      allow: ['Read(**)'],
      deny: ['Bash(git push:*)'],
      ask: ['Write(.env)'],
    });
    expect(body.materialized.promptAddendum).toBe('be thorough');
    expect(body.team_bundle_id).toBe('sha256:teamhash');
    expect(body.role).toBe('executor');
  });

  it('returns 410 Gone when the pinned bundle is missing from the store', async () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c-3',
      target_swarm_id: 'swarm_a',
      initiator_type: 'user',
      initiator_id: agent.id,
      loadout_bundle_id: 'sha256:never-published',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/dispatches/${d.id}/loadout`,
      headers: { Authorization: `Bearer ${agent.apiKey}` },
    });
    expect(res.statusCode).toBe(410);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dispatches/disp_x/loadout',
    });
    expect(res.statusCode).toBe(401);
  });
});
