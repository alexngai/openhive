/**
 * Locks the fan-out contract for `broadcastSwarmLifecycleEvent`.
 *
 * Regression guard for the "we forgot one of the two channels" bugs that
 * motivated extracting this helper:
 *   1. `node_registered` was emitted only on `map:swarm:${id}` — fleet
 *      consumers (chat picker via `useSwarmRealtime`) silently missed it.
 *   2. `node_registered` MAP-protocol path missed BOTH channels — agents
 *      spawned inside an already-online macro-agent were invisible to
 *      the picker until reload.
 *
 * Adding a new lifecycle event type to the union should require zero
 * changes at call sites — the helper handles fan-out. These tests pin
 * the contract so a future refactor can't quietly drop one of the
 * channels for a single event type.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { broadcastToChannel } from '../../realtime/index.js';
import { broadcastSwarmLifecycleEvent } from '../../realtime/swarm-events.js';

describe('broadcastSwarmLifecycleEvent', () => {
  beforeEach(() => {
    vi.mocked(broadcastToChannel).mockClear();
  });

  it('fans out to BOTH map:discovery and map:swarm:${id}', () => {
    broadcastSwarmLifecycleEvent('swarm-abc', {
      type: 'swarm_registered',
      data: { swarm_id: 'swarm-abc', name: 'foo', map_endpoint: 'ws://x' },
    });

    expect(vi.mocked(broadcastToChannel)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(broadcastToChannel)).toHaveBeenCalledWith(
      'map:discovery',
      expect.objectContaining({ type: 'swarm_registered' }),
    );
    expect(vi.mocked(broadcastToChannel)).toHaveBeenCalledWith(
      'map:swarm:swarm-abc',
      expect.objectContaining({ type: 'swarm_registered' }),
    );
  });

  it('delivers the SAME event object to both channels (not a clone)', () => {
    // Subscribers MUST receive identical payloads on both channels —
    // anything else would mean per-swarm and fleet consumers see
    // divergent data for the same logical event.
    const event = {
      type: 'node_registered' as const,
      data: { swarm_id: 'sw-1', node_id: 'n-1', map_agent_id: 'a-1', role: 'coordinator' },
    };
    broadcastSwarmLifecycleEvent('sw-1', event);

    const calls = vi.mocked(broadcastToChannel).mock.calls;
    expect(calls).toHaveLength(2);
    // Both call's second arg should reference the exact same object
    expect(calls[0][1]).toBe(event);
    expect(calls[1][1]).toBe(event);
  });

  it.each([
    'swarm_registered',
    'swarm_offline',
    'swarm_heartbeat',
    'swarm.status_changed',
    'node_registered',
    'connection_degraded',
    'connection_recovered',
  ] as const)('routes %s to both channels', (type) => {
    broadcastSwarmLifecycleEvent('sw-x', {
      type,
      data: { swarm_id: 'sw-x' },
    });

    const channels = vi.mocked(broadcastToChannel).mock.calls.map(c => c[0]);
    expect(channels).toContain('map:discovery');
    expect(channels).toContain('map:swarm:sw-x');
  });

  it('preserves the swarmId verbatim in the channel name (no escaping)', () => {
    // Some swarm IDs contain dashes or underscores; the channel name
    // is `map:swarm:${id}` raw. Subscribers compose the name the same
    // way, so any transformation here would silently break delivery.
    broadcastSwarmLifecycleEvent('swarm_W4kw3sd-abc', {
      type: 'swarm.status_changed',
      data: { swarm_id: 'swarm_W4kw3sd-abc', status: 'online' },
    });

    expect(vi.mocked(broadcastToChannel)).toHaveBeenCalledWith(
      'map:swarm:swarm_W4kw3sd-abc',
      expect.anything(),
    );
  });
});
