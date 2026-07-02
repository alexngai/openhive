// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
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

import { useSchedulesRealtime } from '../../hooks/useSchedulesRealtime';

let queryClient: QueryClient;

function createWrapper() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function envelope(data: Record<string, unknown>) {
  return { type: 'schedule.x', data };
}

describe('useSchedulesRealtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
  });

  it('subscribes to the schedules channel', () => {
    renderHook(() => useSchedulesRealtime(), { wrapper: createWrapper() });

    expect(mockUseSubscribe).toHaveBeenCalledWith(['map:schedules']);
  });

  it('invalidates a schedule detail query from a websocket envelope', () => {
    renderHook(() => useSchedulesRealtime(), { wrapper: createWrapper() });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    eventHandlers.get('schedule.updated')!(envelope({ schedule_id: 'sch_1' }));

    expect(spy).toHaveBeenCalledWith({ queryKey: ['schedules'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['schedule', 'sch_1'] });
  });

  it('schedule.fired invalidates schedule detail and dispatch lists', () => {
    renderHook(() => useSchedulesRealtime(), { wrapper: createWrapper() });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    eventHandlers.get('schedule.fired')!(envelope({ schedule_id: 'sch_1' }));

    expect(spy).toHaveBeenCalledWith({ queryKey: ['schedules'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['schedule', 'sch_1'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['dispatches'] });
  });
});
