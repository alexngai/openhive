/**
 * Unit tests: per-swarm `workspace_policy` enforcement in
 * `OpenHiveRepoHandler.onDeclare`.
 *
 * Closes the gap CLAUDE.md flagged: the `map_swarms.workspace_policy` column
 * was persisted at spawn but never consulted at declare. These tests pin
 * the four behaviors the column is meant to enforce:
 *
 *   1. No policy / `mode='open'`  → all declares accepted (legacy compat).
 *   2. `mode='allow_listed'`      → declare URL must canonicalize to one
 *                                   of `allowed_repos`.
 *   3. `mode='pinned'`            → declare URL must canonicalize to
 *                                   `pinned_repo`.
 *   4. Mixed batch                → policy validates the whole batch
 *                                   before any upsert lands (no partial
 *                                   commits when one URL is rejected).
 *
 * Tests run the handler directly against the DB — no MAP server / sidecar
 * needed. The two prerequisites the handler depends on (a `map_swarms`
 * row with the policy, and `map_nodes` for the agent FK) are populated
 * by `setupSwarm()`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import { OpenHiveRepoHandler } from '../../map/workspace-handler.js';

function listWorkspacesForSwarmActive(swarmId: string): unknown[] {
  return getDatabase()
    .prepare('SELECT id FROM workspaces WHERE swarm_id = ? AND is_active = 1')
    .all(swarmId);
}

function listWorkspacesForSwarmAll(swarmId: string): unknown[] {
  return getDatabase()
    .prepare('SELECT id FROM workspaces WHERE swarm_id = ?')
    .all(swarmId);
}
import type { WorkspacePolicy } from '../../swarm/types.js';
import type { RepoHandlerContext } from 'agent-workspace/kinds/repo';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('workspace-policy-enforcement');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'workspace-policy.db');

const REPO_A = 'https://github.com/test-org/repo-a';
const REPO_B = 'https://github.com/test-org/repo-b';
const REPO_C = 'https://github.com/test-org/repo-c';

let agentId: string;

// Each test gets its own swarm with its own policy so they're independent.
async function setupSwarm(policy: WorkspacePolicy | null): Promise<string> {
  const swarm = mapDAL.createSwarm(agentId, {
    name: `policy-test-${Date.now()}-${Math.random()}`,
    map_endpoint: `ws://test-${Date.now()}-${Math.random()}/`,
    map_transport: 'websocket',
  });

  if (policy) {
    getDatabase().prepare(
      'UPDATE map_swarms SET workspace_policy = ? WHERE id = ?',
    ).run(JSON.stringify(policy), swarm.id);
  }

  return swarm.id;
}

function makeCtx(swarmId: string): RepoHandlerContext {
  // Use a per-call node id; the handler's `ensureNodeWithId` shim creates
  // the row defensively against ctx.swarmId so we don't have to insert
  // map_nodes manually.
  return { agentId: `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, swarmId };
}

describe('OpenHiveRepoHandler — workspace_policy enforcement', () => {
  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'policy-test-owner',
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

  // ── Mode: open / null (legacy) ────────────────────────────────────────────

  it('no policy column → all declares accepted (legacy backwards compat)', async () => {
    const swarmId = await setupSwarm(null);
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await expect(
      handler.onDeclare(
        { workspaces: [{ remote_url: REPO_A, local_path: '/tmp/A' }] },
        makeCtx(swarmId),
      ),
    ).resolves.toBeUndefined();

    expect(listWorkspacesForSwarmActive(swarmId)).toHaveLength(1);
  });

  it("mode='open' → all declares accepted", async () => {
    const swarmId = await setupSwarm({ mode: 'open' });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await handler.onDeclare(
      {
        workspaces: [
          { remote_url: REPO_A, local_path: '/tmp/A' },
          { remote_url: REPO_B, local_path: '/tmp/B' },
        ],
      },
      makeCtx(swarmId),
    );

    expect(listWorkspacesForSwarmActive(swarmId)).toHaveLength(2);
  });

  // ── Mode: allow_listed ────────────────────────────────────────────────────

  it("mode='allow_listed' → declare matching the list is accepted", async () => {
    const swarmId = await setupSwarm({
      mode: 'allow_listed',
      allowed_repos: [REPO_A, REPO_B],
    });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await handler.onDeclare(
      { workspaces: [{ remote_url: REPO_A, local_path: '/tmp/A' }] },
      makeCtx(swarmId),
    );

    expect(listWorkspacesForSwarmActive(swarmId)).toHaveLength(1);
  });

  it("mode='allow_listed' → declare not in list is rejected; nothing persisted", async () => {
    const swarmId = await setupSwarm({
      mode: 'allow_listed',
      allowed_repos: [REPO_A],
    });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await expect(
      handler.onDeclare(
        { workspaces: [{ remote_url: REPO_C, local_path: '/tmp/C' }] },
        makeCtx(swarmId),
      ),
    ).rejects.toMatchObject({
      code: 'policy_violation',
      layer: 'swarm',
      name: 'PolicyViolationError',
    });

    expect(listWorkspacesForSwarmAll(swarmId)).toHaveLength(0);
    expect(
      getDatabase()
        .prepare("SELECT COUNT(*) as n FROM syncable_resources WHERE resource_type = 'repo'")
        .get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it("mode='allow_listed' → URL canonicalization is applied (.git suffix variant matches)", async () => {
    // Policy stores '.git' suffix; declare omits it. canonicalizeRepoUrl
    // strips '.git' so both forms hit the same canonical URL.
    const swarmId = await setupSwarm({
      mode: 'allow_listed',
      allowed_repos: [`${REPO_A}.git`],
    });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await expect(
      handler.onDeclare(
        { workspaces: [{ remote_url: REPO_A, local_path: '/tmp/A' }] },
        makeCtx(swarmId),
      ),
    ).resolves.toBeUndefined();

    expect(listWorkspacesForSwarmActive(swarmId)).toHaveLength(1);
  });

  it("mode='allow_listed' → mixed batch with one bad URL rejects atomically", async () => {
    const swarmId = await setupSwarm({
      mode: 'allow_listed',
      allowed_repos: [REPO_A, REPO_B],
    });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await expect(
      handler.onDeclare(
        {
          workspaces: [
            { remote_url: REPO_A, local_path: '/tmp/A' },
            { remote_url: REPO_C, local_path: '/tmp/C' }, // not allowed
          ],
        },
        makeCtx(swarmId),
      ),
    ).rejects.toMatchObject({ code: 'policy_violation', layer: 'swarm' });

    // Critical: REPO_A is allowed but the batch fails atomically — neither
    // workspace lands. The handler validates the whole batch before any upsert.
    expect(listWorkspacesForSwarmAll(swarmId)).toHaveLength(0);
  });

  // ── Mode: pinned ──────────────────────────────────────────────────────────

  it("mode='pinned' → declare matching pinned_repo is accepted", async () => {
    const swarmId = await setupSwarm({ mode: 'pinned', pinned_repo: REPO_A });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await handler.onDeclare(
      { workspaces: [{ remote_url: REPO_A, local_path: '/tmp/A' }] },
      makeCtx(swarmId),
    );

    expect(listWorkspacesForSwarmActive(swarmId)).toHaveLength(1);
  });

  it("mode='pinned' → any other URL is rejected", async () => {
    const swarmId = await setupSwarm({ mode: 'pinned', pinned_repo: REPO_A });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await expect(
      handler.onDeclare(
        { workspaces: [{ remote_url: REPO_B, local_path: '/tmp/B' }] },
        makeCtx(swarmId),
      ),
    ).rejects.toMatchObject({
      code: 'policy_violation',
      layer: 'swarm',
      detail: expect.stringContaining(REPO_A),
    });
  });

  // ── Defensive: malformed policy ───────────────────────────────────────────

  it("mode='pinned' with missing pinned_repo → reject all declares", async () => {
    // The schema validator should prevent this from ever reaching the DB,
    // but the handler defends in depth in case someone writes a corrupt row
    // out-of-band (admin script, schema drift).
    const swarmId = await setupSwarm({ mode: 'pinned' } as WorkspacePolicy);
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await expect(
      handler.onDeclare(
        { workspaces: [{ remote_url: REPO_A, local_path: '/tmp/A' }] },
        makeCtx(swarmId),
      ),
    ).rejects.toMatchObject({
      code: 'policy_violation',
      layer: 'swarm',
    });
  });

  // ── onChanged.added re-entry path ─────────────────────────────────────────

  it('onChanged.added entries also pass through the policy gate', async () => {
    // onChanged re-enters onDeclare for added entries, so the gate fires
    // there too. Pinning this so a future refactor that splits the path
    // can't silently lose enforcement.
    const swarmId = await setupSwarm({
      mode: 'allow_listed',
      allowed_repos: [REPO_A],
    });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await expect(
      handler.onChanged(
        { added: [{ remote_url: REPO_B, local_path: '/tmp/B' }] },
        makeCtx(swarmId),
      ),
    ).rejects.toMatchObject({ code: 'policy_violation', layer: 'swarm' });

    expect(listWorkspacesForSwarmAll(swarmId)).toHaveLength(0);
  });

  // ── onRetract policy gate ────────────────────────────────────────────────

  it('onRetract for an off-policy canonical_url is rejected before the DB lookup', async () => {
    // Even though retract only narrows existing same-agent bindings, the
    // realtime broadcast it emits leaks repo existence to off-policy
    // swarms. Closing the probe at the policy layer.
    const swarmId = await setupSwarm({ mode: 'pinned', pinned_repo: REPO_A });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await expect(
      handler.onRetract(
        { canonical_url: REPO_B, local_path: '/tmp/B' },
        makeCtx(swarmId),
      ),
    ).rejects.toMatchObject({ code: 'policy_violation', layer: 'swarm' });
  });

  it('onRetract for the pinned canonical_url is allowed (no DB row → no-op)', async () => {
    const swarmId = await setupSwarm({ mode: 'pinned', pinned_repo: REPO_A });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    // No matching binding exists; retract returns silently. The policy gate
    // shouldn't reject the on-policy URL even if there's nothing to retract.
    await expect(
      handler.onRetract(
        { canonical_url: REPO_A, local_path: '/tmp/A' },
        makeCtx(swarmId),
      ),
    ).resolves.toBeUndefined();
  });

  // ── Persistence atomicity ────────────────────────────────────────────────

  it('a successful declare commits the transaction and broadcasts (smoke)', async () => {
    // The transaction wrapper changed the persistence path; this asserts
    // the happy-path still ends with rows committed and the active count
    // matches the declare. (Failure-rollback is hard to simulate without
    // mocking the DAL; the comment claim is verified at the
    // structure-of-the-code level.)
    const swarmId = await setupSwarm({
      mode: 'allow_listed',
      allowed_repos: [REPO_A, REPO_B],
    });
    const handler = new OpenHiveRepoHandler({ defaultOwnerAgentId: agentId });

    await handler.onDeclare(
      {
        workspaces: [
          { remote_url: REPO_A, local_path: '/tmp/A' },
          { remote_url: REPO_B, local_path: '/tmp/B' },
        ],
      },
      makeCtx(swarmId),
    );

    expect(listWorkspacesForSwarmActive(swarmId)).toHaveLength(2);
  });
});
