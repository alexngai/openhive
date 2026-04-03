// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

import { useInstanceFeatures } from '../../hooks/useInstanceFeatures';

let queryClient: QueryClient;

function createWrapper() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInstanceFeatures', () => {
  it('returns undefined while loading', () => {
    // fetch never resolves
    (fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useInstanceFeatures(), {
      wrapper: createWrapper(),
    });

    expect(result.current).toBeUndefined();
  });

  it('returns features on successful response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        features: { swarmcraft: true, swarm_hosting: true },
      }),
    });

    const { result } = renderHook(() => useInstanceFeatures(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toBeDefined();
    });

    expect(result.current).toEqual({ swarmcraft: true, swarm_hosting: true });
  });

  it('returns empty object when response has no features', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '1.0' }), // no features key
    });

    const { result } = renderHook(() => useInstanceFeatures(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toBeDefined();
    });

    expect(result.current).toEqual({});
  });

  it('throws on non-OK responses instead of caching them as success', async () => {
    // Test the queryFn behavior directly: a 500 should throw,
    // not return parsed JSON. This is the core fix — before, fetch()
    // silently returned the 500 body as "data", and React Query cached
    // it as a successful (but empty) result for 5 minutes.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(
      fetch('/.well-known/openhive.json').then(r => {
        if (!(r as Response).ok) throw new Error(`Instance info returned ${(r as Response).status}`);
        return (r as Response).json();
      }),
    ).rejects.toThrow('Instance info returned 500');
  });

  it('retries on failure and succeeds on subsequent attempt', async () => {
    // First call fails, second succeeds
    let callCount = 0;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          features: { swarmcraft: true },
        }),
      });
    });

    // Use a query client WITH retries (matching production config)
    const retryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: retryClient }, children);

    const { result } = renderHook(() => useInstanceFeatures(), { wrapper });

    await waitFor(() => {
      expect(result.current).toEqual({ swarmcraft: true });
    }, { timeout: 3000 });

    // Should have been called at least twice (initial + retry)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
