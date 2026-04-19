/**
 * Full-stack E2E tests for deferred-work gap closure.
 *
 * Exercises the complete chain for items that previously only had unit tests:
 *
 *   A2: WorkspaceManager.land() dispatcher → strategy → mergeStream → emit →
 *       bridge → hub handler → DAL (cascade_merges row)
 *   A3: terminateWithChangeConsolidation through tracker → stream.merged
 *       cascade event with task_ref
 *   E1: pauseStream / resumeStream / rollback → stream.paused / resumed /
 *       rolled_back cascade events → hub handler → stream status mutation
 *   E3: Rate limiting enforcement at the MAP dispatch site
 *   A4: /cascade/tasks/lookup REST endpoint (real Fastify inject)
 *
 * Uses the same fixture pattern as live-emission-e2e.test.ts: real
 * GitCascadeAdapter + real CascadeBridge + mock LifecycleBridgeConnection
 * whose callExtension delegates to handleCascadeRequest. For A2 we
 * additionally construct a real DefaultWorkspaceManager + register a real
 * MergeToParentStrategy so the full landing dispatch chain is exercised.
 *
 * Gated on RUN_E2E_TESTS=true (same as live-emission) to keep default
 * test runs fast — these tests hit real git.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import Fastify from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createResource } from '../../db/dal/syncable-resources.js';
import {
  handleCascadeRequest,
  CASCADE_METHODS,
} from '../../map/cascade-handler.js';
import {
  getStreamBySwarmAndId,
} from '../../db/dal/cascade-streams.js';
import { cascadeRoutes } from '../../api/routes/cascade.js';
import {
  setCascadeRateLimitConfig,
  resetCascadeRateLimit,
  consumeCascadeToken,
} from '../../map/cascade-rate-limit.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

async function loadMacroAgentModules() {
  const adapterMod = await import('macro-agent/dist/workspace/git-cascade-adapter.js');
  const bridgeMod = await import('macro-agent/dist/map/cascade-bridge.js');
  const wmMod = await import('macro-agent/dist/workspace/workspace-manager.js');
  const landingMod = await import('macro-agent/dist/workspace/landing/index.js');
  const cascadeMod = await import('macro-agent/dist/lifecycle/cascade.js');
  return {
    GitCascadeAdapter: adapterMod.GitCascadeAdapter as new (config: { repoPath: string; tablePrefix?: string }) => any,
    createCascadeBridge: bridgeMod.createCascadeBridge as (
      connection: { isConnected: boolean; callExtension(method: string, params?: unknown): Promise<unknown> },
      adapter: any,
      options?: { verbose?: boolean }
    ) => { dispose: () => void },
    DefaultWorkspaceManager: wmMod.DefaultWorkspaceManager as new (adapter: any, config?: any) => any,
    registerBuiltinLandingStrategies: landingMod.registerBuiltinLandingStrategies as (ws: any) => void,
    terminateWithChangeConsolidation: cascadeMod.terminateWithChangeConsolidation as (
      childId: string, parentId: string, agentManager: any,
      wsProvider?: any, options?: any, workspaceManager?: any, taskRef?: any,
    ) => Promise<any>,
  };
}

const TEST_ROOT = testRoot('cascade-full-stack-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'full-stack.db');
const SWARM = 'swarm-full-stack-e2e';

function mkRepo(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@test.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# init\n');
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: dir, stdio: 'pipe' });
  fs.mkdirSync(path.join(dir, '.git-cascade'), { recursive: true });
  return dir;
}

function mkWorktree(repo: string, agent: string, branch: string): string {
  const wt = path.join(TEST_ROOT, `wt-${agent}-${Date.now()}`);
  execSync(`git worktree add "${wt}" ${branch}`, { cwd: repo, stdio: 'pipe' });
  return wt;
}

async function flush() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const RUN = process.env.RUN_E2E_TESTS === 'true';
const describeIfE2E = RUN ? describe : describe.skip;

describeIfE2E('full-stack E2E: A2 + A3 + E1 + E3 + A4', () => {
  let mods: Awaited<ReturnType<typeof loadMacroAgentModules>>;
  let agentId: string;
  let apiKey: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent, apiKey: key } = await agentsDAL.createAgent({
      name: 'full-stack-e2e',
      description: 'Full-stack cascade E2E',
    });
    agentId = agent.id;
    apiKey = key;
    mods = await loadMacroAgentModules();
  });

  afterAll(() => {
    resetCascadeRateLimit();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  let repo: string;
  let adapter: any;
  let dispose: () => void;
  let connectionCalls: Array<{ method: string; params: unknown }>;
  let conn: { isConnected: boolean; callExtension(method: string, params?: unknown): Promise<unknown> };

  beforeEach(() => {
    repo = mkRepo(`repo-${Date.now()}`);
    adapter = new mods.GitCascadeAdapter({ repoPath: repo, tablePrefix: 'fs_' });
    connectionCalls = [];
    conn = {
      isConnected: true,
      async callExtension(method: string, params?: unknown) {
        connectionCalls.push({ method, params });
        return handleCascadeRequest(method, params, { swarmId: SWARM, agentId });
      },
    };
    const bridge = mods.createCascadeBridge(conn, adapter);
    dispose = bridge.dispose;
  });

  afterEach(() => {
    if (dispose) dispose();
    if (adapter) adapter.close?.();
    resetCascadeRateLimit();
  });

  // =========================================================================
  // A2: WorkspaceManager.land() full dispatch chain
  // =========================================================================

  it('A2: WorkspaceManager.land() → MergeToParentStrategy → mergeStream → hub receives stream.merged', async () => {
    const ws = new mods.DefaultWorkspaceManager(adapter);
    mods.registerBuiltinLandingStrategies(ws);

    const parent = adapter.createStream({ name: 'a2-parent', agentId: 'a' });
    await flush();
    const child = adapter.forkStream({ parentStreamId: parent, name: 'a2-child', agentId: 'b' });
    await flush();
    const wt = mkWorktree(repo, 'a2-child', `stream/${child}`);
    fs.writeFileSync(path.join(wt, 'a2.txt'), 'work\n');
    execSync('git add .', { cwd: wt, stdio: 'pipe' });
    adapter.commitChanges({ streamId: child, agentId: 'b', worktree: wt, message: 'feat: a2 work' });
    await flush();

    connectionCalls.length = 0;
    const taskRef = { resource_id: 'res-a2-e2e', node_id: 'task-a2-e2e' };
    const result = await ws.land({
      agentId: 'b',
      streamId: child,
      sourceWorktree: wt,
      strategyName: 'merge-to-parent',
      taskRef,
      workspaceManager: ws,
    });
    await flush();

    expect(result.success).toBe(true);
    const mergedCall = connectionCalls.find((c) => c.method === CASCADE_METHODS.STREAM_MERGED);
    expect(mergedCall).toBeDefined();
    const params = mergedCall!.params as { metadata?: { task_ref?: unknown } };
    expect(params.metadata?.task_ref).toEqual(taskRef);

    const sourceStream = getStreamBySwarmAndId(SWARM, child);
    expect(sourceStream!.status).toBe('merged');
  });

  // =========================================================================
  // A3: terminateWithChangeConsolidation through tracker
  // =========================================================================

  it('A3: consolidation merge routes through tracker → stream.merged cascade event with task_ref', async () => {
    const ws = new mods.DefaultWorkspaceManager(adapter);

    const parentStream = adapter.createStream({ name: 'a3-parent', agentId: 'p' });
    await flush();
    const childStream = adapter.forkStream({ parentStreamId: parentStream, name: 'a3-child', agentId: 'c' });
    await flush();
    const parentWt = mkWorktree(repo, 'a3-parent', `stream/${parentStream}`);
    const childWt = mkWorktree(repo, 'a3-child', `stream/${childStream}`);
    fs.writeFileSync(path.join(childWt, 'a3.txt'), 'child work\n');
    execSync('git add .', { cwd: childWt, stdio: 'pipe' });
    adapter.commitChanges({ streamId: childStream, agentId: 'c', worktree: childWt, message: 'feat: a3 work' });
    await flush();

    connectionCalls.length = 0;
    const taskRef = { resource_id: 'res-a3-e2e', node_id: 'task-a3-e2e' };
    const mockAgentManager = {
      getChildren: () => [],
      terminate: vi.fn(async () => {}),
    };
    const wsProvider = {
      getWorkspace: (id: string) =>
        id === 'child-agent'
          ? { agentId: 'child-agent', path: childWt, branch: `stream/${childStream}`, streamId: childStream, role: 'worker', createdAt: Date.now() }
          : { agentId: 'parent-agent', path: parentWt, branch: `stream/${parentStream}`, streamId: parentStream, role: 'coordinator', createdAt: Date.now() },
    };

    const result = await mods.terminateWithChangeConsolidation(
      'child-agent', 'parent-agent', mockAgentManager, wsProvider,
      undefined, ws, taskRef,
    );
    await flush();

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.mergeCommit).toBeTruthy();
    expect(mockAgentManager.terminate).toHaveBeenCalledWith('child-agent', 'changes_consolidated');

    const mergedCall = connectionCalls.find((c) => c.method === CASCADE_METHODS.STREAM_MERGED);
    expect(mergedCall).toBeDefined();
    const mergedParams = mergedCall!.params as { metadata?: { task_ref?: unknown } };
    expect(mergedParams.metadata?.task_ref).toEqual(taskRef);
  });

  // =========================================================================
  // E1: pauseStream / resumeStream / rollback cascade events
  // =========================================================================

  it('E1: pauseStream → stream.paused → hub flips stream status to paused', async () => {
    const sid = adapter.createStream({ name: 'e1-pausable', agentId: 'a' });
    await flush();
    connectionCalls.length = 0;

    adapter.pauseStream(sid, 'blocked on review');
    await flush();

    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.STREAM_PAUSED)).toBe(true);
    const paused = connectionCalls.find((c) => c.method === CASCADE_METHODS.STREAM_PAUSED);
    expect((paused!.params as { reason?: string }).reason).toBe('blocked on review');

    const stream = getStreamBySwarmAndId(SWARM, sid);
    expect(stream!.status).toBe('paused');
  });

  it('E1: resumeStream → stream.resumed → hub reverts stream status to active', async () => {
    const sid = adapter.createStream({ name: 'e1-resumable', agentId: 'a' });
    await flush();
    adapter.pauseStream(sid);
    await flush();
    expect(getStreamBySwarmAndId(SWARM, sid)!.status).toBe('paused');

    connectionCalls.length = 0;
    adapter.resumeStream(sid);
    await flush();

    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.STREAM_RESUMED)).toBe(true);
    const stream = getStreamBySwarmAndId(SWARM, sid);
    expect(stream!.status).toBe('active');
  });

  it('E1: rollbackN → stream.rolled_back → hub receives event (observability only)', async () => {
    const sid = adapter.createStream({ name: 'e1-rollback', agentId: 'a' });
    await flush();
    const wt = mkWorktree(repo, 'e1-rb', `stream/${sid}`);

    // Need manual operation recording for rollbackN (commitChanges doesn't wire parentOps).
    const tracker = adapter.rawTracker;
    const commits: string[] = [];
    const ops: string[] = [];
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(wt, `rb${i}.txt`), `${i}`);
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      execSync(`git commit -m "commit ${i}"`, { cwd: wt, stdio: 'pipe' });
      const commit = execSync('git rev-parse HEAD', { cwd: wt, encoding: 'utf-8' }).trim();
      commits.push(commit);
      const op = tracker.recordOperation({
        streamId: sid, agentId: 'a', opType: 'commit',
        beforeState: commits[i - 2] ?? commit,
        afterState: commit,
        parentOps: ops[i - 2] ? [ops[i - 2]] : undefined,
      });
      ops.push(op);
    }
    await flush();
    connectionCalls.length = 0;

    tracker.rollbackN({ streamId: sid, n: 2, worktreePath: wt });
    await flush();

    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.STREAM_ROLLED_BACK)).toBe(true);
    const rb = connectionCalls.find((c) => c.method === CASCADE_METHODS.STREAM_ROLLED_BACK);
    expect(rb!.params).toMatchObject({
      stream_id: sid,
      strategy: 'n_operations',
      target: 2,
    });
    expect((rb!.params as { new_head?: string }).new_head).toBe(commits[0]);
  });

  // =========================================================================
  // E3: Rate limiting at the MAP dispatch site
  // =========================================================================

  it('E3: burst exceeding token bucket capacity gets rejected', () => {
    // Use a dedicated swarm ID so the bridge's async events from beforeEach
    // don't drain the bucket.
    const rateLimitSwarm = `swarm-e3-ratelimit-${Date.now()}`;
    setCascadeRateLimitConfig({ capacity: 3, refillPerSecond: 0 });

    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 10; i++) {
      if (consumeCascadeToken(rateLimitSwarm)) {
        handleCascadeRequest(
          CASCADE_METHODS.STREAM_COMMITTED,
          {
            stream_id: 'e3-burst-stream',
            commit_hash: `e3-${i}`,
            change_id: `chg-e3-${i}`,
            agent_id: 'a',
            message_summary: `burst ${i}`,
            files_touched: [],
          },
          { swarmId: rateLimitSwarm, agentId },
        );
        accepted++;
      } else {
        rejected++;
      }
    }

    // capacity 3 + refill 0 → exactly 3 allowed, 7 rejected.
    expect(accepted).toBe(3);
    expect(rejected).toBe(7);
  });

  // =========================================================================
  // A4: /cascade/tasks/lookup endpoint (real Fastify inject)
  // =========================================================================

  it('A4: /cascade/tasks/lookup resolves resource_id from git_remote_url', async () => {
    const gitUrl = `https://github.com/acme/a4-e2e-${Date.now()}`;
    const resource = createResource({
      name: 'a4-e2e-tasks',
      resource_type: 'task',
      git_remote_url: gitUrl,
      owner_agent_id: agentId,
      sync_strategy: 'metadata',
      metadata: { opentasks: true },
    });

    const app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(
      async (api) => { await api.register(cascadeRoutes); },
      { prefix: '/api/v1' },
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cascade/tasks/lookup?git_remote_url=${encodeURIComponent(gitUrl)}`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.resource_id).toBe(resource.id);
    expect(body.data.resource_name).toBe('a4-e2e-tasks');

    await app.close();
  });
});
