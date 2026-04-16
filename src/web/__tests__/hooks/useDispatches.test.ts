// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  useCancelDispatch,
  useDispatch,
  useDispatches,
  useCreateDispatch,
  useDispatchPolicy,
  useUpdateDispatchPolicy,
} from '../../hooks/useDispatches';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('../../lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: vi.fn(),
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

describe('Dispatch hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useDispatches', () => {
    it('fetches with default limit/offset', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0, limit: 50, offset: 0 });
      const { Wrapper } = createWrapper();
      const { result } = renderHook(() => useDispatches(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const url = mockGet.mock.calls[0]?.[0] as string;
      expect(url).toContain('/dispatches?');
      expect(url).toContain('limit=50');
      expect(url).toContain('offset=0');
    });

    it('serializes status array as comma-separated', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0, limit: 50, offset: 0 });
      const { Wrapper } = createWrapper();
      const { result } = renderHook(
        () => useDispatches({ status: ['queued', 'running'] }),
        { wrapper: Wrapper },
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const url = mockGet.mock.calls[0]?.[0] as string;
      expect(url).toContain('status=queued%2Crunning');
    });

    it('passes spec_resource_id, spec_id, target_swarm_id, initiator_id', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0, limit: 50, offset: 0 });
      const { Wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useDispatches({
            spec_resource_id: 'res_a',
            spec_id: 's-1',
            target_swarm_id: 'swarm_x',
            initiator_id: 'agent_u',
            initiator_type: 'user',
          }),
        { wrapper: Wrapper },
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const url = mockGet.mock.calls[0]?.[0] as string;
      expect(url).toContain('spec_resource_id=res_a');
      expect(url).toContain('spec_id=s-1');
      expect(url).toContain('target_swarm_id=swarm_x');
      expect(url).toContain('initiator_id=agent_u');
      expect(url).toContain('initiator_type=user');
    });
  });

  describe('useDispatch', () => {
    it('does not fire when id is missing', async () => {
      const { Wrapper } = createWrapper();
      const { result } = renderHook(() => useDispatch(undefined), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('fetches single dispatch by id', async () => {
      mockGet.mockResolvedValue({ dispatch: { id: 'disp_1' } });
      const { Wrapper } = createWrapper();
      const { result } = renderHook(() => useDispatch('disp_1'), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/dispatches/disp_1');
    });
  });

  describe('useCreateDispatch', () => {
    it('POSTs to /specs/:rid/:sid/dispatch and invalidates the dispatches list', async () => {
      mockPost.mockResolvedValue({
        dispatches: [
          { id: 'disp_1', status: 'queued', target_swarm_id: 'sw_a', seed_prompt: '...', target_swarm_name: 'Alpha' },
        ],
      });
      const { Wrapper, qc } = createWrapper();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      const { result } = renderHook(() => useCreateDispatch(), { wrapper: Wrapper });
      await act(async () => {
        await result.current.mutateAsync({
          resource_id: 'res_a',
          spec_id: 's-1',
          target_swarms: ['sw_a'],
          prompt: 'go for it',
        });
      });

      expect(mockPost).toHaveBeenCalledWith('/specs/res_a/s-1/dispatch', {
        target_swarms: ['sw_a'],
        prompt: 'go for it',
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dispatches'] });
    });

    it('omits prompt when not provided', async () => {
      mockPost.mockResolvedValue({ dispatches: [] });
      const { Wrapper } = createWrapper();
      const { result } = renderHook(() => useCreateDispatch(), { wrapper: Wrapper });
      await act(async () => {
        await result.current.mutateAsync({
          resource_id: 'res_a',
          spec_id: 's-1',
          target_swarms: ['sw_a'],
        });
      });
      expect(mockPost).toHaveBeenCalledWith('/specs/res_a/s-1/dispatch', {
        target_swarms: ['sw_a'],
        prompt: undefined,
      });
    });
  });

  describe('useCancelDispatch', () => {
    it('POSTs to /dispatches/:id/cancel and invalidates list + detail caches', async () => {
      mockPost.mockResolvedValue({ dispatch: { id: 'disp_x', status: 'cancelled' } });
      const { Wrapper, qc } = createWrapper();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      const { result } = renderHook(() => useCancelDispatch(), { wrapper: Wrapper });
      await act(async () => {
        await result.current.mutateAsync('disp_x');
      });

      expect(mockPost).toHaveBeenCalledWith('/dispatches/disp_x/cancel', undefined);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dispatches'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dispatch', 'disp_x'] });
    });
  });

  describe('useDispatchPolicy', () => {
    it('GETs /admin/dispatch-policy', async () => {
      mockGet.mockResolvedValue({ autonomous_dispatch_paused: false });
      const { Wrapper } = createWrapper();
      const { result } = renderHook(() => useDispatchPolicy(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/admin/dispatch-policy');
    });
  });

  describe('useUpdateDispatchPolicy', () => {
    it('POSTs the new paused state and invalidates the policy query', async () => {
      mockPost.mockResolvedValue({ autonomous_dispatch_paused: true });
      const { Wrapper, qc } = createWrapper();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      const { result } = renderHook(() => useUpdateDispatchPolicy(), { wrapper: Wrapper });
      await act(async () => {
        await result.current.mutateAsync(true);
      });

      expect(mockPost).toHaveBeenCalledWith('/admin/dispatch-policy', { paused: true });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dispatch-policy'] });
    });
  });
});
