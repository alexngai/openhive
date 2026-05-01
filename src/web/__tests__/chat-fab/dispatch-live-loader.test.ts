/**
 * Dispatch context-type live loader — confirms it reads the shared React
 * Query cache (`['dispatch', id]`) and falls back to fetchQuery on miss.
 */

import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import '../../components/chat-fab/context-types';
import { getContextType } from '../../components/chat-fab/context-registry';
import type { DispatchData } from '../../components/chat-fab/context-types/dispatch';

function freshQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const snapshot: DispatchData = {
  id: 'd-abc123',
  spec_id: 'spec-xyz',
  target_swarm_id: 'swarm-1',
  status: 'queued',
};

describe('dispatch context-type live loader', () => {
  it('reads the React Query cache when cached under [dispatch, id]', async () => {
    const spec = getContextType('dispatch')!;
    expect(spec.live).toBeDefined();

    const qc = freshQc();
    qc.setQueryData(['dispatch', 'd-abc123'], {
      dispatch: {
        id: 'd-abc123',
        spec_id: 'spec-xyz',
        target_swarm_id: 'swarm-1',
        status: 'running',
        attempts_history: [
          { attempt: 1, status: 'running' as const },
        ],
      },
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as DispatchData | null;

    expect(result?.status).toBe('running');
    expect(result?.latest_attempt).toEqual({
      attempt: 1,
      status: 'running',
      started_at: undefined,
      error: undefined,
    });
  });

  it('falls back to fetchQuery({signal}) on cache miss', async () => {
    const spec = getContextType('dispatch')!;
    const qc = freshQc();

    const fetchSpy = vi.spyOn(qc, 'fetchQuery').mockResolvedValueOnce({
      dispatch: {
        id: 'd-abc123',
        spec_id: 'spec-xyz',
        target_swarm_id: 'swarm-1',
        status: 'complete',
      },
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as DispatchData | null;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArg = fetchSpy.mock.calls[0]![0]!;
    expect(callArg.queryKey).toEqual(['dispatch', 'd-abc123']);
    expect(callArg.signal).toBe(controller.signal);

    expect(result?.status).toBe('complete');
  });

  it('returns null when fetched shape lacks a dispatch.id', async () => {
    const spec = getContextType('dispatch')!;
    const qc = freshQc();

    qc.setQueryData(['dispatch', 'd-abc123'], { dispatch: {} });

    const controller = new AbortController();
    const result = await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    });

    expect(result).toBeNull();
  });
});
