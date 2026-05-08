/**
 * Tests for x-workspace/repo.bindings handler (OpenHiveRepoHandler.onBindings).
 *
 * Covers: binding visibility scoping, federated peer enumeration, missing repo,
 * empty bindings, owner-sees-own-private.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { OpenHiveRepoHandler } from '../../map/workspace-handler.js';
import * as repos from '../../db/dal/repos.js';
import * as workspaces from '../../db/dal/workspaces.js';
import { ensureNodeWithId } from '../../db/dal/map.js';
import type { RepoHandlerContext } from 'agent-workspace/kinds/repo';

const TEST_ROOT = testRoot('workspace-bindings');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'workspace-bindings.db');

const AGENT_A = 'node_agent_a';
const AGENT_B = 'node_agent_b';
const SWARM_ID = 'swarm_test';
const OTHER_SWARM = 'swarm_other';
const OWNER_AGENT = 'agent_owner';

const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_AGENT });

function ctx(agentId: string, swarmId: string = SWARM_ID): RepoHandlerContext {
  return { agentId, swarmId };
}

function seedSwarm(id: string, ownerAgentId: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, status, owner_agent_id, created_at, updated_at)
    VALUES (?, ?, ?, 'online', ?, datetime('now'), datetime('now'))
  `).run(id, id, `ws://localhost/${id}`, ownerAgentId);
}

function seedAgent(id: string): void {
  const db = getDatabase();
  db.prepare('INSERT OR IGNORE INTO agents (id, name) VALUES (?, ?)').run(id, id);
}

function seedNode(id: string, swarmId: string): void {
  ensureNodeWithId({ id, swarm_id: swarmId, map_agent_id: id });
}

function seedRepoResource(
  canonicalUrl: string,
  metaVisibility: 'private' | 'hub_local' | 'federated' = 'hub_local',
): string {
  const repo = repos.upsertRepoByCanonicalUrl(
    { canonicalUrl, host: 'github.com', owner: 'test', name: 'repo' },
    { origin: 'user_defined', visibility: metaVisibility, owner_agent_id: OWNER_AGENT },
  );
  return repo.id;
}

function seedWorkspace(
  repoId: string,
  agentId: string,
  localPath: string,
  swarmId: string = SWARM_ID,
  visibility: 'private' | 'hub_local' | 'federated' = 'hub_local',
): void {
  workspaces.upsertWorkspace({
    repo_id: repoId,
    agent_id: agentId,
    swarm_id: swarmId,
    local_path: localPath,
    visibility,
  });
}

function seedFederatedResource(
  repoId: string,
  originInstanceId: string,
): void {
  const db = getDatabase();
  // Read the actual stored git_remote_url from the local repo resource
  const repo = db.prepare(
    'SELECT git_remote_url FROM syncable_resources WHERE id = ?',
  ).get(repoId) as { git_remote_url: string } | undefined;
  if (!repo) throw new Error(`seedFederatedResource: repo ${repoId} not found`);

  const now = new Date().toISOString();
  const id = `sr_fed_${originInstanceId}`;
  const fedOwner = `agent_fed_${originInstanceId}`;
  db.prepare('INSERT OR IGNORE INTO agents (id, name) VALUES (?, ?)').run(fedOwner, fedOwner);
  db.prepare(`
    INSERT INTO syncable_resources
    (id, resource_type, name, description, git_remote_url, visibility, owner_agent_id,
     scope, sync_strategy, metadata, created_at, updated_at, status,
     origin_instance_id, origin_resource_id)
    VALUES (?, 'repo', ?, '', ?, 'private', ?,
     'manual', 'metadata', '{}', ?, ?, 'active', ?, ?)
  `).run(id, `fed-repo-${originInstanceId}`, repo.git_remote_url, fedOwner, now, now, originInstanceId, `remote_${id}`);
}

function seedSyncPeer(instanceId: string, endpoint: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO hive_sync_peers
    (id, sync_group_id, peer_swarm_id, peer_endpoint, peer_instance_id, status)
    VALUES (?, 'default_group', ?, ?, ?, 'active')
  `).run(`peer_${instanceId}`, `swarm_${instanceId}`, endpoint, instanceId);
}

describe('OpenHiveRepoHandler.onBindings', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
    seedAgent(OWNER_AGENT);
    seedSwarm(SWARM_ID, OWNER_AGENT);
    seedSwarm(OTHER_SWARM, OWNER_AGENT);
    seedNode(AGENT_A, SWARM_ID);
    seedNode(AGENT_B, OTHER_SWARM);

    // Temporarily disable FK checks to seed sync infrastructure for federated peer tests
    const db = getDatabase();
    db.pragma('foreign_keys = OFF');
    db.prepare(`
      INSERT OR IGNORE INTO hive_sync_groups (id, hive_id, sync_group_name, instance_signing_key, instance_signing_key_private, created_at)
      VALUES ('default_group', 'test_hive', 'default', 'test_key', 'test_priv_key', datetime('now'))
    `).run();
    db.pragma('foreign_keys = ON');
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM workspaces').run();
    db.prepare('DELETE FROM syncable_resources').run();
  });

  it('returns bindings for a repo', async () => {
    const repoId = seedRepoResource('https://github.com/test/repo');
    seedWorkspace(repoId, AGENT_A, '/home/a/repo');

    const result = await handler.onBindings(
      { canonical_url: 'https://github.com/test/repo' },
      ctx(AGENT_A),
    );

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].agent_id).toBe(AGENT_A);
    expect(result.bindings[0].workspace_id).toBeDefined();
    expect(result.bindings[0].local_path).toBe('/home/a/repo');
    expect(result.bindings[0].visibility).toBe('hub_local');
    expect(result.bindings[0].declared_at).toBeDefined();
  });

  it('returns empty for unknown repo', async () => {
    const result = await handler.onBindings(
      { canonical_url: 'https://github.com/nonexistent/repo' },
      ctx(AGENT_A),
    );

    expect(result.bindings).toHaveLength(0);
    expect(result.federated_peers).toHaveLength(0);
  });

  it('hides private bindings from non-owner', async () => {
    const repoId = seedRepoResource('https://github.com/test/repo');
    seedWorkspace(repoId, AGENT_A, '/home/a/repo', SWARM_ID, 'private');

    const result = await handler.onBindings(
      { canonical_url: 'https://github.com/test/repo' },
      ctx(AGENT_B, OTHER_SWARM),
    );

    expect(result.bindings).toHaveLength(0);
  });

  it('owner sees own private bindings', async () => {
    const repoId = seedRepoResource('https://github.com/test/repo');
    seedWorkspace(repoId, AGENT_A, '/home/a/repo', SWARM_ID, 'private');

    const result = await handler.onBindings(
      { canonical_url: 'https://github.com/test/repo' },
      ctx(AGENT_A),
    );

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].agent_id).toBe(AGENT_A);
  });

  it('hub_local bindings hidden from other swarms', async () => {
    const repoId = seedRepoResource('https://github.com/test/repo');
    seedWorkspace(repoId, AGENT_A, '/home/a/repo', SWARM_ID, 'hub_local');

    const result = await handler.onBindings(
      { canonical_url: 'https://github.com/test/repo' },
      ctx(AGENT_B, OTHER_SWARM),
    );

    expect(result.bindings).toHaveLength(0);
  });

  it('returns multiple bindings from different agents', async () => {
    const repoId = seedRepoResource('https://github.com/test/repo');
    seedNode(AGENT_B, SWARM_ID); // put B in same swarm for visibility
    seedWorkspace(repoId, AGENT_A, '/home/a/repo', SWARM_ID, 'hub_local');
    seedWorkspace(repoId, AGENT_B, '/home/b/repo', SWARM_ID, 'hub_local');

    const result = await handler.onBindings(
      { canonical_url: 'https://github.com/test/repo' },
      ctx(AGENT_A),
    );

    expect(result.bindings).toHaveLength(2);
    const agentIds = result.bindings.map((b) => b.agent_id).sort();
    expect(agentIds).toEqual([AGENT_A, AGENT_B]);
  });

  it('populates federated_peers from origin_instance_id', async () => {
    const canonicalUrl = 'https://github.com/test/fed-repo';
    const repoId = seedRepoResource(canonicalUrl);
    seedFederatedResource(repoId, 'instance_peer_1');
    seedSyncPeer('instance_peer_1', 'https://peer1.example.com/sync/v1');

    const result = await handler.onBindings(
      { canonical_url: canonicalUrl },
      ctx(AGENT_A),
    );

    expect(result.federated_peers).toHaveLength(1);
    expect(result.federated_peers[0].hub_id).toBe('instance_peer_1');
    expect(result.federated_peers[0].hub_url).toBe('https://peer1.example.com/sync/v1');
  });

  it('returns empty federated_peers when no federation', async () => {
    const canonicalUrl = 'https://github.com/test/local-only';
    seedRepoResource(canonicalUrl);

    const result = await handler.onBindings(
      { canonical_url: canonicalUrl },
      ctx(AGENT_A),
    );

    expect(result.federated_peers).toHaveLength(0);
  });

  it('returns empty bindings when repo exists but has no workspaces', async () => {
    seedRepoResource('https://github.com/test/empty');

    const result = await handler.onBindings(
      { canonical_url: 'https://github.com/test/empty' },
      ctx(AGENT_A),
    );

    expect(result.bindings).toHaveLength(0);
    expect(result.federated_peers).toHaveLength(0);
  });
});
