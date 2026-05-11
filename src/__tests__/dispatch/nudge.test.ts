/**
 * Tests for dispatch thread nudge — hub → sidecar advisory push.
 *
 * Covers Phase 7 of dispatch-inbox-threads:
 * - sendDispatchNudge sends x-dispatch/nudge to target swarm
 * - No-ops gracefully when dispatch not found
 * - No-ops when target_swarm_id is missing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../db/dal/dispatches.js', () => ({
  findDispatchById: vi.fn(),
}));

vi.mock('../../map/sync-listener.js', () => ({
  sendToSwarm: vi.fn(),
}));

import { sendDispatchNudge } from '../../dispatch/nudge.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import { sendToSwarm } from '../../map/sync-listener.js';

const mockFindDispatch = dispatchesDAL.findDispatchById as ReturnType<typeof vi.fn>;
const mockSendToSwarm = sendToSwarm as ReturnType<typeof vi.fn>;

describe('sendDispatchNudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends x-dispatch/nudge to the target swarm', () => {
    mockFindDispatch.mockReturnValue({
      id: 'd1',
      target_swarm_id: 'swarm-abc',
      status: 'running',
    });

    sendDispatchNudge('d1', 'dispatch-conv-d1');

    expect(mockSendToSwarm).toHaveBeenCalledWith('swarm-abc', {
      jsonrpc: '2.0',
      method: 'x-dispatch/nudge',
      params: {
        dispatch_id: 'd1',
        conversation_id: 'dispatch-conv-d1',
      },
    });
  });

  it('no-ops when dispatch not found', () => {
    mockFindDispatch.mockReturnValue(null);

    sendDispatchNudge('nonexistent', 'conv-x');

    expect(mockSendToSwarm).not.toHaveBeenCalled();
  });

  it('no-ops when target_swarm_id is falsy', () => {
    mockFindDispatch.mockReturnValue({
      id: 'd2',
      target_swarm_id: '',
      status: 'running',
    });

    sendDispatchNudge('d2', 'conv-y');

    expect(mockSendToSwarm).not.toHaveBeenCalled();
  });

  it('does not throw when sendToSwarm throws', () => {
    mockFindDispatch.mockReturnValue({
      id: 'd3',
      target_swarm_id: 'swarm-xyz',
      status: 'running',
    });
    mockSendToSwarm.mockImplementation(() => {
      throw new Error('connection lost');
    });

    // Should not throw — nudge is best effort
    expect(() => sendDispatchNudge('d3', 'conv-z')).not.toThrow();
  });
});
