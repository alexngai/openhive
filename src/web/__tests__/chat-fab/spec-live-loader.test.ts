/**
 * Spec context-type live loader — confirms it reads the shared React
 * Query cache (`['spec', resource_id, id]`) and falls back to
 * `fetchQuery({signal})` on cache miss.
 */

import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import '../../components/chat-fab/context-types';
import { getContextType } from '../../components/chat-fab/context-registry';
import type { SpecData } from '../../components/chat-fab/context-types/spec';

function freshQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const snapshot: SpecData = {
  id: 'spec-1',
  resource_id: 'res-xyz',
  title: 'Original',
  content: 'original body',
};

describe('spec context-type live loader', () => {
  it('reads the React Query cache when cached under [spec, resource_id, id]', async () => {
    const spec = getContextType('spec')!;
    expect(spec.live).toBeDefined();

    const qc = freshQc();
    // Seed the cache with a "fresh" SpecDetailResponse-shaped record.
    qc.setQueryData(['spec', 'res-xyz', 'spec-1'], {
      spec: {
        id: 'spec-1',
        resource_id: 'res-xyz',
        title: 'Updated',
        content: 'updated body',
      },
    });

    const controller = new AbortController();
    const result = await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    });

    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    const asSpec = result as SpecData;
    expect(asSpec.title).toBe('Updated');
    expect(asSpec.content).toBe('updated body');
  });

  it('falls back to fetchQuery({signal}) on cache miss', async () => {
    const spec = getContextType('spec')!;
    const qc = freshQc();

    const fetchSpy = vi
      .spyOn(qc, 'fetchQuery')
      .mockResolvedValueOnce({
        spec: {
          id: 'spec-1',
          resource_id: 'res-xyz',
          title: 'Fetched',
          content: 'fetched body',
        },
      });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as SpecData | null;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArg = fetchSpy.mock.calls[0]![0]!;
    expect(callArg.queryKey).toEqual(['spec', 'res-xyz', 'spec-1']);
    // §3.1.5: signal is threaded through to fetchQuery.
    expect(callArg.signal).toBe(controller.signal);

    expect(result?.title).toBe('Fetched');
    expect(result?.content).toBe('fetched body');
  });

  it('returns null when fetchQuery resolves to an empty shape', async () => {
    const spec = getContextType('spec')!;
    const qc = freshQc();

    // Cached record missing the nested `spec` field — simulates a
    // tombstone after deletion.
    qc.setQueryData(['spec', 'res-xyz', 'spec-1'], {});

    const controller = new AbortController();
    const result = await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    });

    // Null → signals the chip is stale to the wrapper.
    expect(result).toBeNull();
  });
});
