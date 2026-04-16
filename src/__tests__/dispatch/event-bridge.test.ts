/**
 * Tests for the dispatch event bridge — verifies that swarm-dispatch events
 * (completed, dead, retrying, cancelled) correctly update dispatch rows.
 *
 * Rather than testing setup.ts directly (which requires mocking the full
 * orchestrator + swarm-dispatch dynamic import), we test the event-handler
 * logic by simulating the same DAL calls the bridge makes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as dispatches from '../../db/dal/dispatches.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('event-bridge');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'event-bridge.db');

function seedRunningDispatch(): dispatches.Dispatch {
  const d = dispatches.createDispatch({
    spec_resource_id: 'res_test',
    spec_id: 'c-test',
    target_swarm_id: 'swarm_test',
    initiator_type: 'user',
    initiator_id: 'agent_test',
  });
  dispatches.claimDispatch(d.id, 'orch-1');
  return dispatches.findDispatchById(d.id)!;
}

/**
 * Simulate the event bridge handlers from setup.ts.
 * These mirror the exact DAL calls made in the onEvent callback.
 */
function handleCompleted(taskId: string, attempt: number, turnCount: number) {
  dispatches.updateDispatchStatus(taskId, 'complete', { summary: 'Agent completed successfully' });
  dispatches.updateDispatchAttemptTurn(taskId, attempt, turnCount);
}

function handleDead(taskId: string, lastError: string | undefined, attempts: number) {
  dispatches.updateDispatchStatus(taskId, 'failed', {
    error: lastError ?? 'All retry attempts exhausted',
    summary: `Failed after ${attempts} attempt(s)`,
  });
  dispatches.updateDispatchAttemptTurn(taskId, attempts, 0);
}

function handleRetrying(taskId: string, attempt: number) {
  dispatches.updateDispatchAttemptTurn(taskId, attempt, 0);
}

function handleCancelled(taskId: string) {
  const dispatch = dispatches.findDispatchById(taskId);
  if (dispatch && dispatch.status !== 'cancelled' && dispatch.status !== 'complete' && dispatch.status !== 'failed') {
    dispatches.cancelDispatch(taskId);
  }
}

describe('dispatch event bridge', () => {
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
  // completed event
  // ==========================================================================

  describe('completed event', () => {
    it('marks dispatch as complete with summary', () => {
      const d = seedRunningDispatch();
      handleCompleted(d.id, 1, 3);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('complete');
      expect(updated.outcome?.summary).toBe('Agent completed successfully');
      expect(updated.attempt).toBe(1);
      expect(updated.turn_count).toBe(3);
    });
  });

  // ==========================================================================
  // dead event (retries exhausted)
  // ==========================================================================

  describe('dead event', () => {
    it('marks dispatch as failed with error and attempt count', () => {
      const d = seedRunningDispatch();
      handleDead(d.id, 'No ACP agent available', 4);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('failed');
      expect(updated.outcome?.error).toBe('No ACP agent available');
      expect(updated.outcome?.summary).toBe('Failed after 4 attempt(s)');
      expect(updated.attempt).toBe(4);
    });

    it('uses default error message when lastError is undefined', () => {
      const d = seedRunningDispatch();
      handleDead(d.id, undefined, 3);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.outcome?.error).toBe('All retry attempts exhausted');
    });
  });

  // ==========================================================================
  // retrying event
  // ==========================================================================

  describe('retrying event', () => {
    it('updates attempt count while dispatch stays running', () => {
      const d = seedRunningDispatch();
      expect(d.attempt).toBe(0);

      handleRetrying(d.id, 2);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('running'); // unchanged
      expect(updated.attempt).toBe(2);
    });

    it('increments on successive retries', () => {
      const d = seedRunningDispatch();

      handleRetrying(d.id, 1);
      handleRetrying(d.id, 2);
      handleRetrying(d.id, 3);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.attempt).toBe(3);
    });
  });

  // ==========================================================================
  // cancelled event
  // ==========================================================================

  describe('cancelled event', () => {
    it('cancels a running dispatch', () => {
      const d = seedRunningDispatch();
      handleCancelled(d.id);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('cancelled');
    });

    it('is idempotent on already-cancelled dispatch', () => {
      const d = seedRunningDispatch();
      dispatches.cancelDispatch(d.id);

      // Should not throw
      handleCancelled(d.id);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('cancelled');
    });

    it('does not re-cancel a completed dispatch', () => {
      const d = seedRunningDispatch();
      dispatches.updateDispatchStatus(d.id, 'complete');

      handleCancelled(d.id);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('complete'); // unchanged
    });
  });

  // ==========================================================================
  // Full lifecycle simulation
  // ==========================================================================

  describe('full lifecycle', () => {
    it('queued → claimed → retrying(1) → retrying(2) → retrying(3) → dead', () => {
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_test',
        spec_id: 'c-lifecycle',
        target_swarm_id: 'swarm_test',
        initiator_type: 'user',
        initiator_id: 'agent_test',
      });

      // Claim
      dispatches.claimDispatch(d.id, 'orch-1');
      expect(dispatches.findDispatchById(d.id)!.status).toBe('running');

      // Retry attempts
      handleRetrying(d.id, 1);
      expect(dispatches.findDispatchById(d.id)!.attempt).toBe(1);

      handleRetrying(d.id, 2);
      expect(dispatches.findDispatchById(d.id)!.attempt).toBe(2);

      handleRetrying(d.id, 3);
      expect(dispatches.findDispatchById(d.id)!.attempt).toBe(3);

      // Dead
      handleDead(d.id, 'Swarm unreachable', 4);
      const final = dispatches.findDispatchById(d.id)!;
      expect(final.status).toBe('failed');
      expect(final.attempt).toBe(4);
      expect(final.outcome?.error).toBe('Swarm unreachable');
    });

    it('queued → claimed → completed on first try', () => {
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_test',
        spec_id: 'c-happy',
        target_swarm_id: 'swarm_test',
        initiator_type: 'user',
        initiator_id: 'agent_test',
      });

      dispatches.claimDispatch(d.id, 'orch-1');
      handleCompleted(d.id, 1, 0);

      const final = dispatches.findDispatchById(d.id)!;
      expect(final.status).toBe('complete');
      expect(final.attempt).toBe(1);
      expect(final.turn_count).toBe(0);
      expect(final.outcome?.summary).toBe('Agent completed successfully');
    });
  });
});
