/**
 * Layer 2 tests for `src/openteams/seed.ts`.
 *
 * Pre-populates `syncable_resources` with authored team_template / loadout
 * rows, runs `seedOpenteamsBundleStore`, and asserts the in-memory store
 * holds bundles with matching content-addressed ids.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  bundleLoadout,
  resolveStandaloneLoadout,
  LOADOUT_RESOURCE_TYPE,
  TEAM_RESOURCE_TYPE,
} from 'openteams';
import type { LoadoutDefinition } from 'openteams';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createLoadout } from '../../db/dal/loadouts.js';
import { createTeamTemplate } from '../../db/dal/team-templates.js';
import { seedOpenteamsBundleStore } from '../../openteams/seed.js';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsBundleStore,
} from '../../openteams/map-handlers.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('openteams-seed');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'seed.db');

const LOADOUT_CONTENT: LoadoutContent = {
  name: 'seed-lo',
  capabilities: ['file.read', 'git.diff'],
  prompt_addendum: 'focus on security',
};

const TEAM_CONTENT: TeamTemplateContent = {
  manifest: {
    name: 'seed-team',
    version: 1,
    roles: ['root', 'worker'],
    topology: {
      root: { role: 'root' },
      spawn_rules: { root: ['worker'], worker: [] },
    },
  },
  roles: {
    root: { name: 'root' },
    worker: { name: 'worker' },
  },
};

describe('openteams seed', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'seed-agent',
      description: 'seed test',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase()
      .prepare(`DELETE FROM syncable_resources WHERE resource_type IN ('loadout', 'team_template')`)
      .run();
    _resetOpenteamsMapHandlers();
  });

  it('bundles loadout rows into the store', async () => {
    createLoadout({
      name: 'seed-lo',
      content: LOADOUT_CONTENT,
      ownerAgentId: agentId,
    });

    const result = await seedOpenteamsBundleStore();
    expect(result.loadouts).toBe(1);
    expect(result.errors).toEqual([]);

    // Verify the expected hash is in the store.
    const expected = bundleLoadout(
      resolveStandaloneLoadout(LOADOUT_CONTENT as LoadoutDefinition),
      { version: '0.0.0', name: 'seed-lo' },
    );
    const found = await getOpenteamsBundleStore().get(LOADOUT_RESOURCE_TYPE, expected.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(expected.id);
  });

  it('bundles team_template rows into the store', async () => {
    createTeamTemplate({
      name: 'seed-team',
      content: TEAM_CONTENT,
      ownerAgentId: agentId,
    });

    const result = await seedOpenteamsBundleStore();
    expect(result.teams).toBe(1);
    expect(result.errors).toEqual([]);

    const list = await getOpenteamsBundleStore().list(TEAM_RESOURCE_TYPE);
    expect(list.resources).toHaveLength(1);
    expect(list.resources[0].id).toMatch(/^sha256:/);
    expect(list.resources[0].name).toBe('seed-team');
  });

  it('handles a mixed batch and records per-row errors without throwing', async () => {
    createLoadout({
      name: 'seed-lo',
      content: LOADOUT_CONTENT,
      ownerAgentId: agentId,
    });
    createTeamTemplate({
      name: 'seed-team',
      content: TEAM_CONTENT,
      ownerAgentId: agentId,
    });

    // Inject a malformed team_template row that openteams's TemplateLoader
    // will reject (manifest.version is required to be 1). Seed should
    // collect the error and continue with the good rows.
    getDatabase()
      .prepare(
        `INSERT INTO syncable_resources (id, resource_type, name, git_remote_url, owner_agent_id, metadata)
         VALUES (?, 'team_template', 'bad-team', 'local://team_template/bad-team', ?, ?)`,
      )
      .run(
        'res_bad_team',
        agentId,
        JSON.stringify({ content: { manifest: { name: 'oops', roles: ['x'] } } }),
      );

    const result = await seedOpenteamsBundleStore();
    expect(result.loadouts).toBe(1);
    expect(result.teams).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].resource_id).toBe('res_bad_team');
  });

  it('skips rows whose metadata.content is missing', async () => {
    getDatabase()
      .prepare(
        `INSERT INTO syncable_resources (id, resource_type, name, git_remote_url, owner_agent_id, metadata)
         VALUES (?, 'loadout', 'no-content', 'local://loadout/no-content', ?, ?)`,
      )
      .run('res_no_content', agentId, JSON.stringify({}));

    const result = await seedOpenteamsBundleStore();
    expect(result.loadouts).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
