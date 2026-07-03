/**
 * Tests for createOpenHiveDispatchSource — the DispatchTaskSource adapter.
 *
 * Uses a real SQLite database (same pattern as DAL tests) so the adapter's
 * SQL queries are exercised against the actual schema.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import {
  createOpenHiveDispatchSource,
  reconcileShouldStop,
} from '../../dispatch/openhive-source.js';
import type { SpecContentFetcher } from '../../dispatch/openhive-source.js';
import type { DispatchTask, DispatchRecord } from 'swarm-dispatch';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('dispatch-source');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'dispatch-source.db');

const mockFetcher: SpecContentFetcher = {
  async fetch(_resourceId: string, _specId: string) {
    return {
      title: 'Test Spec',
      content: '## Goals\n\nDo the thing.',
      tasks: [
        { id: 't-1', title: 'Task one', status: 'open' },
      ],
    };
  },
};

const nullFetcher: SpecContentFetcher = {
  async fetch() { return null; },
};

function seedDispatch(overrides: Partial<dispatchesDAL.CreateDispatchInput> = {}) {
  return dispatchesDAL.createDispatch({
    spec_resource_id: 'res_test',
    spec_id: 'c-test',
    target_swarm_id: 'swarm_test',
    initiator_type: 'user',
    initiator_id: 'agent_test',
    ...overrides,
  });
}

describe('createOpenHiveDispatchSource', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM dispatches').run();
  });

  // ==========================================================================
  // queryReady
  // ==========================================================================

  describe('queryReady', () => {
    it('returns queued dispatches as DispatchTasks', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      const tasks = await source.queryReady();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(d.id);
      expect(tasks[0].status).toBe('open');
      expect(tasks[0].metadata?.spec_resource_id).toBe('res_test');
    });

    it('excludes non-queued dispatches', async () => {
      const d = seedDispatch();
      dispatchesDAL.claimDispatch(d.id, 'orch-1');
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      const tasks = await source.queryReady();
      expect(tasks).toHaveLength(0);
    });

    it('respects limit', async () => {
      seedDispatch({ spec_id: 'c-1' });
      seedDispatch({ spec_id: 'c-2' });
      seedDispatch({ spec_id: 'c-3' });
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      const tasks = await source.queryReady({ limit: 2 });
      expect(tasks).toHaveLength(2);
    });
  });

  // ==========================================================================
  // claim / release
  // ==========================================================================

  describe('claim', () => {
    it('claims and returns fence token', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      const result = await source.claim(d.id, 'test-claimant');
      expect(result.success).toBe(true);
      expect(result.fence).toBeTruthy();

      const updated = dispatchesDAL.findDispatchById(d.id)!;
      expect(updated.status).toBe('running');
    });

    it('returns success=false for already-claimed dispatch', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      await source.claim(d.id, 'test-claimant');
      const result = await source.claim(d.id, 'test-claimant-2');
      expect(result.success).toBe(false);
    });
  });

  describe('release', () => {
    it('releases claim and returns to queued', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      const { fence } = await source.claim(d.id, 'test-claimant');
      await source.release(d.id, 'test-claimant', fence);

      const updated = dispatchesDAL.findDispatchById(d.id)!;
      expect(updated.status).toBe('queued');
      expect(updated.lease_token).toBeNull();
    });
  });

  // ==========================================================================
  // transition
  // ==========================================================================

  describe('transition', () => {
    it('transitions start without writing outcome', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      await source.transition(d.id, 'start');
      const updated = dispatchesDAL.findDispatchById(d.id)!;
      expect(updated.status).toBe('running');
      expect(updated.outcome).toBeNull();
    });

    it('transitions complete without writing outcome (event bridge does that)', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      await source.transition(d.id, 'complete');
      const updated = dispatchesDAL.findDispatchById(d.id)!;
      expect(updated.status).toBe('complete');
      expect(updated.outcome).toBeNull();
    });

    it('transitions fail without writing outcome (event bridge does that)', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      await source.transition(d.id, 'fail');
      const updated = dispatchesDAL.findDispatchById(d.id)!;
      expect(updated.status).toBe('failed');
      expect(updated.outcome).toBeNull();
    });
  });

  // ==========================================================================
  // getTask
  // ==========================================================================

  describe('getTask', () => {
    it('returns full task with spec content when fetcher succeeds', async () => {
      const d = seedDispatch({ prompt_override: 'Extra instructions' });
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      const task = await source.getTask(d.id);
      expect(task.id).toBe(d.id);
      expect(task.title).toBe('Test Spec');
      expect(task.content).toContain('# Test Spec');
      expect(task.content).toContain('## Goals');
      expect(task.content).toContain('## Tasks');
      expect(task.content).toContain('`t-1` — Task one');
      expect(task.content).toContain('## Additional instructions');
      expect(task.content).toContain('Extra instructions');
    });

    it('falls back to prompt_override when fetcher returns null', async () => {
      const d = seedDispatch({ prompt_override: 'Just do it' });
      const source = createOpenHiveDispatchSource(nullFetcher, 'test-claimant');

      const task = await source.getTask(d.id);
      expect(task.content).toBe('Just do it');
    });

    it('throws for unknown dispatch', async () => {
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');
      await expect(source.getTask('disp_nonexistent')).rejects.toThrow('not found');
    });

    // P4.1: a dispatch row's `role` column (set by the dispatch modal) must
    // surface onto task.metadata.role so swarm-dispatch's chooseExecutor
    // filters the roster by it — even without a loadout to materialize.
    it('surfaces the dispatch row role onto task.metadata for executor selection', async () => {
      const d = seedDispatch({ role: 'reviewer' });
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      const task = await source.getTask(d.id);
      expect(task.metadata?.role).toBe('reviewer');
    });

    it('leaves task.metadata.role unset when the row has no role', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      const task = await source.getTask(d.id);
      expect(task.metadata?.role).toBeUndefined();
    });

    // P4.2: a coordinated-team dispatch surfaces its peer roster (siblings
    // sharing the same team_conversation_id, minus self) + the shared thread id
    // so the prompt builder can name teammates. Swarm name falls back to the id
    // when no map row exists.
    it('surfaces the coordinated-team peer roster onto task.metadata', async () => {
      const a = seedDispatch({ target_swarm_id: 'swarm_a', role: 'planner' });
      const b = seedDispatch({ target_swarm_id: 'swarm_b', role: 'reviewer' });
      dispatchesDAL.setDispatchTeamConversationId(a.id, 'team-conv-abc');
      dispatchesDAL.setDispatchTeamConversationId(b.id, 'team-conv-abc');

      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');
      const task = await source.getTask(a.id);

      expect(task.metadata?.team_conversation_id).toBe('team-conv-abc');
      const peers = task.metadata?.peers as Array<{ swarmName: string; role?: string }>;
      expect(peers).toHaveLength(1);
      expect(peers[0]).toEqual({ swarmName: 'swarm_b', role: 'reviewer' });
    });

    it('omits peers for a non-coordinated dispatch', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');
      const task = await source.getTask(d.id);
      expect(task.metadata?.peers).toBeUndefined();
      expect(task.metadata?.team_conversation_id).toBeUndefined();
    });
  });

  // ==========================================================================
  // isStillActive
  // ==========================================================================

  describe('isStillActive', () => {
    it('returns true for queued dispatch', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');
      expect(await source.isStillActive!(d.id)).toBe(true);
    });

    it('returns true for running dispatch', async () => {
      const d = seedDispatch();
      dispatchesDAL.claimDispatch(d.id, 'orch-1');
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');
      expect(await source.isStillActive!(d.id)).toBe(true);
    });

    it('returns false for cancelled dispatch', async () => {
      const d = seedDispatch();
      dispatchesDAL.cancelDispatch(d.id);
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');
      expect(await source.isStillActive!(d.id)).toBe(false);
    });

    it('returns false for complete dispatch', async () => {
      const d = seedDispatch();
      dispatchesDAL.updateDispatchStatus(d.id, 'complete');
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');
      expect(await source.isStillActive!(d.id)).toBe(false);
    });

    it('returns false for failed dispatch', async () => {
      const d = seedDispatch();
      dispatchesDAL.updateDispatchStatus(d.id, 'failed');
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');
      expect(await source.isStillActive!(d.id)).toBe(false);
    });
  });

  // ==========================================================================
  // listInProgress
  // ==========================================================================

  describe('listInProgress', () => {
    it('returns running dispatches for restart recovery', async () => {
      seedDispatch({ spec_id: 'c-queued' });
      const d2 = seedDispatch({ spec_id: 'c-running' });
      dispatchesDAL.claimDispatch(d2.id, 'orch-1');
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');

      const tasks = await source.listInProgress!();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(d2.id);
    });

    it('returns raw rowToTask output without loadout enrichment (asymmetry is intentional)', async () => {
      // listInProgress is used only for tracker reconstruction at startup.
      // reconstructFromTasks() reads id, claimed_by, metadata.attempt,
      // metadata.role, tags — none of which require enrichment. The
      // orchestrator re-enriches via getTask() (enrichContent) before prompt
      // building on any retry or continuation path. This test locks that
      // contract: listInProgress must not call the spec fetcher.
      let fetcherCallCount = 0;
      const countingFetcher: SpecContentFetcher = {
        async fetch(_resourceId, _specId) {
          fetcherCallCount++;
          return { title: 'T', content: 'c', tasks: [] };
        },
      };

      const d = seedDispatch({ spec_id: 'c-inprogress' });
      dispatchesDAL.claimDispatch(d.id, 'orch-1');

      const source = createOpenHiveDispatchSource(countingFetcher, 'test-claimant');
      const tasks = await source.listInProgress!();

      // Task is returned (basic mapping works).
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(d.id);
      // Spec fetcher was NOT called — enrichment is skipped for listInProgress.
      expect(fetcherCallCount).toBe(0);
    });
  });

  // ==========================================================================
  // renewClaim
  // ==========================================================================

  describe('renewClaim', () => {
    it('renews with correct fence', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');
      const { fence } = await source.claim(d.id, 'test-claimant');

      const result = await source.renewClaim!(d.id, fence!);
      expect(result.ok).toBe(true);
    });

    it('rejects with wrong fence', async () => {
      const d = seedDispatch();
      const source = createOpenHiveDispatchSource(mockFetcher, 'test-claimant');
      await source.claim(d.id, 'test-claimant');

      const result = await source.renewClaim!(d.id, 'bad-fence');
      expect(result.ok).toBe(false);
    });
  });
});

// ============================================================================
// reconcileShouldStop (P4.5 Layer 1) — pure predicate, no DB needed.
// ============================================================================

describe('reconcileShouldStop', () => {
  const task = (status: string, claimed_by?: string): DispatchTask => ({
    id: 'disp_x',
    title: 't',
    status,
    ...(claimed_by ? { claimed_by } : {}),
  });
  const record = (claimantId = 'orch-1'): DispatchRecord =>
    ({ taskId: 'disp_x', claimantId, role: 'worker' } as DispatchRecord);

  it('stops on a cancelled dispatch (the bug the default missed)', () => {
    expect(reconcileShouldStop(task('cancelled'), record())).toBe(true);
  });

  it('stops on other terminal statuses', () => {
    expect(reconcileShouldStop(task('complete'), record())).toBe(true);
    expect(reconcileShouldStop(task('failed'), record())).toBe(true);
    expect(reconcileShouldStop(task('closed'), record())).toBe(true);
    expect(reconcileShouldStop(task('blocked'), record())).toBe(true);
  });

  it('keeps running active dispatches', () => {
    expect(reconcileShouldStop(task('open'), record())).toBe(false);
    expect(reconcileShouldStop(task('running'), record())).toBe(false);
  });

  it('stops when the claim was stolen by another claimant', () => {
    expect(reconcileShouldStop(task('running', 'orch-2'), record('orch-1'))).toBe(true);
    expect(reconcileShouldStop(task('running', 'orch-1'), record('orch-1'))).toBe(false);
  });
});
