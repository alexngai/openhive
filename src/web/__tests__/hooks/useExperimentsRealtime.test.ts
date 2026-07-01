// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

// ── Capture useWSEvent callbacks by event type (mirrors
//    useRealtimeInvalidation.test.ts) ──

const mockUseSubscribe = vi.fn();
const eventHandlers = new Map<string, (...args: unknown[]) => void>();

const mockUseWSEvent = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
  eventHandlers.set(event, handler);
});

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: (...args: unknown[]) => mockUseSubscribe(...args),
  useWSEvent: (...args: unknown[]) => mockUseWSEvent(...args),
}));

import { useExperimentsRealtime } from '../../hooks/useExperimentsRealtime';

let queryClient: QueryClient;

function createWrapper() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// WS messages arrive as { type, channel?, data }; the lifecycle payload is on
// `.data`. The handler tolerates both, so test with the realistic envelope.
function envelope(data: Record<string, unknown>) {
  return { type: 'experiment.x', data };
}

describe('useExperimentsRealtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
  });

  it('subscribes to map:experiments only when no id is given', () => {
    renderHook(() => useExperimentsRealtime(), { wrapper: createWrapper() });
    expect(mockUseSubscribe).toHaveBeenCalledWith(['map:experiments']);
  });

  it('subscribes to both fleet + per-experiment channels when an id is given', () => {
    renderHook(() => useExperimentsRealtime('exp_123'), { wrapper: createWrapper() });
    expect(mockUseSubscribe).toHaveBeenCalledWith(['map:experiments', 'experiment:exp_123']);
  });

  it('registers handlers for all experiment lifecycle event types', () => {
    renderHook(() => useExperimentsRealtime('exp_123'), { wrapper: createWrapper() });
    const registered = mockUseWSEvent.mock.calls.map((c) => c[0]);
    expect(registered).toContain('experiment.updated');
    expect(registered).toContain('experiment.run_started');
    expect(registered).toContain('experiment.run_updated');
    expect(registered).toContain('experiment.run_finished');
    expect(registered).toContain('experiment.candidate');
  });

  it('experiment.updated invalidates list + detail', () => {
    renderHook(() => useExperimentsRealtime('exp_123'), { wrapper: createWrapper() });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    eventHandlers.get('experiment.updated')!(envelope({ experiment_id: 'exp_123' }));

    expect(spy).toHaveBeenCalledWith({ queryKey: ['experiments'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['experiment', 'exp_123'] });
  });

  it('experiment.run_updated invalidates list + detail + runs + this run', () => {
    renderHook(() => useExperimentsRealtime('exp_123'), { wrapper: createWrapper() });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    eventHandlers.get('experiment.run_updated')!(
      envelope({ experiment_id: 'exp_123', run_id: 'exrun_9' }),
    );

    expect(spy).toHaveBeenCalledWith({ queryKey: ['experiments'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['experiment', 'exp_123'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['experiment-runs', 'exp_123'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['experiment-run', 'exp_123', 'exrun_9'] });
  });

  it('experiment.run_finished also invalidates candidates + the run event tail', () => {
    renderHook(() => useExperimentsRealtime('exp_123'), { wrapper: createWrapper() });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    eventHandlers.get('experiment.run_finished')!(
      envelope({ experiment_id: 'exp_123', run_id: 'exrun_9' }),
    );

    expect(spy).toHaveBeenCalledWith({ queryKey: ['experiment-candidates', 'exp_123'] });
    expect(spy).toHaveBeenCalledWith({
      queryKey: ['experiment-run-events', 'exp_123', 'exrun_9'],
    });
  });

  it('experiment.candidate invalidates detail + candidates + the run event tail (not the list)', () => {
    renderHook(() => useExperimentsRealtime('exp_123'), { wrapper: createWrapper() });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    eventHandlers.get('experiment.candidate')!(
      envelope({ experiment_id: 'exp_123', run_id: 'exrun_9' }),
    );

    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['experiment', 'exp_123']);
    expect(keys).toContainEqual(['experiment-candidates', 'exp_123']);
    expect(keys).toContainEqual(['experiment-run-events', 'exp_123', 'exrun_9']);
    // candidate churn shouldn't refetch the whole fleet list
    expect(keys).not.toContainEqual(['experiments']);
  });

  it('falls back to the hook id when the event omits experiment_id', () => {
    renderHook(() => useExperimentsRealtime('exp_fallback'), { wrapper: createWrapper() });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    eventHandlers.get('experiment.updated')!(envelope({}));

    expect(spy).toHaveBeenCalledWith({ queryKey: ['experiment', 'exp_fallback'] });
  });
});
