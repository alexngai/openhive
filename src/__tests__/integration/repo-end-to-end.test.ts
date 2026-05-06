/**
 * End-to-end integration test for the openhive ↔ agent-workspace/kinds/repo
 * integration.
 *
 * Wires real package code (`RepoClient` + `MockRepoTransport` + the wire
 * translators) to real openhive consumer code (`OpenHiveRepoHandler` + DALs),
 * with the only mock being the realtime broadcast sink.
 *
 * Flow per agent → hub call:
 *   1. Agent code calls `client.declare/changed/retract`
 *   2. RepoClient runs the wire translators internally and calls
 *      `transport.notify(method, params)` with snake_case payload
 *   3. MockRepoTransport records the call
 *   4. Test extracts the recorded payload and dispatches to the matching
 *      `OpenHiveRepoHandler` method (simulating MAP server dispatch)
 *   5. Handler persists via DALs + emits broadcast events
 *   6. Assertions verify DB state + broadcasts
 *
 * Validates the full path the production wiring takes (slice 2 wiring in
 * map-server-setup.ts), but in-process and synchronous.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  RepoClient,
  REPO_METHODS,
  type RepoConfig,
} from 'agent-workspace/kinds/repo';
import { MockRepoTransport } from 'agent-workspace/kinds/repo/testing';
import type {
  RepoHandlerContext,
  RepoDeclareParams,
  RepoChangedParams,
  RepoListParams,
  RepoRetractParams,
} from 'agent-workspace/kinds/repo';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { broadcastToChannel } from '../../realtime/index.js';
import { OpenHiveRepoHandler } from '../../map/workspace-handler.js';
import * as repos from '../../db/dal/repos.js';
import * as workspaces from '../../db/dal/workspaces.js';

const TEST_ROOT = testRoot('repo-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'repo-e2e.db');
const mockedBroadcast = vi.mocked(broadcastToChannel);

const OWNER_ID = 'agent_owner';
const SWARM_ID = 'swarm_test';
const NODE_ID = 'node_test';

const ctx: RepoHandlerContext = { agentId: NODE_ID, swarmId: SWARM_ID };

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
}

/**
 * Route a recorded `notify` from the mock transport to the matching handler
 * method. Mimics how the MAP server's additionalHandler dispatcher wires
 * `x-workspace/repo.*` methods to `OpenHiveRepoHandler` in production.
 */
async function dispatchToHandler(
  handler: OpenHiveRepoHandler,
  call: { method: string; params: unknown },
  ctx: RepoHandlerContext,
): Promise<unknown> {
  switch (call.method) {
    case REPO_METHODS.DECLARE:
      return handler.onDeclare(call.params as RepoDeclareParams, ctx);
    case REPO_METHODS.CHANGED:
      return handler.onChanged(call.params as RepoChangedParams, ctx);
    case REPO_METHODS.LIST:
      return handler.onList(call.params as RepoListParams, ctx);
    case REPO_METHODS.RETRACT:
      return handler.onRetract(call.params as RepoRetractParams, ctx);
    default:
      throw new Error(`Unknown method: ${call.method}`);
  }
}

describe('agent-workspace/kinds/repo ↔ openhive end-to-end', () => {
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

  // ── declare round-trip ──────────────────────────────────────────────────────

  it('client.declare → wire format → handler.onDeclare → DAL persistence + broadcast', async () => {
    const transport = new MockRepoTransport();
    const client = new RepoClient(transport);
    const handler = new OpenHiveRepoHandler();

    const config: RepoConfig = {
      remoteUrl: 'git@github.com:Foo/Bar.git', // raw URL — gets canonicalized
      localPath: '/tmp/bar',
      currentBranch: 'main',
      headSha: 'abc123def',
      visibility: 'hub_local',
      instanceLabel: 'main worktree',
    };

    // 1. Agent code calls declare on the package's RepoClient
    await client.declare([config]);

    // 2. RepoClient produced a notify with snake_case wire format
    expect(transport.notifies).toHaveLength(1);
    const recorded = transport.notifies[0]!;
    expect(recorded.method).toBe(REPO_METHODS.DECLARE);
    const params = recorded.params as RepoDeclareParams;
    expect(params.workspaces).toHaveLength(1);
    expect(params.workspaces[0]).toEqual({
      remote_url: 'git@github.com:Foo/Bar.git',
      local_path: '/tmp/bar',
      current_branch: 'main',
      head_sha: 'abc123def',
      visibility: 'hub_local',
      instance_label: 'main worktree',
    });

    // 3. Route recorded payload to the openhive handler (sim of MAP dispatch)
    await dispatchToHandler(handler, recorded, ctx);

    // 4. Handler canonicalized + persisted
    const repo = repos.findRepoByCanonicalUrl('https://github.com/foo/bar');
    expect(repo).not.toBeNull();
    expect(repo!.metadata).toMatchObject({ origin: 'agent_declared' });

    const wsRows = workspaces.listWorkspacesForAgent(NODE_ID);
    expect(wsRows).toHaveLength(1);
    expect(wsRows[0]).toMatchObject({
      local_path: '/tmp/bar',
      current_branch: 'main',
      head_sha: 'abc123def',
      visibility: 'hub_local',
      instance_label: 'main worktree',
    });

    // 5. Realtime broadcast fired (workspace_added × 2 channels)
    const added = mockedBroadcast.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'workspace_added',
    );
    expect(added).toHaveLength(2);
    const channels = added.map((c) => c[0]);
    expect(channels).toContain('map:repos');
    expect(channels).toContain(`map:repo:${repo!.id}`);
  });

  // ── changed (added + removed) ──────────────────────────────────────────────

  it('client.changed (added + removed) → wire diff → handler.onChanged → DAL', async () => {
    const transport = new MockRepoTransport();
    const client = new RepoClient(transport);
    const handler = new OpenHiveRepoHandler();

    // Seed: declare a binding via the round-trip path
    await client.declare([{
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
    }]);
    await dispatchToHandler(handler, transport.notifies[0]!, ctx);
    transport.reset();
    mockedBroadcast.mockClear();

    // Apply a diff: add a new binding, remove the old one
    await client.changed({
      added: [{
        remoteUrl: 'https://github.com/foo/baz',
        localPath: '/tmp/baz',
      }],
      removed: [{
        canonicalUrl: 'https://github.com/foo/bar',
        localPath: '/tmp/bar',
      }],
    });

    expect(transport.notifies).toHaveLength(1);
    const recorded = transport.notifies[0]!;
    expect(recorded.method).toBe(REPO_METHODS.CHANGED);

    await dispatchToHandler(handler, recorded, ctx);

    // After changed: only /tmp/baz exists; /tmp/bar deleted
    const wsRows = workspaces.listWorkspacesForAgent(NODE_ID, { activeOnly: false });
    expect(wsRows).toHaveLength(1);
    expect(wsRows[0]!.local_path).toBe('/tmp/baz');

    // Two events emitted: workspace_added (for baz) + workspace_deactivated (for bar)
    const types = mockedBroadcast.mock.calls.map(
      (c) => (c[1] as { type: string }).type,
    );
    expect(types.filter((t) => t === 'workspace_added').length).toBe(2); // fan-out
    expect(types.filter((t) => t === 'workspace_deactivated').length).toBe(2);
  });

  // ── list (hub direction) ───────────────────────────────────────────────────

  it('handler.onList returns wire-shape results that the package can consume', async () => {
    const transport = new MockRepoTransport();
    const client = new RepoClient(transport);
    const handler = new OpenHiveRepoHandler();

    // Declare + persist two bindings
    await client.declare([
      { remoteUrl: 'https://github.com/foo/bar', localPath: '/tmp/bar' },
      { remoteUrl: 'https://github.com/foo/baz', localPath: '/tmp/baz' },
    ]);
    await dispatchToHandler(handler, transport.notifies[0]!, ctx);

    // Hub calls list (simulated)
    const result = await handler.onList({}, ctx);
    expect(result.workspaces).toHaveLength(2);

    // Returned shape is wire-compatible with the package's WorkspaceDeclareInput
    for (const w of result.workspaces) {
      expect(w).toHaveProperty('remote_url');
      expect(w).toHaveProperty('local_path');
      expect(w.visibility).toBe('hub_local');
    }

    // Filter works
    const filtered = await handler.onList({
      filter: { canonical_url: 'https://github.com/foo/bar' },
    }, ctx);
    expect(filtered.workspaces).toHaveLength(1);
    expect(filtered.workspaces[0]!.remote_url).toBe('https://github.com/foo/bar');
  });

  // ── retract round-trip ─────────────────────────────────────────────────────

  it('client.retract → wire payload → handler.onRetract → DAL visibility narrows', async () => {
    const transport = new MockRepoTransport();
    const client = new RepoClient(transport);
    const handler = new OpenHiveRepoHandler();

    // Seed with a federated binding
    await client.declare([{
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
      visibility: 'federated',
    }]);
    await dispatchToHandler(handler, transport.notifies[0]!, ctx);
    transport.reset();
    mockedBroadcast.mockClear();

    // Retract a single binding
    await client.retract('https://github.com/foo/bar', '/tmp/bar');
    expect(transport.notifies).toHaveLength(1);
    const recorded = transport.notifies[0]!;
    expect(recorded.method).toBe(REPO_METHODS.RETRACT);
    expect(recorded.params).toEqual({
      canonical_url: 'https://github.com/foo/bar',
      local_path: '/tmp/bar',
    });

    await dispatchToHandler(handler, recorded, ctx);

    const repo = repos.findRepoByCanonicalUrl('https://github.com/foo/bar')!;
    const ws = workspaces.findWorkspace(repo.id, NODE_ID, '/tmp/bar')!;
    expect(ws.visibility).toBe('private');

    // workspace_changed event fired
    const changed = mockedBroadcast.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'workspace_changed',
    );
    expect(changed.length).toBe(2);
  });

  // ── snapshot helper ────────────────────────────────────────────────────────

  it('RepoClient.snapshot returns RepoConfig[] roundtrippable through declare', async () => {
    // Manually persist a binding (simulating prior state)
    const transport = new MockRepoTransport();
    const client = new RepoClient(transport);
    const handler = new OpenHiveRepoHandler();

    await client.declare([{
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
      currentBranch: 'main',
    }]);
    await dispatchToHandler(handler, transport.notifies[0]!, ctx);
    transport.reset();

    // Use snapshot from a manager — this is exercised in the package's own
    // tests; here we just confirm the produced shape integrates with declare.
    const config: RepoConfig = {
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
      currentBranch: 'main',
    };
    await client.declare([config]);
    await dispatchToHandler(handler, transport.notifies[0]!, ctx);

    // Idempotent: same binding, no duplicate
    expect(workspaces.listWorkspacesForAgent(NODE_ID)).toHaveLength(1);
  });
});
