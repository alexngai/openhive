// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

// ── Capture useWSEvent callbacks by event type ──

const mockUseSubscribe = vi.fn();
const eventHandlers = new Map<string, (...args: unknown[]) => void>();

const mockUseWSEvent = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
  eventHandlers.set(event, handler);
});

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: (...args: unknown[]) => mockUseSubscribe(...args),
  useWSEvent: (...args: unknown[]) => mockUseWSEvent(...args),
}));

import {
  useSwarmRealtime,
  useResourcesRealtime,
  useSessionsRealtime,
} from '../../hooks/useRealtimeInvalidation';

// ── Helpers ──

let queryClient: QueryClient;

function createWrapper() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// ── Tests ──

describe('useRealtimeInvalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
  });

  // ── useSwarmRealtime ──

  describe('useSwarmRealtime', () => {
    it('subscribes to map:discovery channel', () => {
      renderHook(() => useSwarmRealtime(), { wrapper: createWrapper() });
      expect(mockUseSubscribe).toHaveBeenCalledWith(['map:discovery']);
    });

    it('registers handlers for all swarm event types', () => {
      renderHook(() => useSwarmRealtime(), { wrapper: createWrapper() });

      const registeredEvents = mockUseWSEvent.mock.calls.map((call) => call[0]);
      expect(registeredEvents).toContain('swarm_registered');
      expect(registeredEvents).toContain('swarm_offline');
      expect(registeredEvents).toContain('swarm_spawned');
      expect(registeredEvents).toContain('swarm_stopped');
      expect(registeredEvents).toContain('swarm_heartbeat');
    });

    it.each([
      'swarm_registered',
      'swarm_offline',
      'swarm_spawned',
      'swarm_stopped',
      'swarm_heartbeat',
    ])('invalidates swarm query keys on %s event', (eventType) => {
      renderHook(() => useSwarmRealtime(), { wrapper: createWrapper() });
      const spy = vi.spyOn(queryClient, 'invalidateQueries');

      const handler = eventHandlers.get(eventType);
      expect(handler).toBeDefined();
      handler!({});

      expect(spy).toHaveBeenCalledWith({ queryKey: ['hosted-swarms'] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ['map-swarms'] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ['map-stats'] });
    });

    it('does not invalidate resource or session query keys', () => {
      renderHook(() => useSwarmRealtime(), { wrapper: createWrapper() });
      const spy = vi.spyOn(queryClient, 'invalidateQueries');

      eventHandlers.get('swarm_registered')!({});
      eventHandlers.get('swarm_heartbeat')!({});

      const invalidatedKeys = spy.mock.calls.map((call) => (call[0] as { queryKey: string[] }).queryKey);
      expect(invalidatedKeys).not.toContainEqual(['resources']);
      expect(invalidatedKeys).not.toContainEqual(['sessions-overview']);
    });
  });

  // ── useResourcesRealtime ──

  describe('useResourcesRealtime', () => {
    it('subscribes to global channel', () => {
      renderHook(() => useResourcesRealtime(), { wrapper: createWrapper() });
      expect(mockUseSubscribe).toHaveBeenCalledWith(['global']);
    });

    it('registers handlers for all resource event types', () => {
      renderHook(() => useResourcesRealtime(), { wrapper: createWrapper() });

      const registeredEvents = mockUseWSEvent.mock.calls.map((call) => call[0]);
      expect(registeredEvents).toContain('resource_updated');
      expect(registeredEvents).toContain('resource_created');
      expect(registeredEvents).toContain('resource_synced');
    });

    it.each([
      'resource_updated',
      'resource_created',
      'resource_synced',
    ])('invalidates resource query keys on %s event', (eventType) => {
      renderHook(() => useResourcesRealtime(), { wrapper: createWrapper() });
      const spy = vi.spyOn(queryClient, 'invalidateQueries');

      const handler = eventHandlers.get(eventType);
      expect(handler).toBeDefined();
      handler!({});

      expect(spy).toHaveBeenCalledWith({ queryKey: ['resources'] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ['resource-events'] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ['sync-status'] });
    });

    it('does not invalidate swarm or session query keys', () => {
      renderHook(() => useResourcesRealtime(), { wrapper: createWrapper() });
      const spy = vi.spyOn(queryClient, 'invalidateQueries');

      eventHandlers.get('resource_updated')!({});

      const invalidatedKeys = spy.mock.calls.map((call) => (call[0] as { queryKey: string[] }).queryKey);
      expect(invalidatedKeys).not.toContainEqual(['hosted-swarms']);
      expect(invalidatedKeys).not.toContainEqual(['sessions-overview']);
    });
  });

  // ── useSessionsRealtime ──

  describe('useSessionsRealtime', () => {
    it('subscribes to global channel', () => {
      renderHook(() => useSessionsRealtime(), { wrapper: createWrapper() });
      expect(mockUseSubscribe).toHaveBeenCalledWith(['global']);
    });

    it('registers handler for trajectory:sync event', () => {
      renderHook(() => useSessionsRealtime(), { wrapper: createWrapper() });

      const registeredEvents = mockUseWSEvent.mock.calls.map((call) => call[0]);
      expect(registeredEvents).toContain('trajectory:sync');
      expect(registeredEvents).toHaveLength(1);
    });

    it('invalidates session query keys on trajectory:sync event', () => {
      renderHook(() => useSessionsRealtime(), { wrapper: createWrapper() });
      const spy = vi.spyOn(queryClient, 'invalidateQueries');

      const handler = eventHandlers.get('trajectory:sync');
      expect(handler).toBeDefined();
      handler!({});

      expect(spy).toHaveBeenCalledWith({ queryKey: ['sessions-overview'] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ['session-checkpoints'] });
    });

    it('does not invalidate swarm or resource query keys', () => {
      renderHook(() => useSessionsRealtime(), { wrapper: createWrapper() });
      const spy = vi.spyOn(queryClient, 'invalidateQueries');

      eventHandlers.get('trajectory:sync')!({});

      const invalidatedKeys = spy.mock.calls.map((call) => (call[0] as { queryKey: string[] }).queryKey);
      expect(invalidatedKeys).not.toContainEqual(['hosted-swarms']);
      expect(invalidatedKeys).not.toContainEqual(['resources']);
    });
  });
});
