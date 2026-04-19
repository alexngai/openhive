/**
 * DAL tests for dispatch orchestrator helpers — claimDispatch, releaseDispatch,
 * transitionDispatch, renewDispatchClaim, updateDispatchAttemptTurn,
 * listQueuedDispatches, listInProgressDispatches.
 *
 * Exercises V35 schema columns (lease_token, lease_expires_at, attempt, turn_count)
 * against a real SQLite instance.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as dispatches from '../../db/dal/dispatches.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('dispatches-orch');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'dispatches-orch.db');

function seedDispatch(overrides: Partial<dispatches.CreateDispatchInput> = {}): dispatches.Dispatch {
  return dispatches.createDispatch({
    spec_resource_id: 'res_test',
    spec_id: 'c-test',
    target_swarm_id: 'swarm_test',
    initiator_type: 'user',
    initiator_id: 'agent_test',
    ...overrides,
  });
}

describe('dispatches DAL — orchestrator helpers', () => {
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
  // claimDispatch
  // ==========================================================================

  describe('claimDispatch', () => {
    it('claims a queued dispatch and sets lease_token + status=running', () => {
      const d = seedDispatch();
      expect(d.status).toBe('queued');

      const result = dispatches.claimDispatch(d.id, 'orchestrator-1');
      expect(result.success).toBe(true);
      expect(result.fence).toBeTruthy();
      expect(typeof result.fence).toBe('string');

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('running');
      expect(updated.lease_token).toBe(result.fence);
      expect(updated.lease_expires_at).toBeTruthy();
    });

    it('fails to claim an already-running dispatch', () => {
      const d = seedDispatch();
      dispatches.claimDispatch(d.id, 'orchestrator-1');

      const result = dispatches.claimDispatch(d.id, 'orchestrator-2');
      expect(result.success).toBe(false);
    });

    it('fails to claim a cancelled dispatch', () => {
      const d = seedDispatch();
      dispatches.cancelDispatch(d.id);

      const result = dispatches.claimDispatch(d.id, 'orchestrator-1');
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // releaseDispatch
  // ==========================================================================

  describe('releaseDispatch', () => {
    it('releases a claimed dispatch back to queued', () => {
      const d = seedDispatch();
      const { fence } = dispatches.claimDispatch(d.id, 'orch-1');

      dispatches.releaseDispatch(d.id, fence as string);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('queued');
      expect(updated.lease_token).toBeNull();
      expect(updated.lease_expires_at).toBeNull();
    });

    it('rejects release with wrong fence token', () => {
      const d = seedDispatch();
      dispatches.claimDispatch(d.id, 'orch-1');

      dispatches.releaseDispatch(d.id, 'wrong-fence');

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('running'); // not released
    });
  });

  // ==========================================================================
  // transitionDispatch
  // ==========================================================================

  describe('transitionDispatch', () => {
    it('transitions start → running', () => {
      const d = seedDispatch();
      dispatches.transitionDispatch(d.id, 'start');

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('running');
    });

    it('transitions complete with outcome', () => {
      const d = seedDispatch();
      dispatches.claimDispatch(d.id, 'orch-1');

      dispatches.transitionDispatch(d.id, 'complete', undefined, {
        summary: 'All done',
      });

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('complete');
      expect(updated.outcome?.summary).toBe('All done');
    });

    it('transitions fail with error outcome', () => {
      const d = seedDispatch();
      const { fence } = dispatches.claimDispatch(d.id, 'orch-1');

      dispatches.transitionDispatch(d.id, 'fail', fence as string, {
        error: 'ACP agent unavailable',
        summary: 'Failed after 3 attempts',
      });

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('failed');
      expect(updated.outcome?.error).toBe('ACP agent unavailable');
    });

    it('respects fence token on transition', () => {
      const d = seedDispatch();
      const { fence } = dispatches.claimDispatch(d.id, 'orch-1');

      // Wrong fence — should not transition
      dispatches.transitionDispatch(d.id, 'complete', 'wrong-fence');
      expect(dispatches.findDispatchById(d.id)!.status).toBe('running');

      // Right fence — should transition
      dispatches.transitionDispatch(d.id, 'complete', fence as string);
      expect(dispatches.findDispatchById(d.id)!.status).toBe('complete');
    });
  });

  // ==========================================================================
  // renewDispatchClaim
  // ==========================================================================

  describe('renewDispatchClaim', () => {
    it('renews lease with correct fence', () => {
      const d = seedDispatch();
      const { fence } = dispatches.claimDispatch(d.id, 'orch-1');

      const result = dispatches.renewDispatchClaim(d.id, fence as string);
      expect(result.ok).toBe(true);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.lease_token).toBe(fence);
      expect(updated.lease_expires_at).toBeTruthy();
      expect(updated.status).toBe('running');
    });

    it('rejects renewal with wrong fence', () => {
      const d = seedDispatch();
      dispatches.claimDispatch(d.id, 'orch-1');

      const result = dispatches.renewDispatchClaim(d.id, 'wrong-fence');
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  });

  // ==========================================================================
  // updateDispatchAttemptTurn
  // ==========================================================================

  describe('updateDispatchAttemptTurn', () => {
    it('updates attempt and turn_count', () => {
      const d = seedDispatch();
      expect(d.attempt).toBe(0);
      expect(d.turn_count).toBe(0);

      dispatches.updateDispatchAttemptTurn(d.id, 3, 2);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.attempt).toBe(3);
      expect(updated.turn_count).toBe(2);
    });
  });

  // ==========================================================================
  // listQueuedDispatches / listInProgressDispatches
  // ==========================================================================

  describe('listQueuedDispatches', () => {
    it('returns only queued dispatches ordered by created_at ASC', () => {
      const first = seedDispatch({ spec_id: 'c-first' });
      const d2 = seedDispatch({ spec_id: 'c-second' });
      dispatches.claimDispatch(d2.id, 'orch-1'); // d2 is now running

      const queued = dispatches.listQueuedDispatches();
      expect(queued).toHaveLength(1);
      expect(queued[0].id).toBe(first.id);
    });

    it('respects limit', () => {
      seedDispatch({ spec_id: 'c-1' });
      seedDispatch({ spec_id: 'c-2' });
      seedDispatch({ spec_id: 'c-3' });

      const queued = dispatches.listQueuedDispatches(2);
      expect(queued).toHaveLength(2);
    });
  });

  describe('listInProgressDispatches', () => {
    it('returns only running dispatches', () => {
      seedDispatch({ spec_id: 'c-queued' });
      const d2 = seedDispatch({ spec_id: 'c-running' });
      dispatches.claimDispatch(d2.id, 'orch-1');

      const inProgress = dispatches.listInProgressDispatches();
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].id).toBe(d2.id);
    });
  });

  // ==========================================================================
  // V35 column defaults
  // ==========================================================================

  describe('V35 columns', () => {
    it('new dispatches have default values for orchestrator fields', () => {
      const d = seedDispatch();
      expect(d.lease_token).toBeNull();
      expect(d.lease_expires_at).toBeNull();
      expect(d.attempt).toBe(0);
      expect(d.turn_count).toBe(0);
    });
  });

  // ==========================================================================
  // upsertDispatchAttempt (V41 attempts_history)
  // ==========================================================================

  describe('upsertDispatchAttempt', () => {
    it('appends a new attempt when the attempt number is novel', () => {
      const d = seedDispatch();
      dispatches.upsertDispatchAttempt(d.id, {
        attempt: 1,
        started_at: '2026-04-18T10:00:00.000Z',
        status: 'running',
      });

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.attempts_history).toHaveLength(1);
      expect(updated.attempts_history[0]).toMatchObject({
        attempt: 1,
        status: 'running',
      });
    });

    it('merges when upserting an existing attempt', () => {
      const d = seedDispatch();
      dispatches.upsertDispatchAttempt(d.id, {
        attempt: 1,
        started_at: '2026-04-18T10:00:00.000Z',
        status: 'running',
      });
      dispatches.upsertDispatchAttempt(d.id, {
        attempt: 1,
        started_at: '2026-04-18T10:00:00.000Z',
        ended_at: '2026-04-18T10:01:00.000Z',
        status: 'retrying',
        error: 'boom',
        next_retry_at: '2026-04-18T10:02:00.000Z',
      });

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.attempts_history).toHaveLength(1);
      expect(updated.attempts_history[0]).toMatchObject({
        attempt: 1,
        status: 'retrying',
        error: 'boom',
        next_retry_at: '2026-04-18T10:02:00.000Z',
      });
    });

    it('sorts attempts by number when multiple land out of order', () => {
      const d = seedDispatch();
      dispatches.upsertDispatchAttempt(d.id, {
        attempt: 2,
        started_at: '2026-04-18T10:05:00.000Z',
        status: 'running',
      });
      dispatches.upsertDispatchAttempt(d.id, {
        attempt: 1,
        started_at: '2026-04-18T10:00:00.000Z',
        status: 'failed',
      });

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.attempts_history.map((a) => a.attempt)).toEqual([1, 2]);
    });

    it('no-ops for an unknown dispatch id', () => {
      expect(() =>
        dispatches.upsertDispatchAttempt('nonexistent', {
          attempt: 1,
          started_at: '2026-04-18T10:00:00.000Z',
          status: 'running',
        }),
      ).not.toThrow();
    });
  });
});
