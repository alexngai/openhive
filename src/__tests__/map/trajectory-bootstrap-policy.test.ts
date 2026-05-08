/**
 * Unit tests: trajectory-bootstrap path honors `workspace_policy`.
 *
 * The trajectory checkpoint flow lazily creates a repo + workspace
 * binding from `metadata.gitRemoteUrl + projectPath`. Without a policy
 * gate it bypasses `OpenHiveRepoHandler.onDeclare` — a pinned-mode swarm
 * could exfiltrate bindings via checkpoint metadata.
 *
 * These tests pin:
 *   1. Trajectory bootstrap respects `mode='allow_listed'` and `'pinned'`.
 *   2. Off-policy URLs fall through silently (return null) — checkpoint
 *      writing must not throw on policy violation.
 *   3. On-policy URLs land a repo + binding as before.
 *
 * `getAggregateCapabilities` is mocked to return the
 * `workspace.declare.enabled = true` capability so the function
 * doesn't short-circuit on the cap check.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../map/connection-registry.js', () => ({
  getAggregateCapabilities: () => ({ workspace: { declare: { enabled: true } } }),
}));

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import { bootstrapRepoFromCheckpoint } from '../../map/trajectory-handler.js';
import type { WorkspacePolicy } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('trajectory-bootstrap-policy');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'trajectory-bootstrap-policy.db');

const REPO_PINNED = 'https://github.com/test-org/pinned';
const REPO_OTHER = 'https://github.com/test-org/other';

let agentId: string;

async function setupSwarm(policy: WorkspacePolicy | null): Promise<string> {
  const swarm = mapDAL.createSwarm(agentId, {
    name: `traj-policy-${Date.now()}-${Math.random()}`,
    map_endpoint: `ws://traj-${Date.now()}-${Math.random()}/`,
    map_transport: 'websocket',
  });
  if (policy) {
    getDatabase().prepare(
      'UPDATE map_swarms SET workspace_policy = ? WHERE id = ?',
    ).run(JSON.stringify(policy), swarm.id);
  }
  return swarm.id;
}

function makeBootstrapInput(swarmId: string, gitRemoteUrl: string) {
  return {
    swarmId,
    agentId: `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    gitRemoteUrl,
    projectPath: '/tmp/some/path',
    branch: 'main',
  };
}

function bindingCount(swarmId: string): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) as n FROM workspaces WHERE swarm_id = ?')
    .get(swarmId) as { n: number };
  return row.n;
}

describe('bootstrapRepoFromCheckpoint — workspace_policy enforcement', () => {
  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'traj-policy-owner',
      is_admin: true,
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM workspaces').run();
    db.prepare("DELETE FROM syncable_resources WHERE resource_type = 'repo'").run();
    db.prepare('DELETE FROM map_nodes').run();
    db.prepare('DELETE FROM map_swarms').run();
  });

  it('no policy → bootstrap proceeds (legacy compat)', async () => {
    const swarmId = await setupSwarm(null);
    const result = bootstrapRepoFromCheckpoint(makeBootstrapInput(swarmId, REPO_PINNED));
    expect(result).not.toBeNull();
    expect(bindingCount(swarmId)).toBe(1);
  });

  it("mode='pinned' on-policy URL → bootstrap proceeds", async () => {
    const swarmId = await setupSwarm({ mode: 'pinned', pinned_repo: REPO_PINNED });
    const result = bootstrapRepoFromCheckpoint(makeBootstrapInput(swarmId, REPO_PINNED));
    expect(result).not.toBeNull();
    expect(bindingCount(swarmId)).toBe(1);
  });

  it("mode='pinned' off-policy URL → bootstrap returns null silently, no rows written", async () => {
    const swarmId = await setupSwarm({ mode: 'pinned', pinned_repo: REPO_PINNED });
    const result = bootstrapRepoFromCheckpoint(makeBootstrapInput(swarmId, REPO_OTHER));
    expect(result).toBeNull();
    expect(bindingCount(swarmId)).toBe(0);
    // Confirm no repo resource was created either.
    const repoCount = getDatabase()
      .prepare("SELECT COUNT(*) as n FROM syncable_resources WHERE resource_type = 'repo'")
      .get() as { n: number };
    expect(repoCount.n).toBe(0);
  });

  it("mode='allow_listed' off-policy URL → bootstrap returns null silently", async () => {
    const swarmId = await setupSwarm({
      mode: 'allow_listed',
      allowed_repos: [REPO_PINNED],
    });
    const result = bootstrapRepoFromCheckpoint(makeBootstrapInput(swarmId, REPO_OTHER));
    expect(result).toBeNull();
    expect(bindingCount(swarmId)).toBe(0);
  });

  it("mode='allow_listed' on-policy URL → bootstrap proceeds", async () => {
    const swarmId = await setupSwarm({
      mode: 'allow_listed',
      allowed_repos: [REPO_PINNED],
    });
    const result = bootstrapRepoFromCheckpoint(makeBootstrapInput(swarmId, REPO_PINNED));
    expect(result).not.toBeNull();
    expect(bindingCount(swarmId)).toBe(1);
  });
});
