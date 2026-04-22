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
import { finalizeDispatch } from '../../dispatch/finalize.js';
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
 * These mirror the exact calls made in the onEvent callback.
 *
 * Narrative (summary/error) is agent-owned via map/dispatches/report; the
 * bridge just drives the status transition and records observed facts
 * (attempt/turn_count, attempts_history). finalizeDispatch joins cascade
 * artifacts if any exist.
 */
function handleCompleted(taskId: string, attempt: number, turnCount: number) {
  finalizeDispatch(taskId, 'complete');
  dispatches.updateDispatchAttemptTurn(taskId, attempt, turnCount);
}

function handleDead(taskId: string, _lastError: string | undefined, attempts: number) {
  finalizeDispatch(taskId, 'failed');
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
    it('marks dispatch as complete; outcome stays null when agent did not report', () => {
      const d = seedRunningDispatch();
      handleCompleted(d.id, 1, 3);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('complete');
      // No cascade artifacts seeded, no agent report → no narrative to
      // persist. finalizeDispatch writes null rather than an empty shell.
      expect(updated.outcome).toBeNull();
      expect(updated.attempt).toBe(1);
      expect(updated.turn_count).toBe(3);
    });
  });

  // ==========================================================================
  // dead event (retries exhausted)
  // ==========================================================================

  describe('dead event', () => {
    it('marks dispatch as failed; observed attempt count persists on the row', () => {
      const d = seedRunningDispatch();
      handleDead(d.id, 'No ACP agent available', 4);

      const updated = dispatches.findDispatchById(d.id)!;
      expect(updated.status).toBe('failed');
      // Narrative is agent-owned; without an agent report, outcome is null.
      // The observable facts live on the row + attempts_history.
      expect(updated.outcome).toBeNull();
      expect(updated.attempt).toBe(4);
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
      // Outcome is null when no agent report; lastError is preserved by the
      // real bridge via attempts_history (tested in upsertDispatchAttempt DAL
      // tests), not via outcome.error.
      expect(final.outcome).toBeNull();
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
      expect(final.outcome).toBeNull();
    });
  });
});
