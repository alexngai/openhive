/**
 * Stream context-type live loader — reads the React Query cache under
 * `['cascade-stream-detail', id]` and falls back to fetchQuery with the
 * same key and the caller-supplied AbortSignal.
 */

import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import '../../components/chat-fab/context-types';
import { getContextType } from '../../components/chat-fab/context-registry';
import type { StreamData } from '../../components/chat-fab/context-types/stream';

function freshQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const snapshot: StreamData = {
  id: 'stream-row-1',
  stream_id: 'stream-abc',
  source_swarm_id: 'swarm-1',
  name: 'feature/old',
  status: 'active',
};

describe('stream context-type live loader', () => {
  it('reads the cache under [cascade-stream-detail, id]', async () => {
    const spec = getContextType('stream')!;
    expect(spec.live).toBeDefined();

    const qc = freshQc();
    qc.setQueryData(['cascade-stream-detail', 'stream-row-1'], {
      data: {
        id: 'stream-row-1',
        stream_id: 'stream-abc',
        source_swarm_id: 'swarm-1',
        name: 'feature/updated',
        status: 'merged',
      },
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as StreamData | null;

    expect(result).not.toBeNull();
    expect(result?.name).toBe('feature/updated');
    expect(result?.status).toBe('merged');
  });

  it('falls back to fetchQuery({signal}) on cache miss', async () => {
    const spec = getContextType('stream')!;
    const qc = freshQc();

    const fetchSpy = vi.spyOn(qc, 'fetchQuery').mockResolvedValueOnce({
      data: {
        id: 'stream-row-1',
        stream_id: 'stream-abc',
        source_swarm_id: 'swarm-1',
        name: 'feature/fetched',
        status: 'active',
      },
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as StreamData | null;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArg = fetchSpy.mock.calls[0]![0]!;
    expect(callArg.queryKey).toEqual(['cascade-stream-detail', 'stream-row-1']);
    expect(callArg.signal).toBe(controller.signal);

    expect(result?.name).toBe('feature/fetched');
  });

  it('returns null when cached record lacks data.id (tombstone)', async () => {
    const spec = getContextType('stream')!;
    const qc = freshQc();
    qc.setQueryData(['cascade-stream-detail', 'stream-row-1'], {});

    const controller = new AbortController();
    const result = await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    });

    expect(result).toBeNull();
  });
});
