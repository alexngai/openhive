/**
 * Layer 7 — cross-instance bundle fetch.
 *
 * Mesh sync replicates `syncable_resources` rows (with `origin_instance_id`
 * pointing at the peer that authored them) without putting the bundle into
 * the local openteams store. When an agent then asks for that bundle by
 * `sha256:<hex>` over MAP `map/resources/get`, the bundle store should fall
 * through to the cross-instance resolver: scan replicated rows from
 * trusted peers, rebundle from their content, and serve the first hash
 * match.
 *
 * These tests don't exercise a real git clone — they cover the resolver's
 * orchestration: row scan, trust gate, hash gate, store caching, and the
 * teardown of the singleton. The git-clone branch is exercised by
 * Layer 6's `git-backed-bundle-e2e.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LOADOUT_RESOURCE_TYPE, TEAM_RESOURCE_TYPE } from 'openteams';
import { nanoid } from 'nanoid';

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as instancesDAL from '../../db/dal/instances.js';
import {
  getOpenteamsBundleStore,
  _resetOpenteamsMapHandlers,
} from '../../openteams/map-handlers.js';
import {
  bundleLoadoutContent,
  bundleTeamTemplateContent,
} from '../../openteams/internal/bundle-content.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('openteams-cross-instance');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'cross-instance.db');

const LOADOUT_CONTENT = {
  name: 'remote-lo',
  capabilities: ['file.read'],
  permissions: { deny: ['Bash(rm:*)'] },
  prompt_addendum: 'be precise',
};

const TEAM_CONTENT = {
  manifest: {
    name: 'remote-team',
    version: 1 as const,
    roles: ['root'],
    topology: { root: { role: 'root' } },
  },
  roles: { root: { name: 'root', capabilities: ['plan'] } },
};

/**
 * Insert a replicated syncable_resources row as if the mesh materializer
 * just landed it from a peer. Mirrors `materializeResourcePublished`'s
 * write (sync_strategy left at the schema default 'metadata').
 */
function insertReplicatedRow(opts: {
  resourceType: 'loadout' | 'team_template';
  name: string;
  ownerAgentId: string;
  originInstanceId: string;
  content: unknown;
  gitRemoteUrl?: string;
}): string {
  const id = `rr_${nanoid()}`;
  const metadata = JSON.stringify({ content: opts.content });
  const gitRemoteUrl =
    opts.gitRemoteUrl ?? `local://${opts.resourceType}/${opts.name}`;
  getDatabase()
    .prepare(
      `INSERT INTO syncable_resources
        (id, resource_type, name, git_remote_url, visibility, owner_agent_id,
         metadata, origin_instance_id, origin_resource_id, created_at)
       VALUES (?, ?, ?, ?, 'shared', ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      id,
      opts.resourceType,
      opts.name,
      gitRemoteUrl,
      opts.ownerAgentId,
      metadata,
      opts.originInstanceId,
      `origin_${opts.name}`,
    );
  return id;
}

describe('openteams cross-instance resolver (Layer 7)', () => {
  let agentId: string;
  let trustedInstanceId: string;
  let untrustedInstanceId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'cross-instance-owner',
      description: 'Layer 7 tests',
    });
    agentId = agent.id;

    const trusted = instancesDAL.createInstance({
      url: 'https://trusted.example.invalid',
      name: 'trusted-peer',
      is_trusted: true,
    });
    trustedInstanceId = trusted.id;

    const untrusted = instancesDAL.createInstance({
      url: 'https://untrusted.example.invalid',
      name: 'untrusted-peer',
      is_trusted: false,
    });
    untrustedInstanceId = untrusted.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    // Wipe replicated rows + reset the singleton bundle store so each
    // test starts from an empty in-memory store.
    getDatabase()
      .prepare(
        `DELETE FROM syncable_resources WHERE resource_type IN ('loadout', 'team_template')`,
      )
      .run();
    _resetOpenteamsMapHandlers();
  });

  it('loadout: store miss + trusted peer + matching hash → resolver fills the store', async () => {
    const expected = bundleLoadoutContent('remote-lo', LOADOUT_CONTENT);
    insertReplicatedRow({
      resourceType: 'loadout',
      name: 'remote-lo',
      ownerAgentId: agentId,
      originInstanceId: trustedInstanceId,
      content: LOADOUT_CONTENT,
    });

    const store = getOpenteamsBundleStore();
    const got = await store.get(LOADOUT_RESOURCE_TYPE, expected.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(expected.id);

    // Second fetch: same id, served from the in-memory store (fast path).
    // We can't directly observe the cache hit, but the result must be
    // identical and not throw if the row were now removed.
    getDatabase()
      .prepare(`DELETE FROM syncable_resources WHERE resource_type = 'loadout'`)
      .run();
    const cached = await store.get(LOADOUT_RESOURCE_TYPE, expected.id);
    expect(cached).not.toBeNull();
    expect(cached!.id).toBe(expected.id);
  });

  it('team_template: store miss + trusted peer → resolver lazy-bundles + caches', async () => {
    const expected = bundleTeamTemplateContent('remote-team', TEAM_CONTENT);
    insertReplicatedRow({
      resourceType: 'team_template',
      name: 'remote-team',
      ownerAgentId: agentId,
      originInstanceId: trustedInstanceId,
      content: TEAM_CONTENT,
    });

    const store = getOpenteamsBundleStore();
    const got = await store.get(TEAM_RESOURCE_TYPE, expected.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(expected.id);
  });

  it('skips rows from untrusted peers (trust gate)', async () => {
    const expected = bundleLoadoutContent('remote-lo', LOADOUT_CONTENT);
    insertReplicatedRow({
      resourceType: 'loadout',
      name: 'remote-lo',
      ownerAgentId: agentId,
      originInstanceId: untrustedInstanceId,
      content: LOADOUT_CONTENT,
    });

    const got = await getOpenteamsBundleStore().get(
      LOADOUT_RESOURCE_TYPE,
      expected.id,
    );
    expect(got).toBeNull();
  });

  it('returns null on hash mismatch (post-bundle integrity gate)', async () => {
    // Row carries the real content — but we ask for a *different* hash.
    insertReplicatedRow({
      resourceType: 'loadout',
      name: 'remote-lo',
      ownerAgentId: agentId,
      originInstanceId: trustedInstanceId,
      content: LOADOUT_CONTENT,
    });

    const got = await getOpenteamsBundleStore().get(
      LOADOUT_RESOURCE_TYPE,
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    );
    expect(got).toBeNull();
  });

  it('ignores rows whose origin_instance_id is unknown (no federated_instances row)', async () => {
    const expected = bundleLoadoutContent('remote-lo', LOADOUT_CONTENT);
    insertReplicatedRow({
      resourceType: 'loadout',
      name: 'remote-lo',
      ownerAgentId: agentId,
      originInstanceId: 'inst_unknown_phantom',
      content: LOADOUT_CONTENT,
    });

    const got = await getOpenteamsBundleStore().get(
      LOADOUT_RESOURCE_TYPE,
      expected.id,
    );
    expect(got).toBeNull();
  });

  it('skips locally-authored rows (origin_instance_id NULL)', async () => {
    // Insert a local row (no origin) — cross-instance resolver must not
    // consider it. (Local rows are served by the seed/sync-bridge path.)
    getDatabase()
      .prepare(
        `INSERT INTO syncable_resources
          (id, resource_type, name, git_remote_url, visibility, owner_agent_id, metadata, created_at)
         VALUES (?, 'loadout', 'local-lo', 'local://loadout/local-lo', 'private', ?, ?, datetime('now'))`,
      )
      .run(`rr_${nanoid()}`, agentId, JSON.stringify({ content: LOADOUT_CONTENT }));

    const expected = bundleLoadoutContent('local-lo', LOADOUT_CONTENT);
    const got = await getOpenteamsBundleStore().get(
      LOADOUT_RESOURCE_TYPE,
      expected.id,
    );
    // The cross-instance resolver only considers replicated rows, so we
    // expect a miss. Local rows would normally have already been put into
    // the store by `seed.ts` or `sync-bridge.ts`.
    expect(got).toBeNull();
  });
});
