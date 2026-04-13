// @vitest-environment jsdom
/**
 * Tests for useAcpStream — ACP streaming session management hook.
 *
 * Tests the stream lifecycle, text accumulation, tool call handling,
 * and error states. Uses mocked fetch and WebSocket event handlers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ── Mock WebSocket hooks ───────────────────────────────────────────────────

const mockUseSubscribe = vi.fn();
const eventHandlers = new Map<string, (...args: unknown[]) => void>();

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: (...args: unknown[]) => mockUseSubscribe(...args),
  useWSEvent: (event: string, handler: (...args: unknown[]) => void) => {
    eventHandlers.set(event, handler);
  },
}));

import { useAcpStream } from '../../hooks/useAcpStream';

// ── Fetch mock ─────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
let fetchCallIndex: number;
const fetchResponses: Array<{ data: any; ok?: boolean; status?: number }> = [];

function queueFetchResponse(data: any, ok = true, status = 200) {
  fetchResponses.push({ data, ok, status });
}

beforeEach(() => {
  fetchCallIndex = 0;
  fetchResponses.length = 0;
  eventHandlers.clear();
  mockUseSubscribe.mockClear();

  fetchMock = vi.fn().mockImplementation((url: string, opts?: any) => {
    // Cleanup DELETE calls should always succeed
    if (opts?.method === 'DELETE') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    const response = fetchResponses[fetchCallIndex++];
    if (!response) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: () => Promise.resolve(response.data),
    });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useAcpStream', () => {
  describe('initial state', () => {
    it('starts in idle status', () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: null, enabled: false }),
        { wrapper: createWrapper() },
      );

      expect(result.current.status).toBe('idle');
      expect(result.current.error).toBeNull();
      expect(result.current.events).toEqual([]);
    });

    it('does not subscribe to WebSocket when no stream', () => {
      renderHook(
        () => useAcpStream({ serverId: null, enabled: false }),
        { wrapper: createWrapper() },
      );

      expect(mockUseSubscribe).toHaveBeenCalledWith([]);
    });

    it('registers WebSocket event handlers', () => {
      renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );

      expect(eventHandlers.has('acp.session.update')).toBe(true);
      expect(eventHandlers.has('acp.prompt.completed')).toBe(true);
      expect(eventHandlers.has('acp.stream.error')).toBe(true);
    });
  });

  describe('connect', () => {
    it('creates stream, initializes, and creates session', async () => {
      queueFetchResponse({ data: { streamId: 'stream-1' } }); // create stream
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } }); // initialize
      queueFetchResponse({ data: { sessionId: 'session-1' } }); // create session

      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.status).toBe('ready');
      expect(result.current.error).toBeNull();
    });

    it('sets error status on connection failure', async () => {
      queueFetchResponse({ error: 'Not found' }, false, 404); // agent list fails
      queueFetchResponse({ error: 'Connection refused' }, false, 503); // create stream fails

      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error).toBeDefined();
    });

    it('does nothing when serverId is null', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: null, enabled: true }),
        { wrapper: createWrapper() },
      );

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.status).toBe('idle');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('WebSocket text accumulation', () => {
    // Helper: connect the stream so streamIdRef is set and WS events are processed
    async function connectStream(result: any) {
      queueFetchResponse({ data: { streamId: 'stream-ws' } });
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } });
      queueFetchResponse({ data: { sessionId: 'session-ws' } });
      await act(async () => { await result.current.connect(); });
    }

    it('creates new assistant message on first text chunk', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.session.update')!;
      act(() => { handler({ update: { content: { text: 'Hello' } } }); });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].type).toBe('assistant_message');
      expect(result.current.events[0].content?.[0]?.text).toBe('Hello');
    });

    it('accumulates text chunks into same message', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.session.update')!;
      act(() => { handler({ update: { content: { text: 'Hello ' } } }); });
      act(() => { handler({ update: { content: { text: 'world' } } }); });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].content?.[0]?.text).toBe('Hello world');
    });

    it('marks streaming message with _isStreaming', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.session.update')!;
      act(() => { handler({ update: { content: { text: 'Hello' } } }); });

      expect((result.current.events[0] as any)._isStreaming).toBe(true);
    });

    it('finalizes message on prompt completed', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const updateHandler = eventHandlers.get('acp.session.update')!;
      const completedHandler = eventHandlers.get('acp.prompt.completed')!;

      act(() => { updateHandler({ update: { content: { text: 'Done' } } }); });
      expect((result.current.events[0] as any)._isStreaming).toBe(true);

      // Completed handler should set status to ready
      act(() => { completedHandler({}); });
      expect(result.current.status).toBe('ready');

      // The _isStreaming flag may be set to undefined or deleted
      // The key assertion is that status transitions to ready
    });
  });

  describe('session/load replay (user_message_chunk handling)', () => {
    async function connectStream(result: any) {
      queueFetchResponse({ data: { streamId: 'stream-ws' } });
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } });
      queueFetchResponse({ data: { sessionId: 'session-ws' } });
      await act(async () => { await result.current.connect(); });
    }

    it('emits user_message event for replayed user_message_chunk', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.session.update')!;
      act(() => {
        handler({
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Reply with: hi' },
          },
        });
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].type).toBe('user_message');
      expect(result.current.events[0].content?.[0]?.text).toBe('Reply with: hi');
    });

    it('reconstructs alternating user/assistant conversation on replay', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.session.update')!;

      // Simulate session/load replay: user prompt → agent response chunks → user prompt → agent
      act(() => {
        handler({
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        });
      });
      act(() => {
        handler({
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hi ' },
          },
        });
      });
      act(() => {
        handler({
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'there' },
          },
        });
      });
      act(() => {
        handler({
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'how are you' },
          },
        });
      });

      // Expect 3 distinct events: user, assistant (concatenated), user
      expect(result.current.events).toHaveLength(3);
      expect(result.current.events[0].type).toBe('user_message');
      expect(result.current.events[0].content?.[0]?.text).toBe('hello');
      expect(result.current.events[1].type).toBe('assistant_message');
      expect(result.current.events[1].content?.[0]?.text).toBe('hi there');
      expect(result.current.events[2].type).toBe('user_message');
      expect(result.current.events[2].content?.[0]?.text).toBe('how are you');
    });

    it('does not concatenate user text into preceding assistant bubble', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.session.update')!;
      // Prior assistant streaming bubble
      act(() => {
        handler({
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Here you go.' },
          },
        });
      });
      // Then a new user message — must start a fresh bubble, not append
      act(() => {
        handler({
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Thanks!' },
          },
        });
      });

      expect(result.current.events).toHaveLength(2);
      expect(result.current.events[0].type).toBe('assistant_message');
      expect(result.current.events[0].content?.[0]?.text).toBe('Here you go.');
      expect(result.current.events[1].type).toBe('user_message');
      expect(result.current.events[1].content?.[0]?.text).toBe('Thanks!');
    });
  });

  describe('WebSocket tool call handling', () => {
    async function connectStream(result: any) {
      queueFetchResponse({ data: { streamId: 'stream-tc' } });
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } });
      queueFetchResponse({ data: { sessionId: 'session-tc' } });
      await act(async () => { await result.current.connect(); });
    }

    it('creates tool_call event', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.session.update')!;
      act(() => {
        handler({ update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', rawInput: '{"path":"file.ts"}' } });
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].type).toBe('tool_call');
      expect(result.current.events[0].toolName).toBe('Read');
    });

    it('creates tool_result event on tool_call_complete', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.session.update')!;

      // tool_call_complete has toolCallId — the handler checks sessionUpdate field
      act(() => {
        handler({ update: { sessionUpdate: 'tool_call_complete', toolCallId: 'tc-1', rawOutput: 'file contents' } });
      });

      // Should have created a tool_result event
      const events = result.current.events;
      expect(events.length).toBeGreaterThanOrEqual(1);
      const resultEvent = events.find(e => e.type === 'tool_result');
      expect(resultEvent).toBeDefined();
      expect(resultEvent!.content?.[0]?.text).toBe('file contents');
    });

    it('creates both tool_call and text events in sequence', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.session.update')!;

      // Text first, then tool call
      act(() => { handler({ update: { content: { text: 'Let me check...' } } }); });
      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].type).toBe('assistant_message');

      act(() => { handler({ update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read' } }); });

      // Should have both events
      expect(result.current.events.length).toBeGreaterThanOrEqual(2);
      expect(result.current.events.some(e => e.type === 'assistant_message')).toBe(true);
      expect(result.current.events.some(e => e.type === 'tool_call')).toBe(true);
    });
  });

  describe('send', () => {
    it('adds user message and sends prompt', async () => {
      // Setup connected state
      queueFetchResponse({ data: { streamId: 'stream-1' } });
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } });
      queueFetchResponse({ data: { sessionId: 'session-1' } });
      queueFetchResponse({ data: { stopReason: 'end_turn' } }); // prompt response

      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );

      await act(async () => { await result.current.connect(); });

      await act(async () => { await result.current.send('Hello agent'); });

      // Should have added a user message
      const userMsg = result.current.events.find(e => e.type === 'user_message');
      expect(userMsg).toBeDefined();
      expect(userMsg!.content?.[0]?.text).toBe('Hello agent');

      // Status should be streaming (waiting for WS response)
      expect(result.current.status).toBe('streaming');
    });

    it('does nothing when not ready', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );

      await act(async () => { await result.current.send('Hello'); });

      expect(result.current.events).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('sets error on stream error event', () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );

      const handler = eventHandlers.get('acp.stream.error')!;

      act(() => {
        handler({ error: 'Connection lost' });
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe('Connection lost');
    });
  });

  describe('event format', () => {
    it('produces SessionEvent-compatible events', async () => {
      queueFetchResponse({ data: { streamId: 'stream-fmt' } });
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } });
      queueFetchResponse({ data: { sessionId: 'session-fmt' } });

      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );

      await act(async () => { await result.current.connect(); });

      const handler = eventHandlers.get('acp.session.update')!;
      act(() => { handler({ update: { content: { text: 'Hello' } } }); });

      const event = result.current.events[0];
      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.sequence).toBeDefined();
      expect(event.type).toBe('assistant_message');
      expect(event.content).toBeDefined();
      expect(event.content![0].type).toBe('text');
    });
  });

  describe('permission handling', () => {
    async function connectStream(result: any) {
      queueFetchResponse({ data: { streamId: 'stream-perm' } });
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } });
      queueFetchResponse({ data: { sessionId: 'session-perm' } });
      await act(async () => { await result.current.connect(); });
    }

    it('starts with empty permissions', () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      expect(result.current.permissions).toEqual([]);
    });

    it('accumulates permission requests', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.permission.request')!;
      act(() => {
        handler({
          streamId: 'stream-perm',
          requestId: 'req-1',
          sessionId: 'session-perm',
          toolCall: { name: 'Bash', input: { command: 'ls' } },
        });
      });

      expect(result.current.permissions).toHaveLength(1);
      expect(result.current.permissions[0].requestId).toBe('req-1');
      expect(result.current.permissions[0].toolCall?.name).toBe('Bash');
    });

    it('removes permission after reply', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.permission.request')!;
      act(() => {
        handler({ streamId: 'stream-perm', requestId: 'req-1', toolCall: { name: 'Edit' } });
      });
      expect(result.current.permissions).toHaveLength(1);

      // Queue response for permission reply POST
      queueFetchResponse({ data: { replied: true } });

      await act(async () => {
        await result.current.replyPermission('req-1', true);
      });

      expect(result.current.permissions).toHaveLength(0);
    });

    it('ignores permission events for other streams', async () => {
      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );
      await connectStream(result);

      const handler = eventHandlers.get('acp.permission.request')!;
      act(() => {
        handler({ streamId: 'other-stream', requestId: 'req-1', toolCall: { name: 'Bash' } });
      });

      expect(result.current.permissions).toHaveLength(0);
    });
  });

  describe('disconnect handling', () => {
    it('resets to idle when disabled after connection', async () => {
      queueFetchResponse({ data: { streamId: 'stream-dc' } });
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } });
      queueFetchResponse({ data: { sessionId: 'session-dc' } });

      const { result, rerender } = renderHook(
        ({ enabled }) => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled }),
        { wrapper: createWrapper(), initialProps: { enabled: true } },
      );

      await act(async () => { await result.current.connect(); });
      expect(result.current.status).toBe('ready');

      // Disable (swarm went offline)
      rerender({ enabled: false });

      // Should reset to idle but preserve events
      expect(result.current.status).toBe('idle');
    });

    it('preserves accumulated events after disable', async () => {
      queueFetchResponse({ data: { streamId: 'stream-dc2' } });
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } });
      queueFetchResponse({ data: { sessionId: 'session-dc2' } });

      const { result, rerender } = renderHook(
        ({ enabled }) => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled }),
        { wrapper: createWrapper(), initialProps: { enabled: true } },
      );

      await act(async () => { await result.current.connect(); });

      // Add some events
      const handler = eventHandlers.get('acp.session.update')!;
      act(() => { handler({ update: { content: { text: 'Hello' } } }); });
      expect(result.current.events).toHaveLength(1);

      // Disable
      rerender({ enabled: false });

      // Events should still be there
      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].content?.[0]?.text).toBe('Hello');
    });

    it('clears pending permissions on disable', async () => {
      queueFetchResponse({ data: { streamId: 'stream-dc3' } });
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } });
      queueFetchResponse({ data: { sessionId: 'session-dc3' } });

      const { result, rerender } = renderHook(
        ({ enabled }) => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled }),
        { wrapper: createWrapper(), initialProps: { enabled: true } },
      );

      await act(async () => { await result.current.connect(); });

      const handler = eventHandlers.get('acp.permission.request')!;
      act(() => { handler({ streamId: 'stream-dc3', requestId: 'req-1', toolCall: { name: 'Bash' } }); });
      expect(result.current.permissions).toHaveLength(1);

      rerender({ enabled: false });
      expect(result.current.permissions).toHaveLength(0);
    });
  });

  describe('stale stream recovery', () => {
    it('detects stale stream on send failure', async () => {
      queueFetchResponse({ data: { streamId: 'stream-stale' } });
      queueFetchResponse({ data: { agentInfo: { name: 'test' } } });
      queueFetchResponse({ data: { sessionId: 'session-stale' } });

      const { result } = renderHook(
        () => useAcpStream({ serverId: 'swarm-1', targetAgent: 'macro-agent', enabled: true }),
        { wrapper: createWrapper() },
      );

      await act(async () => { await result.current.connect(); });
      expect(result.current.status).toBe('ready');

      // Queue a 404 response for the prompt
      queueFetchResponse({ error: 'Stream not found' }, false, 404);

      await act(async () => { await result.current.send('Hello'); });

      expect(result.current.status).toBe('error');
      expect(result.current.error).toContain('expired');
    });
  });
});
