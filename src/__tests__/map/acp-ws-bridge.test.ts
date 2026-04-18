/**
 * Tests for the ACP WebSocket bridge.
 *
 * Verifies that acp.* events from SwarmCraft's wsHub.broadcast() are
 * forwarded to OpenHive's broadcastToChannel() via the interceptor
 * in server.ts.
 */

import { describe, it, expect, vi } from 'vitest';

// Simulate the bridge logic from server.ts. Mirrors the real impl exactly,
// including the `topic === 'acp'` filter that prevents duplicate forwards
// when SwarmCraft broadcasts to both 'events' and 'acp' topics.
function createBridge(
  origBroadcast: (message: any, topic?: string) => void,
  broadcastToChannel: (channel: string, event: any) => void,
) {
  return (message: any, topic?: string) => {
    // Forward to original SwarmCraft subscribers
    origBroadcast(message, topic);

    // Bridge acp.* events to OpenHive's WS — only from the 'acp' topic.
    if (topic === 'acp' && message?.type && typeof message.type === 'string' && message.type.startsWith('acp.')) {
      broadcastToChannel('global', {
        type: message.type,
        data: message.payload ?? message.data ?? message,
      });
    }
  };
}

describe('ACP WebSocket Bridge', () => {
  it('forwards acp.session.update events to OpenHive WS', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    const acpEvent = {
      type: 'acp.session.update',
      payload: { streamId: 'stream-1', update: { content: { text: 'hello' } } },
    };

    bridge(acpEvent, 'acp');

    // Original broadcast should be called
    expect(origBroadcast).toHaveBeenCalledWith(acpEvent, 'acp');

    // Bridge should forward to OpenHive
    expect(broadcastToChannel).toHaveBeenCalledWith('global', {
      type: 'acp.session.update',
      data: acpEvent.payload,
    });
  });

  it('forwards acp.prompt.completed events', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    bridge({ type: 'acp.prompt.completed', payload: { streamId: 'stream-1' } }, 'acp');

    expect(broadcastToChannel).toHaveBeenCalledWith('global', {
      type: 'acp.prompt.completed',
      data: { streamId: 'stream-1' },
    });
  });

  it('forwards acp.stream.error events', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    bridge({ type: 'acp.stream.error', payload: { error: 'Connection lost' } }, 'acp');

    expect(broadcastToChannel).toHaveBeenCalledWith('global', {
      type: 'acp.stream.error',
      data: { error: 'Connection lost' },
    });
  });

  // Multi-tab sync (Option 1B) relies on these new events fanning out to
  // sibling tabs. Verify the bridge forwards them.
  it('forwards acp.prompt.started events (multi-tab user-prompt sync)', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    const payload = {
      streamId: 'stream-1',
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'hello' }],
    };
    bridge({ type: 'acp.prompt.started', payload }, 'acp');

    expect(broadcastToChannel).toHaveBeenCalledWith('global', {
      type: 'acp.prompt.started',
      data: payload,
    });
  });

  it('forwards acp.permission.resolved events (multi-tab clear-on-answer)', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    const payload = { streamId: 'stream-1', requestId: 'req-1', sessionId: 'sess-1' };
    bridge({ type: 'acp.permission.resolved', payload }, 'acp');

    expect(broadcastToChannel).toHaveBeenCalledWith('global', {
      type: 'acp.permission.resolved',
      data: payload,
    });
  });

  it('forwards acp.question.resolved events', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    const payload = { streamId: 'stream-1', requestId: 'q-1' };
    bridge({ type: 'acp.question.resolved', payload }, 'acp');

    expect(broadcastToChannel).toHaveBeenCalledWith('global', {
      type: 'acp.question.resolved',
      data: payload,
    });
  });

  it('does NOT forward acp events from non-acp topics (avoids duplicate fan-out)', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    // SwarmCraft broadcasts to both 'events' and 'acp' topics; if we
    // forwarded both we'd deliver duplicates to the global channel.
    bridge({ type: 'acp.session.update', payload: { x: 1 } }, 'events');

    expect(origBroadcast).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('does NOT forward non-ACP events', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    bridge({ type: 'agent.registered', payload: { id: 'agent-1' } });
    bridge({ type: 'agent.state.changed', payload: { agentId: 'agent-1' } });
    bridge({ type: 'message.sent', payload: { messageId: 'msg-1' } });

    // Original broadcast called for all
    expect(origBroadcast).toHaveBeenCalledTimes(3);

    // But bridge should NOT forward non-ACP events
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('always calls original broadcast', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    bridge({ type: 'anything' }, 'topic');
    bridge({ type: 'acp.test' });

    expect(origBroadcast).toHaveBeenCalledTimes(2);
  });

  it('extracts payload from acp event for forwarding', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    // With payload field
    bridge({ type: 'acp.session.update', payload: { update: { text: 'hi' } } }, 'acp');
    expect(broadcastToChannel).toHaveBeenCalledWith('global', {
      type: 'acp.session.update',
      data: { update: { text: 'hi' } },
    });

    broadcastToChannel.mockClear();

    // With data field (alternative shape)
    bridge({ type: 'acp.session.update', data: { update: { text: 'hello' } } }, 'acp');
    expect(broadcastToChannel).toHaveBeenCalledWith('global', {
      type: 'acp.session.update',
      data: { update: { text: 'hello' } },
    });
  });

  it('handles events without payload gracefully', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    // No payload or data — should forward the message itself as data
    bridge({ type: 'acp.stream.closed' }, 'acp');

    expect(broadcastToChannel).toHaveBeenCalledWith('global', {
      type: 'acp.stream.closed',
      data: { type: 'acp.stream.closed' },
    });
  });

  it('handles null/undefined message type', () => {
    const origBroadcast = vi.fn();
    const broadcastToChannel = vi.fn();
    const bridge = createBridge(origBroadcast, broadcastToChannel);

    bridge({ type: null });
    bridge({ type: undefined });
    bridge({});
    bridge(null);

    expect(origBroadcast).toHaveBeenCalledTimes(4);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });
});
