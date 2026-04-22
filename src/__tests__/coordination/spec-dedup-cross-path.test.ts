/**
 * Cross-path de-duplication test.
 *
 * Verifies that when a spec event would fire from BOTH the watcher-driven
 * path (handleMapContextEvent) AND an explicit broadcaster (as a stand-in
 * for REST/MAP handler), the dedup cache causes exactly one broadcast.
 *
 * The explicit broadcaster here calls the cache directly then would
 * broadcast — we only check the cache verdict. The real REST + MAP
 * handlers are wired to the same cache in `specs.ts` and
 * `spec-handler.ts`; their individual broadcast behavior is covered in
 * their own test suites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const broadcastToChannel = vi.fn();
const getDefaultTaskGraph = vi.fn();

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...args),
}));

vi.mock('../../map/connection-registry.js', () => ({
  getDefaultTaskGraph: (...args: unknown[]) => getDefaultTaskGraph(...args),
}));

import { handleMapContextEvent } from '../../coordination/listener.js';
import {
  shouldBroadcastSpecEvent,
  _resetSpecBroadcastDedup,
} from '../../map/spec-broadcast-dedup.js';

beforeEach(() => {
  broadcastToChannel.mockReset();
  getDefaultTaskGraph.mockReset();
  getDefaultTaskGraph.mockReturnValue({ resource_id: 'res_abc' });
  _resetSpecBroadcastDedup();
});

describe('cross-path spec broadcast dedup', () => {
  it('suppresses the watcher broadcast when an explicit broadcaster already fired', () => {
    // Stand-in for the REST handler path: mark the key as broadcast.
    const first = shouldBroadcastSpecEvent('spec.created', 'res_abc', 'spec_1');
    expect(first).toBe(true);

    // Now the watcher-driven path fires for the same spec (via the
    // daemon shared between the hub and a co-located sidecar).
    handleMapContextEvent(
      {
        type: 'context.created',
        context: {
          id: 'spec_1',
          title: 'Auth',
          metadata: { kind: 'spec' },
        },
      },
      'swarm_src',
      'agent_1',
    );

    // The watcher path should be suppressed — no broadcast goes out.
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('lets the watcher broadcast through when no explicit broadcaster fired', () => {
    // No upstream broadcast — this is the remote-swarm case.
    handleMapContextEvent(
      {
        type: 'context.created',
        context: {
          id: 'spec_1',
          title: 'Auth',
          metadata: { kind: 'spec' },
        },
      },
      'swarm_src',
      'agent_1',
    );

    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).toHaveBeenCalledWith('map:tasks', expect.objectContaining({
      type: 'spec.created',
    }));
  });

  it('suppresses a watcher rebroadcast of the same spec.created', () => {
    // Simulate the watcher firing twice in quick succession (chokidar
    // can deliver duplicate change events when graph.jsonl is written
    // twice in the debounce window).
    handleMapContextEvent(
      {
        type: 'context.created',
        context: { id: 'spec_dup', title: 'A', metadata: { kind: 'spec' } },
      },
      'swarm_src',
      'agent_1',
    );
    handleMapContextEvent(
      {
        type: 'context.created',
        context: { id: 'spec_dup', title: 'A', metadata: { kind: 'spec' } },
      },
      'swarm_src',
      'agent_1',
    );

    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
  });

  it('spec.updated does not suppress a prior spec.created on the same spec', () => {
    // Explicit broadcaster fires spec.created — cache records it.
    expect(shouldBroadcastSpecEvent('spec.created', 'res_abc', 'spec_x')).toBe(true);

    // Watcher-driven spec.updated (e.g. from a later archive flip) should
    // NOT be suppressed by the earlier spec.created entry.
    handleMapContextEvent(
      {
        type: 'context.updated',
        context: {
          id: 'spec_x',
          title: 'Renamed',
          archived: true,
          metadata: { kind: 'spec' },
        },
      },
      'swarm_src',
      'agent_1',
    );

    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).toHaveBeenCalledWith('map:tasks', expect.objectContaining({
      type: 'spec.updated',
    }));
  });
});
