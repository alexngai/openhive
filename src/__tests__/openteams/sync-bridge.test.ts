/**
 * Layer 2 tests for `src/openteams/sync-bridge.ts`.
 *
 * Verifies that REST writes (POST/PATCH/DELETE on /teams + /loadouts)
 * keep the openteams bundle store in sync. End-to-end through Fastify so
 * the wiring inside the route handlers is exercised.
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
  LOADOUT_RESOURCE_TYPE,
} from 'openteams';
import type { LoadoutDefinition } from 'openteams';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { teamsRoutes } from '../../api/routes/teams.js';
import { loadoutsRoutes } from '../../api/routes/loadouts.js';
import { ConfigSchema, type Config } from '../../config.js';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsBundleStore,
} from '../../openteams/map-handlers.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('openteams-sync-bridge');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'sync-bridge.db');

const LOADOUT_CONTENT = {
  name: 'bridge-lo',
  capabilities: ['file.read'],
  prompt_addendum: 'go slow',
};

const TEAM_CONTENT = {
  manifest: {
    name: 'bridge-team',
    version: 1 as const,
    roles: ['root'],
    topology: { root: { role: 'root' } },
  },
  roles: { root: { name: 'root' } },
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
      await api.register(teamsRoutes, { config });
      await api.register(loadoutsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

/** Wait briefly for the fire-and-forget bundle hooks to finish. */
async function flushBundleQueue(): Promise<void> {
  // Two microtask flushes cover the chained async store.put.
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

describe('openteams sync-bridge', () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());
    const a = await agentsDAL.createAgent({
      name: 'bridge-agent',
      description: 'bridge test',
    });
    agent = { id: a.agent.id, apiKey: a.apiKey };
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase()
      .prepare(`DELETE FROM syncable_resources WHERE resource_type IN ('loadout', 'team_template')`)
      .run();
    _resetOpenteamsMapHandlers();
  });

  it('POST /loadouts puts the bundle into the store with the expected hash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/loadouts',
      headers: { Authorization: `Bearer ${agent.apiKey}` },
      payload: { name: 'bridge-lo', content: LOADOUT_CONTENT, visibility: 'shared' },
    });
    expect(res.statusCode).toBe(201);

    await flushBundleQueue();

    const expected = bundleLoadout(
      resolveStandaloneLoadout(LOADOUT_CONTENT as LoadoutDefinition),
      { version: '0.0.0', name: 'bridge-lo' },
    );
    const stored = await getOpenteamsBundleStore().get(
      LOADOUT_RESOURCE_TYPE,
      expected.id,
    );
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(expected.id);
  });

  it('PATCH /loadouts/:id puts the updated bundle (new hash) into the store', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/loadouts',
      headers: { Authorization: `Bearer ${agent.apiKey}` },
      payload: { name: 'updatable-lo', content: LOADOUT_CONTENT },
    });
    const id = JSON.parse(create.body).loadout.id;
    await flushBundleQueue();

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/loadouts/${id}`,
      headers: { Authorization: `Bearer ${agent.apiKey}` },
      payload: {
        content: { ...LOADOUT_CONTENT, prompt_addendum: 'go faster' },
      },
    });
    expect(updated.statusCode).toBe(200);
    await flushBundleQueue();

    // The new content hashes to a different id.
    const newExpected = bundleLoadout(
      resolveStandaloneLoadout({ ...LOADOUT_CONTENT, prompt_addendum: 'go faster' } as LoadoutDefinition),
      { version: '0.0.0', name: 'updatable-lo' },
    );
    const stored = await getOpenteamsBundleStore().get(LOADOUT_RESOURCE_TYPE, newExpected.id);
    expect(stored).not.toBeNull();
  });

  it('DELETE /loadouts/:id removes the bundle from the store', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/loadouts',
      headers: { Authorization: `Bearer ${agent.apiKey}` },
      payload: { name: 'doomed-lo', content: LOADOUT_CONTENT },
    });
    const id = JSON.parse(create.body).loadout.id;
    await flushBundleQueue();

    const expected = bundleLoadout(
      resolveStandaloneLoadout(LOADOUT_CONTENT as LoadoutDefinition),
      { version: '0.0.0', name: 'doomed-lo' },
    );
    expect(await getOpenteamsBundleStore().get(LOADOUT_RESOURCE_TYPE, expected.id)).not.toBeNull();

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/loadouts/${id}`,
      headers: { Authorization: `Bearer ${agent.apiKey}` },
    });
    expect(del.statusCode).toBe(204);
    await flushBundleQueue();

    expect(await getOpenteamsBundleStore().get(LOADOUT_RESOURCE_TYPE, expected.id)).toBeNull();
  });

  it('POST /teams puts a team bundle into the store', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: { Authorization: `Bearer ${agent.apiKey}` },
      payload: { name: 'bridge-team', content: TEAM_CONTENT },
    });
    expect(res.statusCode).toBe(201);
    await flushBundleQueue();

    const list = await getOpenteamsBundleStore().list('x-openteams/team');
    expect(list.resources.length).toBeGreaterThan(0);
    expect(list.resources[0].name).toBe('bridge-team');
  });
});
