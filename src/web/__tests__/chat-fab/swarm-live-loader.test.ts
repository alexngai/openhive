/**
 * Swarm context-type live loader — reads the React Query cache under
 * `['map-swarm', id]` and falls back to fetchQuery.
 */

import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import '../../components/chat-fab/context-types';
import { getContextType } from '../../components/chat-fab/context-registry';
import type { SwarmData } from '../../components/chat-fab/context-types/swarm';

function freshQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const snapshot: SwarmData = {
  id: 'swarm-1',
  name: 'stale-name',
  status: 'online',
};

describe('swarm context-type live loader', () => {
  it('reads the cache under [map-swarm, id]', async () => {
    const spec = getContextType('swarm')!;
    expect(spec.live).toBeDefined();

    const qc = freshQc();
    qc.setQueryData(['map-swarm', 'swarm-1'], {
      id: 'swarm-1',
      name: 'fresh-name',
      status: 'unreachable',
      agent_count: 7,
      last_seen_at: '2026-04-22T12:00:00Z',
      registered_agents: [{ id: 'a' }, { id: 'b' }],
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as SwarmData | null;

    expect(result).not.toBeNull();
    expect(result?.name).toBe('fresh-name');
    expect(result?.status).toBe('unreachable');
    expect(result?.agent_count).toBe(7);
    expect(result?.registered_agent_count).toBe(2);
  });

  it('falls back to fetchQuery({signal}) on cache miss', async () => {
    const spec = getContextType('swarm')!;
    const qc = freshQc();
    const fetchSpy = vi.spyOn(qc, 'fetchQuery').mockResolvedValueOnce({
      id: 'swarm-1',
      name: 'fetched',
      status: 'online',
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as SwarmData | null;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArg = fetchSpy.mock.calls[0]![0]!;
    expect(callArg.queryKey).toEqual(['map-swarm', 'swarm-1']);
    expect(callArg.signal).toBe(controller.signal);
    expect(result?.name).toBe('fetched');
  });

  it('returns null when the cached swarm lacks an id (tombstone)', async () => {
    const spec = getContextType('swarm')!;
    const qc = freshQc();
    qc.setQueryData(['map-swarm', 'swarm-1'], {});

    const controller = new AbortController();
    const result = await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    });

    expect(result).toBeNull();
  });
});
