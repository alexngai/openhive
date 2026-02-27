// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  usePostRules, useCreatePostRule, useUpdatePostRule, useDeletePostRule,
  useEventSubscriptions, useCreateSubscription, useUpdateSubscription, useDeleteSubscription,
  useDeliveryLog,
} from '../../hooks/useApi';

// ── Mock API client ──

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();

vi.mock('../../lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    put: (...args: unknown[]) => mockPut(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

// ── Helpers ──

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// ── Tests ──

describe('Event API Hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Post Rules ──

  describe('usePostRules', () => {
    it('fetches all post rules', async () => {
      const rules = [{ id: 'r1', source: 'github' }];
      mockGet.mockResolvedValue({ data: rules });

      const { result } = renderHook(() => usePostRules(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/events/post-rules');
      expect(result.current.data).toEqual(rules);
    });

    it('fetches post rules filtered by hive', async () => {
      mockGet.mockResolvedValue({ data: [] });

      const { result } = renderHook(() => usePostRules('hive_1'), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/events/post-rules?hive_id=hive_1');
    });
  });

  describe('useCreatePostRule', () => {
    it('posts to create a rule', async () => {
      const newRule = { id: 'r_new', source: 'github' };
      mockPost.mockResolvedValue(newRule);

      const { result } = renderHook(() => useCreatePostRule(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.mutateAsync({
          hive_id: 'hive_1',
          source: 'github',
          event_types: ['push'],
        });
      });

      expect(mockPost).toHaveBeenCalledWith('/events/post-rules', {
        hive_id: 'hive_1',
        source: 'github',
        event_types: ['push'],
      });
    });
  });

  describe('useUpdatePostRule', () => {
    it('puts to update a rule', async () => {
      mockPut.mockResolvedValue({});

      const { result } = renderHook(() => useUpdatePostRule(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.mutateAsync({
          id: 'r_1',
          source: 'slack',
          priority: 200,
        });
      });

      expect(mockPut).toHaveBeenCalledWith('/events/post-rules/r_1', {
        source: 'slack',
        priority: 200,
      });
    });
  });

  describe('useDeletePostRule', () => {
    it('deletes a rule by id', async () => {
      mockDelete.mockResolvedValue({});

      const { result } = renderHook(() => useDeletePostRule(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.mutateAsync('r_1');
      });

      expect(mockDelete).toHaveBeenCalledWith('/events/post-rules/r_1');
    });
  });

  // ── Event Subscriptions ──

  describe('useEventSubscriptions', () => {
    it('fetches all subscriptions', async () => {
      const subs = [{ id: 's1', source: 'github' }];
      mockGet.mockResolvedValue({ data: subs });

      const { result } = renderHook(() => useEventSubscriptions(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/events/subscriptions');
      expect(result.current.data).toEqual(subs);
    });

    it('filters by hive_id', async () => {
      mockGet.mockResolvedValue({ data: [] });

      const { result } = renderHook(
        () => useEventSubscriptions({ hive_id: 'hive_1' }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/events/subscriptions?hive_id=hive_1');
    });

    it('filters by swarm_id', async () => {
      mockGet.mockResolvedValue({ data: [] });

      const { result } = renderHook(
        () => useEventSubscriptions({ swarm_id: 'swarm_1' }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/events/subscriptions?swarm_id=swarm_1');
    });

    it('filters by both hive_id and swarm_id', async () => {
      mockGet.mockResolvedValue({ data: [] });

      const { result } = renderHook(
        () => useEventSubscriptions({ hive_id: 'hive_1', swarm_id: 'swarm_1' }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/events/subscriptions?hive_id=hive_1&swarm_id=swarm_1');
    });
  });

  describe('useCreateSubscription', () => {
    it('creates a hive-level subscription', async () => {
      mockPost.mockResolvedValue({});

      const { result } = renderHook(() => useCreateSubscription(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.mutateAsync({
          hive_id: 'hive_1',
          source: 'github',
          event_types: ['push'],
        });
      });

      expect(mockPost).toHaveBeenCalledWith('/events/subscriptions', {
        hive_id: 'hive_1',
        source: 'github',
        event_types: ['push'],
      });
    });

    it('creates a swarm-specific subscription', async () => {
      mockPost.mockResolvedValue({});

      const { result } = renderHook(() => useCreateSubscription(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.mutateAsync({
          hive_id: 'hive_1',
          swarm_id: 'swarm_1',
          source: 'slack',
          event_types: ['message'],
          priority: 50,
        });
      });

      expect(mockPost).toHaveBeenCalledWith('/events/subscriptions', {
        hive_id: 'hive_1',
        swarm_id: 'swarm_1',
        source: 'slack',
        event_types: ['message'],
        priority: 50,
      });
    });
  });

  describe('useUpdateSubscription', () => {
    it('puts to update a subscription', async () => {
      mockPut.mockResolvedValue({});

      const { result } = renderHook(() => useUpdateSubscription(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.mutateAsync({
          id: 's_1',
          event_types: ['push', 'issues.opened'],
          enabled: false,
        });
      });

      expect(mockPut).toHaveBeenCalledWith('/events/subscriptions/s_1', {
        event_types: ['push', 'issues.opened'],
        enabled: false,
      });
    });
  });

  describe('useDeleteSubscription', () => {
    it('deletes a subscription by id', async () => {
      mockDelete.mockResolvedValue({});

      const { result } = renderHook(() => useDeleteSubscription(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.mutateAsync('s_1');
      });

      expect(mockDelete).toHaveBeenCalledWith('/events/subscriptions/s_1');
    });
  });

  // ── Delivery Log ──

  describe('useDeliveryLog', () => {
    it('fetches delivery log with no filters', async () => {
      const response = { data: [], total: 0 };
      mockGet.mockResolvedValue(response);

      const { result } = renderHook(() => useDeliveryLog(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/events/delivery-log');
      expect(result.current.data).toEqual(response);
    });

    it('filters by swarm_id', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0 });

      const { result } = renderHook(
        () => useDeliveryLog({ swarm_id: 'swarm_1' }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/events/delivery-log?swarm_id=swarm_1');
    });

    it('filters by delivery_id', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0 });

      const { result } = renderHook(
        () => useDeliveryLog({ delivery_id: 'del_123' }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/events/delivery-log?delivery_id=del_123');
    });

    it('passes pagination parameters', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0 });

      const { result } = renderHook(
        () => useDeliveryLog({ limit: 25, offset: 50 }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/events/delivery-log?limit=25&offset=50');
    });

    it('combines all filters and pagination', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0 });

      const { result } = renderHook(
        () => useDeliveryLog({ delivery_id: 'del_x', swarm_id: 'swarm_1', limit: 10, offset: 20 }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(
        '/events/delivery-log?delivery_id=del_x&swarm_id=swarm_1&limit=10&offset=20',
      );
    });
  });

  // ── Query Invalidation ──

  describe('Query Invalidation', () => {
    it('invalidates post-rules cache after create', async () => {
      mockGet.mockResolvedValue({ data: [] });
      mockPost.mockResolvedValue({ id: 'new' });

      const wrapper = createWrapper();
      const { result: rulesResult } = renderHook(() => usePostRules(), { wrapper });
      const { result: createResult } = renderHook(() => useCreatePostRule(), { wrapper });

      await waitFor(() => expect(rulesResult.current.isSuccess).toBe(true));
      const callCount = mockGet.mock.calls.filter((c: string[]) => c[0] === '/events/post-rules').length;

      await act(async () => {
        await createResult.current.mutateAsync({
          hive_id: 'h', source: 'github', event_types: ['push'],
        });
      });

      // After mutation, the query should be refetched
      await waitFor(() => {
        const newCallCount = mockGet.mock.calls.filter((c: string[]) => c[0] === '/events/post-rules').length;
        expect(newCallCount).toBeGreaterThan(callCount);
      });
    });

    it('invalidates event-subscriptions cache after create', async () => {
      mockGet.mockResolvedValue({ data: [] });
      mockPost.mockResolvedValue({ id: 'new' });

      const wrapper = createWrapper();
      const { result: subsResult } = renderHook(() => useEventSubscriptions(), { wrapper });
      const { result: createResult } = renderHook(() => useCreateSubscription(), { wrapper });

      await waitFor(() => expect(subsResult.current.isSuccess).toBe(true));
      const callCount = mockGet.mock.calls.filter((c: string[]) => c[0] === '/events/subscriptions').length;

      await act(async () => {
        await createResult.current.mutateAsync({
          hive_id: 'h', source: 'github', event_types: ['push'],
        });
      });

      await waitFor(() => {
        const newCallCount = mockGet.mock.calls.filter((c: string[]) => c[0] === '/events/subscriptions').length;
        expect(newCallCount).toBeGreaterThan(callCount);
      });
    });
  });
});
