/**
 * Session context-type live loader — reads the React Query cache under
 * `['resource', id]` and projects the session resource + metadata.
 */

import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import '../../components/chat-fab/context-types';
import { getContextType } from '../../components/chat-fab/context-registry';
import type { SessionData } from '../../components/chat-fab/context-types/session';

function freshQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const snapshot: SessionData = {
  id: 'session-1',
  name: 'stale',
  swarm_id: 'swarm-1',
};

describe('session context-type live loader', () => {
  it('reads the cache under [resource, id] and projects metadata', async () => {
    const spec = getContextType('session')!;
    const qc = freshQc();
    qc.setQueryData(['resource', 'session-1'], {
      id: 'session-1',
      name: 'openhive@main · refresh',
      owner_agent_id: 'user-1',
      metadata: {
        project: 'openhive',
        branch: 'main',
        state: 'active',
        checkpoint_count: 9,
        first_prompt: 'fresh prompt',
        source_swarm_id: 'swarm-1',
      },
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as SessionData | null;

    expect(result).not.toBeNull();
    expect(result?.name).toBe('openhive@main · refresh');
    expect(result?.project).toBe('openhive');
    expect(result?.branch).toBe('main');
    expect(result?.state).toBe('active');
    expect(result?.checkpoint_count).toBe(9);
    expect(result?.first_prompt).toBe('fresh prompt');
    expect(result?.owner_agent_id).toBe('user-1');
  });

  it('falls back to fetchQuery({signal}) on cache miss', async () => {
    const spec = getContextType('session')!;
    const qc = freshQc();
    const fetchSpy = vi.spyOn(qc, 'fetchQuery').mockResolvedValueOnce({
      id: 'session-1',
      name: 'fetched session',
      metadata: { project: 'svc', branch: 'dev' },
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as SessionData | null;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArg = fetchSpy.mock.calls[0]![0]!;
    expect(callArg.queryKey).toEqual(['resource', 'session-1']);
    expect(callArg.signal).toBe(controller.signal);
    expect(result?.name).toBe('fetched session');
    expect(result?.project).toBe('svc');
  });

  it('returns null when the cached resource lacks an id (tombstone)', async () => {
    const spec = getContextType('session')!;
    const qc = freshQc();
    qc.setQueryData(['resource', 'session-1'], {});

    const controller = new AbortController();
    const result = await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    });

    expect(result).toBeNull();
  });
});
