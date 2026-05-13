/**
 * Auto-bundle failure observability — gap C.
 *
 * Verifies that `onLoadoutBundle` / `onTeamTemplateBundle` capture failures
 * into the ring buffer rather than swallowing them silently, and that
 * `getOpenteamsBundleFailures()` reflects what's been recorded. The admin
 * endpoint test covers the wire surface; this file covers the bridge logic.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createTeamTemplate } from '../../db/dal/team-templates.js';
import { findResourceById } from '../../db/dal/syncable-resources.js';
import {
  _resetOpenteamsBundleFailures,
  getOpenteamsBundleFailures,
  onLoadoutBundle,
  onTeamTemplateBundle,
} from '../../openteams/sync-bridge.js';
import { _resetOpenteamsMapHandlers } from '../../openteams/map-handlers.js';
import type { SyncableResource } from '../../types.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('sync-bridge-failures');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'sync-bridge-failures.db');

const GOOD_TEAM: TeamTemplateContent = {
  manifest: {
    name: 'good-team',
    version: 1,
    roles: ['root'],
    topology: { root: { role: 'root' } },
  },
  roles: { root: { name: 'root' } },
};

describe('openteams sync-bridge failure observability', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'failures-agent',
      description: 'failures test',
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
    _resetOpenteamsBundleFailures();
    _resetOpenteamsMapHandlers();
  });

  it('happy path produces no failures', async () => {
    const row = createTeamTemplate({
      name: 'good-team',
      content: GOOD_TEAM,
      ownerAgentId: agentId,
    });
    const persisted = findResourceById(row.id)!;
    const id = await onTeamTemplateBundle(persisted);
    expect(id).toMatch(/^sha256:/);
    expect(getOpenteamsBundleFailures()).toEqual([]);
  });

  it('captures a bundle failure when the content is malformed', async () => {
    // Inject a team_template row whose manifest fails TemplateLoader.fromObject's
    // validation (missing `version` and `topology.root.role`).
    getDatabase()
      .prepare(
        `INSERT INTO syncable_resources (id, resource_type, name, git_remote_url, owner_agent_id, metadata)
         VALUES (?, 'team_template', 'bad-team', 'local://team_template/bad-team', ?, ?)`,
      )
      .run(
        'res_bad_team',
        agentId,
        JSON.stringify({ content: { manifest: { name: 'bad-team', roles: ['x'] } } }),
      );

    const row = findResourceById('res_bad_team');
    const id = await onTeamTemplateBundle(row!);
    expect(id).toBeNull();

    const failures = getOpenteamsBundleFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].resource_id).toBe('res_bad_team');
    expect(failures[0].resource_type).toBe('team_template');
    expect(failures[0].operation).toBe('bundle');
    expect(typeof failures[0].message).toBe('string');
    expect(failures[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns null without recording a failure when metadata.content is missing', async () => {
    // No `content` key in metadata — bridge skips silently (not an error).
    const row = {
      id: 'res_no_content',
      resource_type: 'loadout',
      name: 'no-content',
      metadata: {},
    } as unknown as SyncableResource;
    const id = await onLoadoutBundle(row);
    expect(id).toBeNull();
    expect(getOpenteamsBundleFailures()).toEqual([]);
  });

  it('ring buffer reset clears recorded failures', async () => {
    getDatabase()
      .prepare(
        `INSERT INTO syncable_resources (id, resource_type, name, git_remote_url, owner_agent_id, metadata)
         VALUES ('res_reset', 'team_template', 'bad-reset', 'local://team_template/bad-reset', ?, ?)`,
      )
      .run(agentId, JSON.stringify({ content: { manifest: { name: 'bad-reset' } } }));
    const row = findResourceById('res_reset');
    await onTeamTemplateBundle(row!);
    expect(getOpenteamsBundleFailures().length).toBe(1);
    _resetOpenteamsBundleFailures();
    expect(getOpenteamsBundleFailures()).toEqual([]);
  });
});
