/**
 * E2E lifecycle: spec dispatch → linked tasks captured → orchestrator claim
 * → advance-on-start advances linked tasks → terminal transition via
 * finalizeDispatch enriches outcome.artifacts from cascade_streams joined
 * by (task_resource_id, task_node_id).
 *
 * Exercises the three seams wired together; the getTaskInternal /
 * updateTaskInternal surface is stubbed because the opentasks daemon isn't
 * booted in this process. The stubs stand in for the local / remote routing
 * the real helpers perform.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';

const TEST_ROOT = testRoot('dispatch-lifecycle-cascade');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'lifecycle.db');

// Backing store for the mocked opentasks surface. Keyed by `${resource_id}:${node_id}`.
const fakeNodes = new Map<string, { id: string; status: string }>();

vi.mock('../../map/task-handler.js', () => ({
  getTaskInternal: vi.fn(async (target: { resource_id: string }, nodeId: string) => {
    return fakeNodes.get(`${target.resource_id}:${nodeId}`) ?? null;
  }),
  updateTaskInternal: vi.fn(
    async (target: { resource_id: string }, nodeId: string, updates: { status?: string }) => {
      const key = `${target.resource_id}:${nodeId}`;
      const current = fakeNodes.get(key);
      if (current && updates.status) {
        fakeNodes.set(key, { ...current, status: updates.status });
      }
      return current ?? null;
    },
  ),
}));

// Import under test AFTER vi.mock so the module resolves against the stubs.
import { finalizeDispatch } from '../../dispatch/finalize.js';
import { advanceLinkedTasksOnStart } from '../../dispatch/start.js';
import { getTaskInternal, updateTaskInternal } from '../../map/task-handler.js';

function seedCascadeStream(input: {
  source_swarm_id: string;
  stream_id: string;
  source_agent_id: string;
  task_resource_id: string;
  task_node_id: string;
}) {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO cascade_streams
       (id, stream_id, source_swarm_id, source_agent_id, name, status,
        is_local_mode, task_resource_id, task_node_id)
     VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
  ).run(
    `cs-${input.stream_id}`,
    input.stream_id,
    input.source_swarm_id,
    input.source_agent_id,
    input.stream_id,
    input.task_resource_id,
    input.task_node_id,
  );
}

describe('dispatch lifecycle → cascade artifacts (e2e)', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM dispatches').run();
    getDatabase().prepare('DELETE FROM dispatch_linked_tasks').run();
    getDatabase().prepare('DELETE FROM cascade_streams').run();
    fakeNodes.clear();
    vi.mocked(getTaskInternal).mockClear();
    vi.mocked(updateTaskInternal).mockClear();
  });

  it('captures linked tasks at dispatch creation', () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'spec-a',
      target_swarm_id: 'swarm_1',
      initiator_type: 'user',
      initiator_id: 'agent_user',
    });
    dispatchesDAL.addDispatchLinkedTasks(d.id, [
      { resource_id: 'res_spec', node_id: 't-1' },
      { resource_id: 'res_spec', node_id: 't-2' },
    ]);

    const refs = dispatchesDAL.getDispatchLinkedTasks(d.id);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.node_id).sort()).toEqual(['t-1', 't-2']);
    expect(refs.every((r) => r.advanced_on_start === false)).toBe(true);
  });

  it('advances only tasks currently in `open` and marks them advanced', async () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'spec-a',
      target_swarm_id: 'swarm_1',
      initiator_type: 'user',
      initiator_id: 'agent_user',
    });
    dispatchesDAL.addDispatchLinkedTasks(d.id, [
      { resource_id: 'res_spec', node_id: 't-open' },
      { resource_id: 'res_spec', node_id: 't-done' },
      { resource_id: 'res_spec', node_id: 't-missing' },
    ]);
    fakeNodes.set('res_spec:t-open', { id: 't-open', status: 'open' });
    fakeNodes.set('res_spec:t-done', { id: 't-done', status: 'completed' });
    // t-missing intentionally absent — simulates a remote-only task.

    await advanceLinkedTasksOnStart(d.id);

    expect(updateTaskInternal).toHaveBeenCalledTimes(1);
    expect(updateTaskInternal).toHaveBeenCalledWith(
      { resource_id: 'res_spec' },
      't-open',
      { status: 'in_progress' },
    );

    const refs = dispatchesDAL.getDispatchLinkedTasks(d.id);
    const advancedMap = Object.fromEntries(refs.map((r) => [r.node_id, r.advanced_on_start]));
    expect(advancedMap['t-open']).toBe(true);
    expect(advancedMap['t-done']).toBe(false);
    expect(advancedMap['t-missing']).toBe(false);
  });

  it('advance is idempotent on re-entry — already-advanced tasks are skipped', async () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'spec-a',
      target_swarm_id: 'swarm_1',
      initiator_type: 'user',
      initiator_id: 'u',
    });
    dispatchesDAL.addDispatchLinkedTasks(d.id, [
      { resource_id: 'res_spec', node_id: 't-1' },
    ]);
    fakeNodes.set('res_spec:t-1', { id: 't-1', status: 'open' });

    await advanceLinkedTasksOnStart(d.id);
    expect(updateTaskInternal).toHaveBeenCalledTimes(1);

    // Second invocation (simulating a retry / re-claim)
    await advanceLinkedTasksOnStart(d.id);
    expect(updateTaskInternal).toHaveBeenCalledTimes(1); // still one, not two
  });

  it('finalizeDispatch enriches outcome.artifacts with cascade_streams joined by task_ref', () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'spec-a',
      target_swarm_id: 'swarm_1',
      initiator_type: 'user',
      initiator_id: 'u',
    });
    dispatchesDAL.addDispatchLinkedTasks(d.id, [
      { resource_id: 'res_spec', node_id: 't-1' },
      { resource_id: 'res_spec', node_id: 't-2' },
    ]);
    // Two cascade streams matching the two linked tasks, plus a third unrelated
    // stream that must NOT appear in the artifacts.
    seedCascadeStream({
      source_swarm_id: 'swarm_A',
      stream_id: 'stream-feat-1',
      source_agent_id: 'agent-1',
      task_resource_id: 'res_spec',
      task_node_id: 't-1',
    });
    seedCascadeStream({
      source_swarm_id: 'swarm_A',
      stream_id: 'stream-feat-2',
      source_agent_id: 'agent-1',
      task_resource_id: 'res_spec',
      task_node_id: 't-2',
    });
    seedCascadeStream({
      source_swarm_id: 'swarm_B',
      stream_id: 'stream-unrelated',
      source_agent_id: 'agent-2',
      task_resource_id: 'res_other',
      task_node_id: 't-99',
    });

    const result = finalizeDispatch(d.id, 'complete', { summary: 'done' });

    expect(result?.status).toBe('complete');
    expect(result?.outcome?.summary).toBe('done');

    const refs = (result?.outcome?.artifacts ?? []).map((a) => a.ref).sort();
    expect(refs).toEqual(['swarm_A/stream-feat-1', 'swarm_A/stream-feat-2']);
    expect(result?.outcome?.artifacts?.every((a) => a.kind === 'cascade_stream')).toBe(true);
  });

  it('finalizeDispatch merges agent-supplied artifacts with cascade artifacts (deduped)', () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'spec-a',
      target_swarm_id: 'swarm_1',
      initiator_type: 'user',
      initiator_id: 'u',
    });
    dispatchesDAL.addDispatchLinkedTasks(d.id, [
      { resource_id: 'res_spec', node_id: 't-1' },
    ]);
    seedCascadeStream({
      source_swarm_id: 'swarm_A',
      stream_id: 'stream-feat-1',
      source_agent_id: 'agent-1',
      task_resource_id: 'res_spec',
      task_node_id: 't-1',
    });

    const result = finalizeDispatch(d.id, 'complete', {
      summary: 'done',
      artifacts: [
        { kind: 'cascade_stream', ref: 'swarm_A/stream-feat-1' }, // duplicate
        { kind: 'commit', ref: 'main@abc1234' }, // agent-only kind, preserved
      ],
    });

    const artifacts = result?.outcome?.artifacts ?? [];
    expect(artifacts).toHaveLength(2);
    expect(artifacts).toContainEqual({ kind: 'cascade_stream', ref: 'swarm_A/stream-feat-1' });
    expect(artifacts).toContainEqual({ kind: 'commit', ref: 'main@abc1234' });
  });

  it('finalizeDispatch with no linked tasks and no agent artifacts writes a bare outcome', () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'spec-a',
      target_swarm_id: 'swarm_1',
      initiator_type: 'user',
      initiator_id: 'u',
    });

    const result = finalizeDispatch(d.id, 'complete', { summary: 'done' });
    expect(result?.status).toBe('complete');
    expect(result?.outcome?.summary).toBe('done');
    expect(result?.outcome?.artifacts).toBeUndefined();
  });

  it('full lifecycle — create → addLinks → claim → advance → finalize → outcome reflects the cascade work', async () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'spec-a',
      target_swarm_id: 'swarm_1',
      initiator_type: 'user',
      initiator_id: 'u',
    });
    dispatchesDAL.addDispatchLinkedTasks(d.id, [
      { resource_id: 'res_spec', node_id: 't-1' },
    ]);
    fakeNodes.set('res_spec:t-1', { id: 't-1', status: 'open' });

    // Orchestrator claims the dispatch
    const claim = dispatchesDAL.claimDispatch(d.id, 'test-orchestrator');
    expect(claim.success).toBe(true);
    expect(dispatchesDAL.findDispatchById(d.id)?.status).toBe('running');

    // Orchestrator fires advance-on-start
    await advanceLinkedTasksOnStart(d.id);
    expect(fakeNodes.get('res_spec:t-1')?.status).toBe('in_progress');

    // Later, a cascade stream opens on the task
    seedCascadeStream({
      source_swarm_id: 'swarm_A',
      stream_id: 'stream-feat-1',
      source_agent_id: 'agent-1',
      task_resource_id: 'res_spec',
      task_node_id: 't-1',
    });

    // Terminal transition
    const final = finalizeDispatch(d.id, 'complete', { summary: 'work done' });

    expect(final?.status).toBe('complete');
    expect(final?.outcome?.artifacts).toEqual([
      { kind: 'cascade_stream', ref: 'swarm_A/stream-feat-1' },
    ]);
  });
});
