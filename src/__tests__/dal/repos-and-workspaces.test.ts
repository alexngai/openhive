/**
 * DAL tests for repos + workspaces (slice 1 of the openhive consumer integration
 * for `agent-workspace/kinds/repo`).
 *
 * Exercises:
 * - V50 migration (resource_type CHECK extension; workspaces table; map_swarms.workspace_policy)
 * - Repo upsert idempotency keyed on canonical URL
 * - Workspace upsert idempotency keyed on (agent, repo, local_path)
 * - Bulk deactivate by agent / swarm
 * - List + find helpers
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as repos from '../../db/dal/repos.js';
import * as workspaces from '../../db/dal/workspaces.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('repos-workspaces-dal');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'repos-workspaces-dal.db');

const OWNER_ID = 'agent_owner';
const SWARM_ID = 'swarm_test';
const NODE_ID = 'node_test';

/** Insert minimal parent rows for FK satisfaction. */
function seedFixtures(): void {
  const db = getDatabase();
  // Agent (owner of repo resources).
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, name) VALUES (?, ?)
  `).run(OWNER_ID, 'Test Owner');
  // Map swarm.
  db.prepare(`
    INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, owner_agent_id, status)
    VALUES (?, ?, ?, ?, 'online')
  `).run(SWARM_ID, 'test-swarm', 'ws://localhost:0', OWNER_ID);
  // Map node.
  db.prepare(`
    INSERT OR IGNORE INTO map_nodes (id, swarm_id, map_agent_id, name)
    VALUES (?, ?, ?, ?)
  `).run(NODE_ID, SWARM_ID, 'agent_test', 'test-node');
}

describe('repos + workspaces DAL (slice 1)', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
    seedFixtures();
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    // Wipe child tables; keep fixtures.
    db.prepare('DELETE FROM workspaces').run();
    db.prepare(`DELETE FROM syncable_resources WHERE resource_type = 'repo'`).run();
  });

  // ── Repo DAL ───────────────────────────────────────────────────────────────

  describe('repos.upsertRepoByCanonicalUrl', () => {
    it('inserts a new repo when canonical URL is not present', () => {
      const identity = canonicalizeRepoUrl('https://github.com/foo/bar');
      const repo = repos.upsertRepoByCanonicalUrl(identity, {
        origin: 'user_defined',
        owner_agent_id: OWNER_ID,
      });
      expect(repo.id).toMatch(/^repo_/);
      expect(repo.resource_type).toBe('repo');
      expect(repo.git_remote_url).toBe('https://github.com/foo/bar');
      expect(repo.metadata).toMatchObject({
        name: 'bar',
        origin: 'user_defined',
        visibility: 'hub_local',
      });
    });

    it('returns the existing repo on duplicate canonical URL', () => {
      const identity = canonicalizeRepoUrl('https://github.com/foo/bar');
      const a = repos.upsertRepoByCanonicalUrl(identity, {
        origin: 'user_defined',
        owner_agent_id: OWNER_ID,
      });
      const b = repos.upsertRepoByCanonicalUrl(identity, {
        origin: 'agent_declared', // SHOULD NOT overwrite — origin is set once at creation
        owner_agent_id: OWNER_ID,
      });
      expect(b.id).toBe(a.id);
      // origin must NOT have been overwritten
      expect((b.metadata as { origin: string }).origin).toBe('user_defined');
    });

    it('treats SSH and HTTPS variants as the same repo', () => {
      const ssh = canonicalizeRepoUrl('git@github.com:Foo/Bar.git');
      const https = canonicalizeRepoUrl('https://github.com/foo/bar');
      const a = repos.upsertRepoByCanonicalUrl(ssh, {
        origin: 'user_defined',
        owner_agent_id: OWNER_ID,
      });
      const b = repos.upsertRepoByCanonicalUrl(https, {
        origin: 'agent_declared',
        owner_agent_id: OWNER_ID,
      });
      expect(b.id).toBe(a.id);
    });

    it('honors visibility default and explicit value', () => {
      const a = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/a'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      const b = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/b'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID, visibility: 'federated' },
      );
      expect((a.metadata as { visibility: string }).visibility).toBe('hub_local');
      expect((b.metadata as { visibility: string }).visibility).toBe('federated');
    });
  });

  describe('repos.findRepoByCanonicalUrl', () => {
    it('returns null when not found', () => {
      expect(repos.findRepoByCanonicalUrl('https://github.com/no/such')).toBeNull();
    });

    it('round-trips via canonical URL', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      const found = repos.findRepoByCanonicalUrl('https://github.com/foo/bar');
      expect(found?.id).toBe(repo.id);
    });
  });

  describe('repos.listRepos', () => {
    it('lists repos with origin filter', () => {
      repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/a'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/b'),
        { origin: 'agent_declared', owner_agent_id: OWNER_ID },
      );
      expect(repos.listRepos().length).toBe(2);
      expect(repos.listRepos({ origin: 'user_defined' }).length).toBe(1);
      expect(repos.listRepos({ origin: 'agent_declared' }).length).toBe(1);
    });

    it('filters by visibility', () => {
      repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/a'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID, visibility: 'private' },
      );
      repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/b'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID, visibility: 'federated' },
      );
      expect(repos.listRepos({ visibility: 'federated' }).length).toBe(1);
      expect(repos.listRepos({ visibility: 'private' }).length).toBe(1);
    });
  });

  describe('repos.updateRepoVisibility', () => {
    it('returns requires_redaction=true when going from federated to less-open', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID, visibility: 'federated' },
      );
      const result = repos.updateRepoVisibility(repo.id, 'hub_local');
      expect(result.requires_redaction).toBe(true);

      const updated = repos.findRepoById(repo.id);
      expect((updated!.metadata as { visibility: string }).visibility).toBe('hub_local');
    });

    it('returns requires_redaction=false when not from federated', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID, visibility: 'hub_local' },
      );
      const result = repos.updateRepoVisibility(repo.id, 'private');
      expect(result.requires_redaction).toBe(false);
    });

    it('is a no-op when visibility unchanged', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID, visibility: 'hub_local' },
      );
      const result = repos.updateRepoVisibility(repo.id, 'hub_local');
      expect(result.requires_redaction).toBe(false);
    });
  });

  // ── Workspaces DAL ─────────────────────────────────────────────────────────

  describe('workspaces.upsertWorkspace', () => {
    it('creates a new binding on first call', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      const ws = workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/bar',
        current_branch: 'main',
        head_sha: 'abc123',
      });
      expect(ws.id).toMatch(/^ws_/);
      expect(ws.is_active).toBe(1);
      expect(ws.dirty).toBe(0);
      expect(ws.visibility).toBe('hub_local');
      expect(ws.current_branch).toBe('main');
    });

    it('idempotent on (agent_id, repo_id, local_path) — updates in place', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      const a = workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/bar',
        visibility: 'hub_local',
        instance_label: 'old',
      });
      const b = workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/bar',
        visibility: 'federated',
        instance_label: 'new',
      });
      expect(b.id).toBe(a.id);
      expect(b.visibility).toBe('federated');
      expect(b.instance_label).toBe('new');
    });

    it('different local_paths are separate bindings', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      const a = workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/bar1',
      });
      const b = workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/bar2',
      });
      expect(a.id).not.toBe(b.id);
      expect(workspaces.listWorkspacesForAgent(NODE_ID).length).toBe(2);
    });

    it('reactivates a previously deactivated binding', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/bar',
      });
      workspaces.deactivateWorkspacesByAgent(NODE_ID);
      const ws = workspaces.findWorkspace(repo.id, NODE_ID, '/tmp/bar')!;
      expect(ws.is_active).toBe(0);

      // Re-attach
      workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/bar',
      });
      const re = workspaces.findWorkspace(repo.id, NODE_ID, '/tmp/bar')!;
      expect(re.is_active).toBe(1);
    });

    it('translates dirty boolean to 0/1 column value', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      const clean = workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/clean',
        dirty: false,
      });
      const dirty = workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/dirty',
        dirty: true,
      });
      expect(clean.dirty).toBe(0);
      expect(dirty.dirty).toBe(1);
    });
  });

  describe('workspaces — bulk deactivate', () => {
    it('deactivateWorkspacesByAgent flips is_active on owner agent only', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/a',
      });
      workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/b',
      });

      const count = workspaces.deactivateWorkspacesByAgent(NODE_ID);
      expect(count).toBe(2);
      expect(workspaces.listWorkspacesForAgent(NODE_ID).length).toBe(0);
      expect(workspaces.listWorkspacesForAgent(NODE_ID, { activeOnly: false }).length).toBe(2);
    });

    it('deactivateWorkspacesBySwarm cascades all bindings in the swarm', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/a',
      });

      const count = workspaces.deactivateWorkspacesBySwarm(SWARM_ID);
      expect(count).toBe(1);
    });

    it('returns 0 when nothing to deactivate', () => {
      expect(workspaces.deactivateWorkspacesByAgent(NODE_ID)).toBe(0);
      expect(workspaces.deactivateWorkspacesBySwarm(SWARM_ID)).toBe(0);
    });
  });

  describe('workspaces — list + find helpers', () => {
    it('listWorkspacesForRepo respects activeOnly default', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/bar',
      });
      workspaces.deactivateWorkspacesByAgent(NODE_ID);
      expect(workspaces.listWorkspacesForRepo(repo.id).length).toBe(0);
      expect(workspaces.listWorkspacesForRepo(repo.id, { activeOnly: false }).length).toBe(1);
    });

    it('findWorkspace returns null when no match', () => {
      expect(workspaces.findWorkspace('repo_x', NODE_ID, '/none')).toBeNull();
    });
  });

  describe('workspaces — visibility updates + delete', () => {
    it('updateWorkspaceVisibility narrows a single binding', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/bar',
        visibility: 'federated',
      });
      const updated = workspaces.updateWorkspaceVisibility(repo.id, NODE_ID, '/tmp/bar', 'private');
      expect(updated?.visibility).toBe('private');
    });

    it('updateAllAgentWorkspacesVisibility sweeps all bindings for the agent on a repo', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/a',
        visibility: 'federated',
      });
      workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/b',
        visibility: 'hub_local',
      });

      const count = workspaces.updateAllAgentWorkspacesVisibility(repo.id, NODE_ID, 'private');
      expect(count).toBe(2);
      expect(workspaces.listWorkspacesForAgent(NODE_ID).every((w) => w.visibility === 'private')).toBe(true);
    });

    it('deleteWorkspace removes a binding permanently', () => {
      const repo = repos.upsertRepoByCanonicalUrl(
        canonicalizeRepoUrl('https://github.com/foo/bar'),
        { origin: 'user_defined', owner_agent_id: OWNER_ID },
      );
      workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: NODE_ID,
        swarm_id: SWARM_ID,
        local_path: '/tmp/bar',
      });
      expect(workspaces.deleteWorkspace(repo.id, NODE_ID, '/tmp/bar')).toBe(true);
      expect(workspaces.findWorkspace(repo.id, NODE_ID, '/tmp/bar')).toBeNull();
    });

    it('deleteWorkspace returns false when nothing to delete', () => {
      expect(workspaces.deleteWorkspace('repo_x', NODE_ID, '/none')).toBe(false);
    });
  });
});
