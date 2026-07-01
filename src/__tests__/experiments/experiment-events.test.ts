/**
 * Locks the fan-out contract for `broadcastExperimentLifecycleEvent` — every
 * experiment lifecycle event must reach BOTH the fleet `map:experiments`
 * channel and the per-experiment `experiment:${id}` channel (the same symmetry
 * discipline as swarm-events / workspace-events).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { broadcastToChannel } from '../../realtime/index.js';
import { broadcastExperimentLifecycleEvent } from '../../realtime/experiment-events.js';

describe('broadcastExperimentLifecycleEvent', () => {
  beforeEach(() => {
    vi.mocked(broadcastToChannel).mockClear();
  });

  it('fans out to BOTH map:experiments and experiment:${id}', () => {
    broadcastExperimentLifecycleEvent('exp_abc', {
      type: 'experiment.candidate',
      data: { experiment_id: 'exp_abc', candidate_ref: 'c1', promoted: true },
    });

    expect(vi.mocked(broadcastToChannel)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(broadcastToChannel)).toHaveBeenCalledWith(
      'map:experiments',
      expect.objectContaining({ type: 'experiment.candidate' }),
    );
    expect(vi.mocked(broadcastToChannel)).toHaveBeenCalledWith(
      'experiment:exp_abc',
      expect.objectContaining({ type: 'experiment.candidate' }),
    );
  });

  it('delivers the same event object to both channels', () => {
    const event = {
      type: 'experiment.run_finished' as const,
      data: { experiment_id: 'exp_x', run_id: 'exrun_1', status: 'complete' },
    };
    broadcastExperimentLifecycleEvent('exp_x', event);
    const calls = vi.mocked(broadcastToChannel).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toBe(calls[1][1]); // same reference, not a clone
  });
});
