/**
 * Task (singular) context-type live loader — reads the shared opentasks
 * graph cache and projects the target node + its block edges.
 */

import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import '../../components/chat-fab/context-types';
import { getContextType } from '../../components/chat-fab/context-registry';
import type { TaskData } from '../../components/chat-fab/context-types/task';

function freshQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const snapshot: TaskData = {
  id: 't-node-9',
  resource_id: 'res-tasks',
  title: 'Original title',
};

describe('task context-type live loader', () => {
  it('projects the target node from [opentasks-graph, resourceId]', async () => {
    const spec = getContextType('task')!;
    const qc = freshQc();
    qc.setQueryData(['opentasks-graph', 'res-tasks'], {
      nodes: [
        { id: 't-node-1', title: 'A', status: 'done' },
        { id: 't-node-9', title: 'Fresh title', status: 'in_progress', assignee: 'agent-42' },
      ],
      edges: [
        { type: 'blocks', source: 't-node-1', target: 't-node-9' },
        { type: 'blocks', source: 't-node-9', target: 't-node-12' },
      ],
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as TaskData | null;

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Fresh title');
    expect(result?.assignee).toBe('agent-42');
    expect(result?.blocked_by).toEqual(['t-node-1']);
    expect(result?.blocks).toEqual(['t-node-12']);
  });

  it('falls back to fetchQuery({signal}) on cache miss', async () => {
    const spec = getContextType('task')!;
    const qc = freshQc();
    const fetchSpy = vi.spyOn(qc, 'fetchQuery').mockResolvedValueOnce({
      nodes: [{ id: 't-node-9', title: 'Fetched', status: 'open' }],
      edges: [],
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as TaskData | null;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArg = fetchSpy.mock.calls[0]![0]!;
    expect(callArg.queryKey).toEqual(['opentasks-graph', 'res-tasks']);
    expect(callArg.signal).toBe(controller.signal);
    expect(result?.title).toBe('Fetched');
  });

  it('returns null when the node is missing from the graph (tombstone)', async () => {
    const spec = getContextType('task')!;
    const qc = freshQc();
    qc.setQueryData(['opentasks-graph', 'res-tasks'], {
      nodes: [{ id: 'other-node', title: 'Other' }],
      edges: [],
    });

    const controller = new AbortController();
    const result = await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    });

    expect(result).toBeNull();
  });
});
