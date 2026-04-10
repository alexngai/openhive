/**
 * Tests for useSessionChatRealtime — WebSocket cache invalidation for session chat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

// ── Mock WebSocket hooks ───────────────────────────────────────────────────

const mockUseSubscribe = vi.fn();
const eventHandlers = new Map<string, (...args: unknown[]) => void>();

const mockUseWSEvent = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
  eventHandlers.set(event, handler);
});

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: (...args: unknown[]) => mockUseSubscribe(...args),
  useWSEvent: (...args: unknown[]) => mockUseWSEvent(...args),
}));

import { useSessionChatRealtime } from '../../hooks/useSessionChatRealtime';

// ── Helpers ────────────────────────────────────────────────────────────────

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useSessionChatRealtime', () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  });

  it('subscribes to conversation channel when conversationId provided', () => {
    renderHook(
      () => useSessionChatRealtime('session-1', 'conv-abc'),
      { wrapper: createWrapper(queryClient) },
    );

    expect(mockUseSubscribe).toHaveBeenCalledWith(['mail:conversation:conv-abc']);
  });

  it('subscribes to empty channels when no conversationId', () => {
    renderHook(
      () => useSessionChatRealtime('session-1', null),
      { wrapper: createWrapper(queryClient) },
    );

    expect(mockUseSubscribe).toHaveBeenCalledWith([]);
  });

  it('subscribes to empty channels when conversationId undefined', () => {
    renderHook(
      () => useSessionChatRealtime('session-1', undefined),
      { wrapper: createWrapper(queryClient) },
    );

    expect(mockUseSubscribe).toHaveBeenCalledWith([]);
  });

  it('registers handler for mail.turn.added event', () => {
    renderHook(
      () => useSessionChatRealtime('session-1', 'conv-abc'),
      { wrapper: createWrapper(queryClient) },
    );

    expect(mockUseWSEvent).toHaveBeenCalledWith('mail.turn.added', expect.any(Function));
    expect(eventHandlers.has('mail.turn.added')).toBe(true);
  });

  it('invalidates session-events on mail.turn.added', () => {
    renderHook(
      () => useSessionChatRealtime('session-1', 'conv-abc'),
      { wrapper: createWrapper(queryClient) },
    );

    const handler = eventHandlers.get('mail.turn.added');
    handler!({});

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['session-events', 'session-1'] });
  });

  it('invalidates mail-turns on mail.turn.added', () => {
    renderHook(
      () => useSessionChatRealtime('session-1', 'conv-abc'),
      { wrapper: createWrapper(queryClient) },
    );

    const handler = eventHandlers.get('mail.turn.added');
    handler!({});

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['mail-turns', 'conv-abc'] });
  });

  it('does not invalidate session-events when sessionId is undefined', () => {
    renderHook(
      () => useSessionChatRealtime(undefined, 'conv-abc'),
      { wrapper: createWrapper(queryClient) },
    );

    const handler = eventHandlers.get('mail.turn.added');
    handler!({});

    // Should not invalidate session-events (no sessionId)
    const sessionCalls = invalidateSpy.mock.calls.filter(
      (call) => (call[0] as any)?.queryKey?.[0] === 'session-events',
    );
    expect(sessionCalls).toHaveLength(0);
  });

  it('does not invalidate mail-turns when conversationId is null', () => {
    renderHook(
      () => useSessionChatRealtime('session-1', null),
      { wrapper: createWrapper(queryClient) },
    );

    const handler = eventHandlers.get('mail.turn.added');
    handler!({});

    // Should not invalidate mail-turns (no conversationId)
    const mailCalls = invalidateSpy.mock.calls.filter(
      (call) => (call[0] as any)?.queryKey?.[0] === 'mail-turns',
    );
    expect(mailCalls).toHaveLength(0);
  });
});
