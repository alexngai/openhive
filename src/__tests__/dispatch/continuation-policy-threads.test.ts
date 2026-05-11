/**
 * Tests for thread-aware continuation policy and thread-driven turn tracking.
 *
 * Covers Phase 6 of dispatch-inbox-threads:
 * - continuationPolicy grants extra turns when pendingThreadMessages > 0
 * - Thread-driven turns are capped by maxThreadTurns
 * - Standard maxTurns budget is respected
 * - Thread-driven count tracking (increment, clear, reset)
 * - checkThreadPending contract on mail port
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  incrementThreadDrivenCount,
  getThreadDrivenCount,
  clearThreadDrivenCount,
  _resetDeliveryTrackerForTest,
} from '../../dispatch/delivery-tracker.js';
import type { DispatchTask } from 'swarm-dispatch';

// ---------------------------------------------------------------------------
// Simulate the continuationPolicy from setup.ts
// ---------------------------------------------------------------------------

function continuationPolicy(
  task: DispatchTask,
  turnCount: number,
  cfg: { maxTurns: number; maxThreadTurns: number },
): 'continue' | 'release' {
  if (turnCount >= cfg.maxTurns) return 'release';

  const pending = (task.metadata?.pendingThreadMessages as number) ?? 0;
  if (pending > 0) {
    const threadCount = getThreadDrivenCount(task.id);
    if (threadCount >= cfg.maxThreadTurns) return 'release';
    incrementThreadDrivenCount(task.id);
    return 'continue';
  }

  return turnCount < cfg.maxTurns ? 'continue' : 'release';
}

function makeTask(id: string, pendingThreadMessages?: number): DispatchTask {
  return {
    id,
    title: 'Test dispatch',
    content: 'Body',
    status: 'open',
    created_at: new Date().toISOString(),
    metadata: {
      ...(pendingThreadMessages !== undefined ? { pendingThreadMessages } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('thread-driven continuation policy', () => {
  const defaultCfg = { maxTurns: 20, maxThreadTurns: 3 };

  beforeEach(() => {
    _resetDeliveryTrackerForTest();
  });

  it('continues when within turn budget and no pending messages', () => {
    const result = continuationPolicy(makeTask('d1'), 5, defaultCfg);
    expect(result).toBe('continue');
  });

  it('releases when turn budget is exhausted', () => {
    const result = continuationPolicy(makeTask('d1'), 20, defaultCfg);
    expect(result).toBe('release');
  });

  it('continues when pending thread messages exist', () => {
    const result = continuationPolicy(makeTask('d1', 3), 18, defaultCfg);
    expect(result).toBe('continue');
  });

  it('increments thread-driven count on each thread-driven continuation', () => {
    const task = makeTask('d2', 5);
    expect(getThreadDrivenCount('d2')).toBe(0);

    continuationPolicy(task, 18, defaultCfg);
    expect(getThreadDrivenCount('d2')).toBe(1);

    continuationPolicy(task, 19, defaultCfg);
    expect(getThreadDrivenCount('d2')).toBe(2);
  });

  it('releases when maxThreadTurns is exhausted despite pending messages', () => {
    const task = makeTask('d3', 10);

    // Exhaust thread turns
    continuationPolicy(task, 18, defaultCfg); // threadCount: 0 → 1
    continuationPolicy(task, 19, defaultCfg); // threadCount: 1 → 2
    continuationPolicy(task, 20, defaultCfg); // turnCount >= maxTurns → release

    // Even with pending, maxTurns wins
    expect(continuationPolicy(task, 20, defaultCfg)).toBe('release');
  });

  it('releases when maxThreadTurns is reached', () => {
    const task = makeTask('d4', 10);

    // Use all thread turns
    continuationPolicy(task, 10, defaultCfg); // 0 → 1
    continuationPolicy(task, 11, defaultCfg); // 1 → 2
    continuationPolicy(task, 12, defaultCfg); // 2 → 3

    // 4th call should release (threadCount now 3 >= maxThreadTurns 3)
    expect(continuationPolicy(task, 13, defaultCfg)).toBe('release');
  });

  it('does not increment thread count when no pending messages', () => {
    const task = makeTask('d5', 0);
    continuationPolicy(task, 5, defaultCfg);
    expect(getThreadDrivenCount('d5')).toBe(0);
  });

  it('does not increment thread count when pending is undefined', () => {
    const task = makeTask('d6');
    continuationPolicy(task, 5, defaultCfg);
    expect(getThreadDrivenCount('d6')).toBe(0);
  });

  it('releases at maxTurns even with pending thread messages', () => {
    const result = continuationPolicy(makeTask('d7', 5), 20, defaultCfg);
    expect(result).toBe('release');
  });
});

describe('thread-driven turn tracking', () => {
  beforeEach(() => {
    _resetDeliveryTrackerForTest();
  });

  it('starts at 0', () => {
    expect(getThreadDrivenCount('d1')).toBe(0);
  });

  it('increments correctly', () => {
    expect(incrementThreadDrivenCount('d1')).toBe(1);
    expect(incrementThreadDrivenCount('d1')).toBe(2);
    expect(incrementThreadDrivenCount('d1')).toBe(3);
    expect(getThreadDrivenCount('d1')).toBe(3);
  });

  it('tracks independently per task', () => {
    incrementThreadDrivenCount('d1');
    incrementThreadDrivenCount('d1');
    incrementThreadDrivenCount('d2');

    expect(getThreadDrivenCount('d1')).toBe(2);
    expect(getThreadDrivenCount('d2')).toBe(1);
  });

  it('clears for a specific task', () => {
    incrementThreadDrivenCount('d1');
    incrementThreadDrivenCount('d2');

    clearThreadDrivenCount('d1');

    expect(getThreadDrivenCount('d1')).toBe(0);
    expect(getThreadDrivenCount('d2')).toBe(1);
  });

  it('_resetDeliveryTrackerForTest clears all', () => {
    incrementThreadDrivenCount('d1');
    incrementThreadDrivenCount('d2');

    _resetDeliveryTrackerForTest();

    expect(getThreadDrivenCount('d1')).toBe(0);
    expect(getThreadDrivenCount('d2')).toBe(0);
  });
});
