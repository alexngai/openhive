// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  useSpecs,
  useSpec,
  useCreateSpec,
  useUpdateSpec,
} from '../../hooks/useSpecs';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();

vi.mock('../../lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return { Wrapper, qc };
}

describe('Spec API hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useSpecs', () => {
    it('fetches specs with default params', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0, limit: 50, offset: 0 });
      const { Wrapper } = createWrapper();

      const { result } = renderHook(() => useSpecs(), { wrapper: Wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/specs?limit=50&offset=0');
    });

    it('passes include_archived flag', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0, limit: 50, offset: 0 });
      const { Wrapper } = createWrapper();

      const { result } = renderHook(
        () => useSpecs({ includeArchived: true }),
        { wrapper: Wrapper },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(
        expect.stringContaining('include_archived=true'),
      );
    });

    it('passes resource_id filter', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0, limit: 50, offset: 0 });
      const { Wrapper } = createWrapper();

      const { result } = renderHook(
        () => useSpecs({ resourceId: 'res_abc' }),
        { wrapper: Wrapper },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(
        expect.stringContaining('resource_id=res_abc'),
      );
    });
  });

  describe('useSpec', () => {
    it('fetches a single spec when both ids provided', async () => {
      mockGet.mockResolvedValue({ spec: { id: 's-x' }, raw: {}, linked: {}, edges: [] });
      const { Wrapper } = createWrapper();

      const { result } = renderHook(() => useSpec('res_a', 's-x'), { wrapper: Wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/specs/res_a/s-x');
    });

    it('does not fire query when ids missing', async () => {
      const { Wrapper } = createWrapper();

      const { result } = renderHook(() => useSpec(undefined, undefined), { wrapper: Wrapper });

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('useCreateSpec', () => {
    it('POSTs and invalidates the specs list', async () => {
      const created = { spec: { id: 's-new', title: 'fresh' } };
      mockPost.mockResolvedValue(created);
      const { Wrapper, qc } = createWrapper();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      const { result } = renderHook(() => useCreateSpec(), { wrapper: Wrapper });

      await act(async () => {
        await result.current.mutateAsync({
          resource_id: 'res_a',
          title: 'fresh',
          content: 'body',
        });
      });

      expect(mockPost).toHaveBeenCalledWith('/specs', {
        resource_id: 'res_a',
        title: 'fresh',
        content: 'body',
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['specs'] });
    });
  });

  describe('useUpdateSpec', () => {
    it('PATCHes and invalidates both list and detail', async () => {
      mockPatch.mockResolvedValue({ spec: { id: 's-x', title: 'updated' } });
      const { Wrapper, qc } = createWrapper();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      const { result } = renderHook(() => useUpdateSpec('res_a', 's-x'), { wrapper: Wrapper });

      await act(async () => {
        await result.current.mutateAsync({ title: 'updated' });
      });

      expect(mockPatch).toHaveBeenCalledWith('/specs/res_a/s-x', { title: 'updated' });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['spec', 'res_a', 's-x'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['specs'] });
    });

    it('forwards archived: true', async () => {
      mockPatch.mockResolvedValue({ spec: { id: 's-x', archived: true } });
      const { Wrapper } = createWrapper();

      const { result } = renderHook(() => useUpdateSpec('res_a', 's-x'), { wrapper: Wrapper });

      await act(async () => {
        await result.current.mutateAsync({ archived: true });
      });

      expect(mockPatch).toHaveBeenCalledWith('/specs/res_a/s-x', { archived: true });
    });
  });
});
