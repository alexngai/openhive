// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

const mockUseSubscribe = vi.fn();
const eventHandlers = new Map<string, (...args: unknown[]) => void>();

const mockUseWSEvent = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
  eventHandlers.set(event, handler);
});

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: (...args: unknown[]) => mockUseSubscribe(...args),
  useWSEvent: (...args: unknown[]) => mockUseWSEvent(...args),
}));

import { useCancelAckWarnings, useDispatchRealtime, useMaterializationWarnings } from '../../hooks/useDispatchRealtime';

let queryClient: QueryClient;

function createWrapper() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function envelope(data: Record<string, unknown>) {
  return { type: 'dispatch.x', data };
}

describe('useDispatchRealtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
  });

  it('subscribes to the dispatches channel', () => {
    renderHook(() => useDispatchRealtime(), { wrapper: createWrapper() });

    expect(mockUseSubscribe).toHaveBeenCalledWith(['map:dispatches']);
  });

  it('invalidates a dispatch detail query from a websocket envelope', () => {
    renderHook(() => useDispatchRealtime(), { wrapper: createWrapper() });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    eventHandlers.get('dispatch.status_changed')!(envelope({ dispatch_id: 'disp_1' }));

    expect(spy).toHaveBeenCalledWith({ queryKey: ['dispatches'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['dispatch', 'disp_1'] });
  });

  it('tracks cancel-not-acked warnings from a websocket envelope', () => {
    const { result } = renderHook(() => useCancelAckWarnings('disp_1'), {
      wrapper: createWrapper(),
    });

    act(() => {
      eventHandlers.get('dispatch.cancel_not_acked')!(envelope({ dispatch_id: 'disp_1' }));
    });

    expect(result.current.warned).toBe(true);
  });

  it('tracks materialization errors from a websocket envelope', () => {
    const { result } = renderHook(() => useMaterializationWarnings('disp_1'), {
      wrapper: createWrapper(),
    });

    act(() => {
      eventHandlers.get('dispatch.materialization_failed')!(
        envelope({ dispatch_id: 'disp_1', error: 'loadout missing' }),
      );
    });

    expect(result.current.error).toBe('loadout missing');
  });
});
