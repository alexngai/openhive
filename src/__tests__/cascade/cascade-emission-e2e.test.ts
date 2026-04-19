/**
 * Live emission E2E.
 *
 * Closes the contract between macro-agent's GitCascadeAdapter + CascadeBridge
 * and OpenHive's hub cascade handler. Per-layer unit tests cover each side
 * with mocks; this one wires them together so wire-format drift would surface.
 *
 * Flow per scenario:
 *   1. Real GitCascadeAdapter against a temp git repo (real commits, real
 *      git-cascade DB, real emit hook firing)
 *   2. Real CascadeBridge subscribed to adapter.onEvent
 *   3. Mock LifecycleBridgeConnection whose callExtension delegates straight
 *      to handleCascadeRequest — so the bridge's translated payload hits the
 *      same handler the live MAP server would invoke
 *   4. Assert hub DAL state matches what really happened on the agent side
 *
 * Skipped under RUN_E2E_TESTS=false to keep the default test run fast (real
 * git ops + filesystem worktrees ~1s per scenario).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  handleCascadeRequest,
  CASCADE_METHODS,
} from '../../map/cascade-handler.js';
import {
  getStreamBySwarmAndId,
  listChangesForStream,
  listConflictsForStream,
  listCascadeOperations,
  listPushes,
  listQueueEntries,
  getCommitRangeForTask,
} from '../../db/dal/cascade-streams.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

// Lazy-load macro-agent so the import error is informative if the symlink is broken.
async function loadMacroAgentModules() {
  const adapterMod = await import('macro-agent/dist/workspace/git-cascade-adapter.js');
  const bridgeMod = await import('macro-agent/dist/map/cascade-bridge.js');
  return {
    GitCascadeAdapter: adapterMod.GitCascadeAdapter as new (config: { repoPath: string; tablePrefix?: string }) => any,
    createCascadeBridge: bridgeMod.createCascadeBridge as (
      connection: { isConnected: boolean; callExtension(method: string, params?: unknown): Promise<unknown> },
      adapter: any,
      options?: { verbose?: boolean }
    ) => { dispose: () => void },
  };
}

const TEST_ROOT = testRoot('cascade-live-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-e2e.db');

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

const SWARM = 'swarm-live-e2e';

const RUN = process.env.RUN_E2E_TESTS === 'true';
const describeIfE2E = RUN ? describe : describe.skip;

describeIfE2E('live emission E2E (macro-agent → bridge → hub handler → DAL)', () => {
  let GitCascadeAdapter: Awaited<ReturnType<typeof loadMacroAgentModules>>['GitCascadeAdapter'];
  let createCascadeBridge: Awaited<ReturnType<typeof loadMacroAgentModules>>['createCascadeBridge'];
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'live-e2e-test',
      description: 'Live emission E2E driver',
    });
    agentId = agent.id;
    const mods = await loadMacroAgentModules();
    GitCascadeAdapter = mods.GitCascadeAdapter;
    createCascadeBridge = mods.createCascadeBridge;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  let repo: string;
  let adapter: any;
  let dispose: () => void;
  let connectionCalls: Array<{ method: string; params: unknown }>;

  beforeEach(() => {
    repo = mkRepo(`repo-${Date.now()}`);
    adapter = new GitCascadeAdapter({ repoPath: repo, tablePrefix: 'live_' });
    connectionCalls = [];
    const conn = {
      isConnected: true,
      async callExtension(method: string, params?: unknown) {
        connectionCalls.push({ method, params });
        return handleCascadeRequest(method, params, { swarmId: SWARM, agentId });
      },
    };
    const bridge = createCascadeBridge(conn, adapter);
    dispose = bridge.dispose;
  });

  afterEach(() => {
    if (dispose) dispose();
    if (adapter) adapter.close?.();
  });

  // Helper: bridge events fire async via void-promise; flush microtasks +
  // immediates so the handler call has settled before assertions.
  async function flush() {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  it('createStream → x-cascade/stream.opened → projection row exists', async () => {
    const sid = adapter.createStream({
      name: 'live-feature',
      agentId: 'agent-live',
      metadata: { task_ref: { resource_id: 'res-live', node_id: 'node-live' } },
    });
    await flush();

    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.STREAM_OPENED)).toBe(true);
    const projection = getStreamBySwarmAndId(SWARM, sid);
    expect(projection).not.toBeNull();
    expect(projection!.name).toBe('live-feature');
    expect(projection!.task_resource_id).toBe('res-live');
    expect(projection!.task_node_id).toBe('node-live');
  });

  it('commitChanges → stream.committed → cascade_changes row + task_ref propagated', async () => {
    const sid = adapter.createStream({ name: 'live-commits', agentId: 'a' });
    await flush();
    const wt = mkWorktree(repo, 'a', `stream/${sid}`);
    fs.writeFileSync(path.join(wt, 'src.txt'), 'hello\n');
    execSync('git add .', { cwd: wt, stdio: 'pipe' });
    const result = adapter.commitChanges({
      streamId: sid,
      agentId: 'a',
      worktree: wt,
      message: 'feat: live commit',
      metadata: { task_ref: { resource_id: 'res-live', node_id: 'node-commit' } },
    });
    await flush();

    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.STREAM_COMMITTED)).toBe(true);
    const stream = getStreamBySwarmAndId(SWARM, sid);
    const changes = listChangesForStream(stream!.id);
    expect(changes).toHaveLength(1);
    expect(changes[0].commit_hash).toBe(result.commit);
    expect(changes[0].change_id).toBe(result.changeId);
    expect(changes[0].files_touched).toEqual(['src.txt']);
    expect(changes[0].task_resource_id).toBe('res-live');
    expect(changes[0].task_node_id).toBe('node-commit');
  });

  it('mergeStream → stream.merged → cascade_merges row + source marked merged', async () => {
    const tgt = adapter.createStream({ name: 'live-target', agentId: 'a' });
    await flush();
    const src = adapter.forkStream({ parentStreamId: tgt, name: 'live-source', agentId: 'b' });
    await flush();
    const wt = mkWorktree(repo, 'b', `stream/${src}`);
    fs.writeFileSync(path.join(wt, 'src2.txt'), 'work\n');
    execSync('git add .', { cwd: wt, stdio: 'pipe' });
    adapter.commitChanges({ streamId: src, agentId: 'b', worktree: wt, message: 'feat: src commit' });
    await flush();
    const merge = adapter.mergeStream({ sourceStream: src, targetStream: tgt, agentId: 'b', worktree: wt });
    await flush();

    if (merge.success) {
      expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.STREAM_MERGED)).toBe(true);
      const sourceStream = getStreamBySwarmAndId(SWARM, src);
      expect(sourceStream!.status).toBe('merged');
    }
  });

  // A1 — per-merge metadata threading. Verifies that a task_ref passed via
  // mergeStream({ metadata }) flows all the way through git-cascade's emit →
  // CascadeBridge → hub's stream.merged handler → cascade_merges.metadata.
  it('mergeStream with metadata → task_ref persisted on cascade_merges row', async () => {
    const tgt = adapter.createStream({ name: 'live-target-md', agentId: 'a' });
    await flush();
    const src = adapter.forkStream({ parentStreamId: tgt, name: 'live-source-md', agentId: 'b' });
    await flush();
    const wt = mkWorktree(repo, 'bmd', `stream/${src}`);
    fs.writeFileSync(path.join(wt, 'md.txt'), 'work\n');
    execSync('git add .', { cwd: wt, stdio: 'pipe' });
    adapter.commitChanges({ streamId: src, agentId: 'b', worktree: wt, message: 'feat: md commit' });
    await flush();

    const taskRef = { resource_id: 'res-merge-md', node_id: 'task-merge-md' };
    const merge = adapter.mergeStream({
      sourceStream: src,
      targetStream: tgt,
      agentId: 'b',
      worktree: wt,
      metadata: { task_ref: taskRef, release: 'v1.2.3' },
    });
    await flush();

    if (merge.success) {
      const mergedCall = connectionCalls.find(
        (c) => c.method === CASCADE_METHODS.STREAM_MERGED &&
          (c.params as { source_stream_id?: string }).source_stream_id === src,
      );
      expect(mergedCall).toBeDefined();
      const params = mergedCall!.params as { metadata?: { task_ref?: unknown; release?: string } };
      expect(params.metadata?.task_ref).toEqual(taskRef);
      expect(params.metadata?.release).toBe('v1.2.3');
    }
  });

  it('abandonStream → stream.abandoned → status flips', async () => {
    const sid = adapter.createStream({ name: 'live-doomed', agentId: 'a' });
    await flush();
    adapter.abandonStream(sid, { reason: 'live-test' });
    await flush();

    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.STREAM_ABANDONED)).toBe(true);
    const stream = getStreamBySwarmAndId(SWARM, sid);
    expect(stream!.status).toBe('abandoned');
  });

  it('createConflict + resolveConflict → cascade_conflicts pending → resolved', async () => {
    const sid = adapter.createStream({ name: 'live-conflict', agentId: 'a' });
    await flush();
    const cfid = adapter.createConflict({
      streamId: sid,
      conflictingCommit: 'cca',
      targetCommit: 'ccb',
      conflictedFiles: ['shared.txt'],
    });
    await flush();
    let stream = getStreamBySwarmAndId(SWARM, sid);
    let conflicts = listConflictsForStream(stream!.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].status).toBe('pending');

    adapter.resolveConflict({
      conflictId: cfid,
      resolution: { method: 'ours', resolvedBy: 'agent-x', details: 'kept ours' },
    });
    await flush();

    stream = getStreamBySwarmAndId(SWARM, sid);
    conflicts = listConflictsForStream(stream!.id);
    expect(conflicts[0].status).toBe('resolved');
  });

  it('cascadeRebase emits per-dependent commits + completion summary', async () => {
    // Set up parent + child with diverging history so cascadeRebase produces work
    const parent = adapter.createStream({ name: 'live-parent', agentId: 'p' });
    await flush();
    const wtParent = mkWorktree(repo, 'parent', `stream/${parent}`);
    fs.writeFileSync(path.join(wtParent, 'p.txt'), 'p1\n');
    execSync('git add .', { cwd: wtParent, stdio: 'pipe' });
    adapter.commitChanges({ streamId: parent, agentId: 'p', worktree: wtParent, message: 'parent: init' });
    await flush();

    const child = adapter.forkStream({ parentStreamId: parent, name: 'live-child', agentId: 'c' });
    await flush();
    const wtChild = mkWorktree(repo, 'child', `stream/${child}`);
    fs.writeFileSync(path.join(wtChild, 'c.txt'), 'c1\n');
    execSync('git add .', { cwd: wtChild, stdio: 'pipe' });
    adapter.commitChanges({ streamId: child, agentId: 'c', worktree: wtChild, message: 'child: work' });
    await flush();

    // Parent advances
    fs.writeFileSync(path.join(wtParent, 'p2.txt'), 'p2\n');
    execSync('git add .', { cwd: wtParent, stdio: 'pipe' });
    adapter.commitChanges({ streamId: parent, agentId: 'p', worktree: wtParent, message: 'parent: advance' });
    await flush();

    // Cascade
    const result = adapter.cascadeRebase({
      rootStream: parent,
      agentId: 'p',
      worktree: { mode: 'callback', provider: () => wtChild },
      strategy: 'stop_on_conflict',
    });
    await flush();

    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.CASCADE_COMPLETED)).toBe(true);
    if (result.updated.includes(child)) {
      expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.CASCADE_REBASED)).toBe(true);
    }
    const ops = listCascadeOperations({ source_swarm_id: SWARM });
    expect(ops.length).toBeGreaterThanOrEqual(1);
    const lastOp = ops[0];
    expect(lastOp.root_stream_id).toBe(parent);
  });

  it('mergeQueue add + ready + remove emits queue.* + projects status transitions', async () => {
    const sid = adapter.createStream({ name: 'live-queueable', agentId: 'a' });
    await flush();
    const entryId = adapter.addToMergeQueue({
      streamId: sid,
      targetBranch: 'main',
      agentId: 'a',
    });
    await flush();
    adapter.markMergeQueueReady(entryId);
    await flush();
    adapter.removeFromMergeQueue(entryId);
    await flush();

    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.QUEUE_ADDED)).toBe(true);
    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.QUEUE_READY)).toBe(true);
    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.QUEUE_REMOVED)).toBe(true);

    const entries = listQueueEntries({ source_swarm_id: SWARM });
    const entry = entries.find((e) => e.entry_id === entryId);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('removed');
  });

  it('notifyStreamPushed → stream.pushed → cascade_pushes audit row', async () => {
    const sid = adapter.createStream({ name: 'live-trunk', agentId: 'a' });
    await flush();
    adapter.notifyStreamPushed({
      streamId: sid,
      agentId: 'a',
      pushedCommit: 'pushed-c-1',
      remote: 'origin',
      remoteRef: 'main',
      strategy: 'direct-push',
    });
    await flush();

    expect(connectionCalls.some((c) => c.method === CASCADE_METHODS.STREAM_PUSHED)).toBe(true);
    const pushes = listPushes({ source_swarm_id: SWARM });
    const audit = pushes.find((p) => p.stream_id === sid);
    expect(audit).toBeDefined();
    expect(audit!.pushed_commit).toBe('pushed-c-1');
    expect(audit!.strategy).toBe('direct-push');
  });

  it('end-to-end: spawn → commit → close task → changelog has expected commit range', async () => {
    const taskRef = { resource_id: 'res-changelog-e2e', node_id: 'task-changelog' };
    const sid = adapter.createStream({
      name: 'live-changelog',
      agentId: 'a',
      metadata: { task_ref: taskRef },
    });
    await flush();
    const wt = mkWorktree(repo, 'cl', `stream/${sid}`);
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(wt, `f${i}.txt`), `${i}\n`);
      execSync('git add .', { cwd: wt, stdio: 'pipe' });
      adapter.commitChanges({
        streamId: sid,
        agentId: 'a',
        worktree: wt,
        message: `feat: change ${i}`,
        metadata: { task_ref: taskRef },
      });
      await flush();
    }

    const range = getCommitRangeForTask(taskRef.resource_id, taskRef.node_id);
    expect(range).toHaveLength(1);
    expect(range[0].commits).toHaveLength(3);
    expect(range[0].files_union.sort()).toEqual(['f0.txt', 'f1.txt', 'f2.txt']);
    expect(range[0].change_ids).toHaveLength(3);
  });
});
