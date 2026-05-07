/**
 * hostedChatService — listener wiring + envelope unwrap regression.
 *
 * Mocks `useWSStore` + the WS imperative-subscribe helper to drive the
 * service singleton's listener with the actual store-emit shape
 * (`{type, channel, data: HostedChatPayload}`), and verifies the
 * subscription handlers receive the unwrapped event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listeners = new Map<string, Set<(data: unknown) => void>>();

const addListener = vi.fn((event: string, cb: (data: unknown) => void) => {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
});

vi.mock('../../hooks/useWebSocket', () => ({
  useWSStore: {
    getState: () => ({ addListener }),
  },
  subscribeChannelImperatively: vi.fn(() => () => {}),
}));

vi.mock('../../lib/api', () => ({
  api: { post: vi.fn().mockResolvedValue({ turn_id: 't1' }) },
}));

import { hostedChatService } from '../../services/hosted-chat-service';

function emit(event: string, payload: unknown): void {
  const set = listeners.get(event);
  if (!set) throw new Error(`no listeners for ${event}`);
  for (const cb of set) cb(payload);
}

const activeUnsubs: Array<() => void> = [];

beforeEach(() => {
  // The service singleton registers its store listener exactly once; do NOT
  // clear `listeners` between tests. Instead, drop any handler subscriptions
  // accumulated by the previous test so emits don't bleed into the next.
  while (activeUnsubs.length) activeUnsubs.pop()!();
  addListener.mockClear();
});

describe('hostedChatService', () => {
  it('unwraps the WS envelope and routes events to subscribed handlers', () => {
    const handlers = {
      onMessageStart: vi.fn(),
      onMessageDelta: vi.fn(),
      onMessageComplete: vi.fn(),
      onTurnStarted: vi.fn(),
      onTurnCompleted: vi.fn(),
      onError: vi.fn(),
    };

    activeUnsubs.push(hostedChatService.subscribe('hsw_x', handlers));

    // Drive the listener with the actual emit shape: store calls cb(message),
    // where message is the WS envelope `{type, channel, data: payload}`.
    emit('hosted-chat.event', {
      type: 'hosted-chat.event',
      channel: 'hosted-chat:hsw_x',
      data: {
        hosted_swarm_id: 'hsw_x',
        provider: 'codex',
        event: { kind: 'message.start', itemId: 'item-1', role: 'assistant' },
      },
    });
    emit('hosted-chat.event', {
      type: 'hosted-chat.event',
      channel: 'hosted-chat:hsw_x',
      data: {
        hosted_swarm_id: 'hsw_x',
        provider: 'codex',
        event: { kind: 'message.delta', itemId: 'item-1', delta: 'hi' },
      },
    });

    expect(handlers.onMessageStart).toHaveBeenCalledWith('item-1', 'assistant');
    expect(handlers.onMessageDelta).toHaveBeenCalledWith('item-1', 'hi');
  });

  it('ignores events for hosted swarms with no subscribers', () => {
    const handlers = {
      onMessageStart: vi.fn(),
      onMessageDelta: vi.fn(),
      onMessageComplete: vi.fn(),
      onTurnStarted: vi.fn(),
      onTurnCompleted: vi.fn(),
      onError: vi.fn(),
    };
    activeUnsubs.push(hostedChatService.subscribe('hsw_x', handlers));

    emit('hosted-chat.event', {
      type: 'hosted-chat.event',
      data: {
        hosted_swarm_id: 'hsw_other',
        provider: 'codex',
        event: { kind: 'message.delta', itemId: 'item-1', delta: 'wrong-target' },
      },
    });

    expect(handlers.onMessageDelta).not.toHaveBeenCalled();
  });

  it('drops malformed envelopes without throwing', () => {
    const handlers = {
      onMessageStart: vi.fn(),
      onMessageDelta: vi.fn(),
      onMessageComplete: vi.fn(),
      onTurnStarted: vi.fn(),
      onTurnCompleted: vi.fn(),
      onError: vi.fn(),
    };
    activeUnsubs.push(hostedChatService.subscribe('hsw_x', handlers));

    expect(() => emit('hosted-chat.event', undefined)).not.toThrow();
    expect(() => emit('hosted-chat.event', { type: 'hosted-chat.event' })).not.toThrow();
    expect(handlers.onMessageDelta).not.toHaveBeenCalled();
  });
});
