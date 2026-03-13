/**
 * Tests for MAP event subscriptions (map/subscribe, map/unsubscribe, event delivery).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  handleMapSubscribe,
  handleMapUnsubscribe,
  notifySubscribers,
  cleanupSubscriptions,
} from '../../map/event-subscriptions.js';

function createMockWs(): WebSocket {
  const ws = new EventEmitter() as unknown as WebSocket;
  (ws as unknown as { readyState: number }).readyState = WebSocket.OPEN;
  (ws as unknown as { send: (data: string) => void }).send = vi.fn();
  return ws;
}

function allSent(ws: WebSocket): unknown[] {
  const send = ws.send as ReturnType<typeof vi.fn>;
  return send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
}

function lastSent(ws: WebSocket): unknown {
  const msgs = allSent(ws);
  return msgs[msgs.length - 1];
}

describe('MAP Event Subscriptions', () => {
  beforeEach(() => {
    // Clean up all subscriptions between tests
    cleanupSubscriptions('swarm-1');
    cleanupSubscriptions('swarm-2');
    cleanupSubscriptions('swarm-3');
  });

  it('should return subscriptionId on subscribe', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, {
      id: '1',
      params: { filter: { eventTypes: ['x-hive.post.created'] } },
    }, 'swarm-1');

    const response = lastSent(ws) as { result?: { subscriptionId: string } };
    expect(response.result).toBeDefined();
    expect(response.result!.subscriptionId).toBeDefined();
    expect(typeof response.result!.subscriptionId).toBe('string');
  });

  it('should deliver matching events with MAP envelope', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, {
      id: '1',
      params: { filter: { eventTypes: ['x-hive.post.created'] } },
    }, 'swarm-1');

    const subResponse = lastSent(ws) as { result: { subscriptionId: string } };
    const subId = subResponse.result.subscriptionId;

    notifySubscribers('x-hive.post.created', { post: { id: 'p1', title: 'Test' } });

    const msgs = allSent(ws);
    const event = msgs[msgs.length - 1] as {
      method: string;
      params: {
        subscriptionId: string;
        sequence: number;
        timestamp: string;
        event: { type: string; data: unknown };
        eventId: string;
      };
    };

    expect(event.method).toBe('map/event');
    expect(event.params.subscriptionId).toBe(subId);
    expect(event.params.sequence).toBe(1);
    expect(event.params.timestamp).toBeDefined();
    expect(event.params.event.type).toBe('x-hive.post.created');
    expect(event.params.event.data).toEqual({ post: { id: 'p1', title: 'Test' } });
    expect(event.params.eventId).toBeDefined();
  });

  it('should filter by event type', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, {
      id: '1',
      params: { filter: { eventTypes: ['x-hive.post.created'] } },
    }, 'swarm-1');

    const callsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

    // Non-matching event
    notifySubscribers('x-hive.comment.added', { comment: { id: 'c1' } });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

    // Matching event
    notifySubscribers('x-hive.post.created', { post: { id: 'p1' } });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
  });

  it('should filter by hive (AND logic with eventTypes)', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, {
      id: '1',
      params: { filter: { eventTypes: ['x-hive.post.created'], hive: 'my-hive' } },
    }, 'swarm-1');

    const callsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

    // Right event type, wrong hive
    notifySubscribers('x-hive.post.created', { post: { id: 'p1' } }, { hive: 'other-hive' });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

    // Right event type, right hive
    notifySubscribers('x-hive.post.created', { post: { id: 'p2' } }, { hive: 'my-hive' });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
  });

  it('should receive all events when no filter specified', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, {
      id: '1',
      params: {},
    }, 'swarm-1');

    const callsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

    notifySubscribers('x-hive.post.created', { post: { id: 'p1' } });
    notifySubscribers('message.created', { msg: { id: 'm1' } });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 2);
  });

  it('should unsubscribe by subscriptionId', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, {
      id: '1',
      params: { filter: { eventTypes: ['x-hive.post.created'] } },
    }, 'swarm-1');

    const subResponse = lastSent(ws) as { result: { subscriptionId: string } };
    const subId = subResponse.result.subscriptionId;

    handleMapUnsubscribe(ws, {
      id: '2',
      params: { subscriptionId: subId },
    }, 'swarm-1');

    const unsubResponse = lastSent(ws) as { result?: { unsubscribed: boolean } };
    expect(unsubResponse.result!.unsubscribed).toBe(true);

    // Should not receive events anymore
    const callsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;
    notifySubscribers('x-hive.post.created', { post: { id: 'p1' } });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('should return unsubscribed false for wrong subscriptionId', () => {
    const ws = createMockWs();
    handleMapUnsubscribe(ws, {
      id: '1',
      params: { subscriptionId: 'nonexistent' },
    }, 'swarm-1');

    const response = lastSent(ws) as { result?: { unsubscribed: boolean } };
    expect(response.result!.unsubscribed).toBe(false);
  });

  it('should return error when subscriptionId is missing', () => {
    const ws = createMockWs();
    handleMapUnsubscribe(ws, {
      id: '1',
      params: {},
    }, 'swarm-1');

    const response = lastSent(ws) as { error?: { code: number } };
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
  });

  it('should cleanup all subscriptions for a swarm on disconnect', () => {
    const ws = createMockWs();

    // Create two subscriptions
    handleMapSubscribe(ws, { id: '1', params: {} }, 'swarm-1');
    handleMapSubscribe(ws, { id: '2', params: {} }, 'swarm-1');

    const callsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

    // Should receive events
    notifySubscribers('test.event', { x: 1 });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 2); // Both subs

    // Cleanup
    cleanupSubscriptions('swarm-1');

    const callsAfterCleanup = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;
    notifySubscribers('test.event', { x: 2 });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterCleanup); // No more
  });

  it('should deliver to multiple subscribers', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    handleMapSubscribe(ws1, { id: '1', params: {} }, 'swarm-1');
    handleMapSubscribe(ws2, { id: '2', params: {} }, 'swarm-2');

    notifySubscribers('x-hive.post.created', { post: { id: 'p1' } });

    // Both should receive (subscribe response + event = 2 calls each)
    expect((ws1.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect((ws2.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('should increment sequence numbers per subscription', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, { id: '1', params: {} }, 'swarm-1');

    notifySubscribers('event.a', { x: 1 });
    notifySubscribers('event.b', { x: 2 });
    notifySubscribers('event.c', { x: 3 });

    const msgs = allSent(ws);
    // msgs[0] is subscribe response, msgs[1..3] are events
    const events = msgs.slice(1) as { params: { sequence: number } }[];
    expect(events[0].params.sequence).toBe(1);
    expect(events[1].params.sequence).toBe(2);
    expect(events[2].params.sequence).toBe(3);
  });

  // ═══════════════════════════════════════════════════════════════
  // Mail event subscriptions
  // ═══════════════════════════════════════════════════════════════

  it('should filter mail events by conversationId', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, {
      id: '1',
      params: { filter: { eventTypes: ['mail.turn.added'], conversationId: 'conv-1' } },
    }, 'swarm-1');

    const callsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

    // Wrong conversation
    notifySubscribers('mail.turn.added', { turn: { id: 't1' } }, { conversationId: 'conv-2' });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

    // Right conversation
    notifySubscribers('mail.turn.added', { turn: { id: 't2' } }, { conversationId: 'conv-1' });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
  });

  it('should deliver x-hive.vote.cast events with hive filter', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, {
      id: '1',
      params: { filter: { eventTypes: ['x-hive.vote.cast'], hive: 'my-hive' } },
    }, 'swarm-1');

    const callsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

    // Wrong hive
    notifySubscribers('x-hive.vote.cast', { vote: { value: 1 } }, { hive: 'other-hive' });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

    // Right hive
    notifySubscribers('x-hive.vote.cast', { vote: { value: 1 }, target_type: 'post', target_id: 'p1' }, { hive: 'my-hive' });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
  });

  it('should deliver mail.created and mail.participant.joined events', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, {
      id: '1',
      params: { filter: { eventTypes: ['mail.created', 'mail.participant.joined'] } },
    }, 'swarm-1');

    const callsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

    notifySubscribers('mail.created', { id: 'conv-1', subject: 'Test' });
    notifySubscribers('mail.participant.joined', { conversation_id: 'conv-1', agent_id: 'a1' });
    notifySubscribers('mail.turn.added', { turn: { id: 't1' } }); // Should NOT match

    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 2);
  });

  it('should deliver mail.closed events filtered by conversationId', () => {
    const ws = createMockWs();
    handleMapSubscribe(ws, {
      id: '1',
      params: { filter: { eventTypes: ['mail.closed'], conversationId: 'conv-1' } },
    }, 'swarm-1');

    const callsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

    // Wrong conversation
    notifySubscribers('mail.closed', { conversation_id: 'conv-2', status: 'completed' }, { conversationId: 'conv-2' });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

    // Right conversation
    notifySubscribers('mail.closed', { conversation_id: 'conv-1', status: 'completed' }, { conversationId: 'conv-1' });
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
  });
});
