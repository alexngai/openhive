/**
 * Tests for `OpenHiveRepoHandler` — the openhive consumer-side adapter
 * around `agent-workspace/kinds/repo`'s `RepoProtocolHandler` interface.
 *
 * Exercises the four method handlers end-to-end:
 *   onDeclare → DAL persistence + lifecycle event
 *   onChanged → added/removed
 *   onList    → visibility filter (private = owner-only)
 *   onRetract → narrow to private + lifecycle event
 *
 * Realtime broadcast is mocked at the module boundary so we can assert
 * which events fired.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import type { RepoHandlerContext } from 'agent-workspace/kinds/repo';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { broadcastToChannel } from '../../realtime/index.js';
import { OpenHiveRepoHandler } from '../../map/workspace-handler.js';
import * as repos from '../../db/dal/repos.js';
import * as workspaces from '../../db/dal/workspaces.js';

const TEST_ROOT = testRoot('workspace-handler');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'workspace-handler.db');
const mockedBroadcast = vi.mocked(broadcastToChannel);

const OWNER_ID = 'agent_owner';
const SWARM_ID = 'swarm_test';
const NODE_ID = 'node_test';
const NODE_ID_2 = 'node_test_2';

const ctxA: RepoHandlerContext = { agentId: NODE_ID, swarmId: SWARM_ID };
const ctxB: RepoHandlerContext = { agentId: NODE_ID_2, swarmId: SWARM_ID };

function seedFixtures(): void {
  const db = getDatabase();
  db.prepare('INSERT OR IGNORE INTO agents (id, name) VALUES (?, ?)')
    .run(OWNER_ID, 'Test Owner');
  db.prepare(
    `INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, owner_agent_id, status)
     VALUES (?, ?, ?, ?, 'online')`,
  ).run(SWARM_ID, 'test-swarm', 'ws://localhost:0', OWNER_ID);
  db.prepare(
    `INSERT OR IGNORE INTO map_nodes (id, swarm_id, map_agent_id, name)
     VALUES (?, ?, ?, ?)`,
  ).run(NODE_ID, SWARM_ID, 'agent_test', 'test-node');
  db.prepare(
    `INSERT OR IGNORE INTO map_nodes (id, swarm_id, map_agent_id, name)
     VALUES (?, ?, ?, ?)`,
  ).run(NODE_ID_2, SWARM_ID, 'agent_test_2', 'test-node-2');
}

describe('OpenHiveRepoHandler', () => {
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
    db.prepare('DELETE FROM workspaces').run();
    db.prepare(`DELETE FROM syncable_resources WHERE resource_type = 'repo'`).run();
    mockedBroadcast.mockClear();
  });

  // ── onDeclare ──────────────────────────────────────────────────────────────

  describe('onDeclare', () => {
    it('upserts a repo + workspace and broadcasts workspace_added', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onDeclare({
        workspaces: [{
          remote_url: 'https://github.com/foo/bar',
          local_path: '/tmp/bar',
          current_branch: 'main',
        }],
      }, ctxA);

      const repo = repos.findRepoByCanonicalUrl('https://github.com/foo/bar');
      expect(repo).not.toBeNull();
      expect(workspaces.listWorkspacesForAgent(NODE_ID).length).toBe(1);

      const broadcasts = mockedBroadcast.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === 'workspace_added',
      );
      expect(broadcasts.length).toBe(2);
      const channels = broadcasts.map((c) => c[0]);
      expect(channels).toContain('map:repos');
      expect(channels).toContain(`map:repo:${repo!.id}`);
    });

    it('canonicalizes raw URLs (SSH ↔ HTTPS land on the same repo)', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onDeclare({
        workspaces: [{ remote_url: 'git@github.com:Foo/Bar.git', local_path: '/tmp/bar' }],
      }, ctxA);
      await handler.onDeclare({
        workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar2' }],
      }, ctxA);

      // Both bindings point to the same canonical repo.
      const repo = repos.findRepoByCanonicalUrl('https://github.com/foo/bar');
      expect(repo).not.toBeNull();
      expect(repos.listRepos().length).toBe(1);
      expect(workspaces.listWorkspacesForRepo(repo!.id).length).toBe(2);
    });

    it('falls back to swarm owner when no defaultOwnerAgentId is configured', async () => {
      // ctx.agentId is map_nodes.id (per workspaces FK), not agents.id.
      // The handler resolves repo owner via the swarm's owner_agent_id row.
      const handler = new OpenHiveRepoHandler();
      await handler.onDeclare({
        workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      }, ctxA);

      const repo = repos.findRepoByCanonicalUrl('https://github.com/foo/bar');
      // SWARM_ID was seeded with owner_agent_id = OWNER_ID.
      expect(repo!.owner_agent_id).toBe(OWNER_ID);
    });

    it('idempotent — re-declare returns the same workspace row with updated metadata', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onDeclare({
        workspaces: [{
          remote_url: 'https://github.com/foo/bar',
          local_path: '/tmp/bar',
          visibility: 'hub_local',
          instance_label: 'old',
        }],
      }, ctxA);
      await handler.onDeclare({
        workspaces: [{
          remote_url: 'https://github.com/foo/bar',
          local_path: '/tmp/bar',
          visibility: 'federated',
          instance_label: 'new',
        }],
      }, ctxA);

      const repo = repos.findRepoByCanonicalUrl('https://github.com/foo/bar')!;
      const bindings = workspaces.listWorkspacesForRepo(repo.id);
      expect(bindings.length).toBe(1);
      expect(bindings[0]!.visibility).toBe('federated');
      expect(bindings[0]!.instance_label).toBe('new');
    });
  });

  // ── onChanged ──────────────────────────────────────────────────────────────

  describe('onChanged', () => {
    it('added entries route through onDeclare', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onChanged({
        added: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      }, ctxA);
      expect(workspaces.listWorkspacesForAgent(NODE_ID).length).toBe(1);
    });

    it('removed entries delete bindings and emit workspace_deactivated', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onDeclare({
        workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      }, ctxA);
      mockedBroadcast.mockClear();

      await handler.onChanged({
        removed: [{ canonical_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      }, ctxA);

      expect(workspaces.listWorkspacesForAgent(NODE_ID, { activeOnly: false }).length).toBe(0);
      const deactivated = mockedBroadcast.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === 'workspace_deactivated',
      );
      expect(deactivated.length).toBe(2); // fan-out
    });

    it('removed only affects the calling agent\'s bindings', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onDeclare({
        workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      }, ctxA);
      await handler.onDeclare({
        workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      }, ctxB);

      await handler.onChanged({
        removed: [{ canonical_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      }, ctxA);

      const repo = repos.findRepoByCanonicalUrl('https://github.com/foo/bar')!;
      const remaining = workspaces.listWorkspacesForRepo(repo.id);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.agent_id).toBe(NODE_ID_2);
    });

    it('removed for a non-existent repo is a no-op (no throw)', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await expect(
        handler.onChanged({
          removed: [{ canonical_url: 'https://github.com/no/such', local_path: '/tmp/x' }],
        }, ctxA),
      ).resolves.not.toThrow();
    });
  });

  // ── onList ─────────────────────────────────────────────────────────────────

  describe('onList', () => {
    it('returns wire-shape entries for visible bindings', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onDeclare({
        workspaces: [{
          remote_url: 'https://github.com/foo/bar',
          local_path: '/tmp/bar',
          current_branch: 'main',
        }],
      }, ctxA);

      const result = await handler.onList({}, ctxA);
      expect(result.workspaces.length).toBe(1);
      expect(result.workspaces[0]).toMatchObject({
        remote_url: 'https://github.com/foo/bar',
        local_path: '/tmp/bar',
        current_branch: 'main',
        visibility: 'hub_local',
      });
    });

    it('private bindings are visible only to the owner agent', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      // Agent A declares a private binding
      await handler.onDeclare({
        workspaces: [{
          remote_url: 'https://github.com/foo/bar',
          local_path: '/tmp/a',
          visibility: 'private',
        }],
      }, ctxA);
      // Agent B declares a hub_local binding for the same repo
      await handler.onDeclare({
        workspaces: [{
          remote_url: 'https://github.com/foo/bar',
          local_path: '/tmp/b',
          visibility: 'hub_local',
        }],
      }, ctxB);

      // A sees both
      const aResult = await handler.onList({}, ctxA);
      expect(aResult.workspaces.length).toBe(2);

      // B sees only their own (A's private is filtered out)
      const bResult = await handler.onList({}, ctxB);
      expect(bResult.workspaces.length).toBe(1);
      expect(bResult.workspaces[0]!.local_path).toBe('/tmp/b');
    });

    it('respects canonical_url filter', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onDeclare({
        workspaces: [
          { remote_url: 'https://github.com/foo/a', local_path: '/tmp/a' },
          { remote_url: 'https://github.com/foo/b', local_path: '/tmp/b' },
        ],
      }, ctxA);

      const result = await handler.onList({
        filter: { canonical_url: 'https://github.com/foo/a' },
      }, ctxA);
      expect(result.workspaces.length).toBe(1);
      expect(result.workspaces[0]!.remote_url).toBe('https://github.com/foo/a');
    });
  });

  // ── onRetract ──────────────────────────────────────────────────────────────

  describe('onRetract', () => {
    it('narrows a single binding to private and emits workspace_changed', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onDeclare({
        workspaces: [{
          remote_url: 'https://github.com/foo/bar',
          local_path: '/tmp/bar',
          visibility: 'federated',
        }],
      }, ctxA);
      mockedBroadcast.mockClear();

      const identity = canonicalizeRepoUrl('https://github.com/foo/bar');
      await handler.onRetract({
        canonical_url: identity.canonicalUrl,
        local_path: '/tmp/bar',
      }, ctxA);

      const repo = repos.findRepoByCanonicalUrl(identity.canonicalUrl)!;
      const ws = workspaces.findWorkspace(repo.id, NODE_ID, '/tmp/bar')!;
      expect(ws.visibility).toBe('private');

      const changed = mockedBroadcast.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === 'workspace_changed',
      );
      expect(changed.length).toBe(2);
    });

    it('narrows all bindings for a repo when local_path omitted', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onDeclare({
        workspaces: [
          { remote_url: 'https://github.com/foo/bar', local_path: '/tmp/a', visibility: 'federated' },
          { remote_url: 'https://github.com/foo/bar', local_path: '/tmp/b', visibility: 'hub_local' },
        ],
      }, ctxA);
      mockedBroadcast.mockClear();

      await handler.onRetract({
        canonical_url: 'https://github.com/foo/bar',
      }, ctxA);

      const repo = repos.findRepoByCanonicalUrl('https://github.com/foo/bar')!;
      const bindings = workspaces.listWorkspacesForRepo(repo.id);
      expect(bindings.every((b) => b.visibility === 'private')).toBe(true);

      const changed = mockedBroadcast.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === 'repo_visibility_changed',
      );
      expect(changed.length).toBe(2);
    });

    it('only retracts the calling agent\'s bindings', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await handler.onDeclare({
        workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar', visibility: 'federated' }],
      }, ctxA);
      await handler.onDeclare({
        workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar', visibility: 'federated' }],
      }, ctxB);

      await handler.onRetract({ canonical_url: 'https://github.com/foo/bar' }, ctxA);

      const repo = repos.findRepoByCanonicalUrl('https://github.com/foo/bar')!;
      const a = workspaces.findWorkspace(repo.id, NODE_ID, '/tmp/bar')!;
      const b = workspaces.findWorkspace(repo.id, NODE_ID_2, '/tmp/bar')!;
      expect(a.visibility).toBe('private');
      expect(b.visibility).toBe('federated');
    });

    it('retract on an unknown repo is a no-op', async () => {
      const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: OWNER_ID });
      await expect(
        handler.onRetract({ canonical_url: 'https://github.com/no/such' }, ctxA),
      ).resolves.not.toThrow();
    });
  });
});
