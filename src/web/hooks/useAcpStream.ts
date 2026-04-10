/**
 * useAcpStream — Manages an ACP streaming session via SwarmCraft's REST API.
 *
 * Handles the full ACP lifecycle:
 *   1. Create stream → initialize → create session
 *   2. Send prompts → receive streaming responses via WebSocket
 *   3. Accumulate text chunks and tool calls into SessionEvent-compatible messages
 *
 * ACP events are bridged from SwarmCraft's WS (/ws/swarmcraft) to OpenHive's
 * WS (/ws) via the broadcast interceptor in server.ts.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useSubscribe, useWSEvent } from './useWebSocket';
import type { SessionEvent, SessionContentBlock } from '../lib/api';

const SC_PREFIX = '/api/swarmcraft';

interface AcpStreamState {
  streamId: string | null;
  sessionId: string | null;
  initialized: boolean;
  status: 'idle' | 'connecting' | 'ready' | 'streaming' | 'error';
  error: string | null;
}

export interface UseAcpStreamOptions {
  /** SwarmCraft MAP server ID (swarmId used by MAPClientManager) */
  serverId: string | null;
  /** Target agent ID on the swarm's MAP server (from capabilities or agent list) */
  targetAgent?: string;
  /** Working directory for the ACP session (from session/swarm metadata) */
  cwd?: string;
  enabled?: boolean;
}

export interface UseAcpStreamReturn {
  status: AcpStreamState['status'];
  error: string | null;
  /** Streaming events in SessionEvent format — ready for EventStream rendering */
  events: SessionEvent[];
  send: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  connect: () => Promise<void>;
}

async function scFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('openhive_token');
  const res = await fetch(`${SC_PREFIX}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || err.message || `Request failed: ${res.status}`);
  }
  const body = await res.json();
  return body.data ?? body;
}

export function useAcpStream({
  serverId,
  targetAgent,
  cwd,
  enabled = true,
}: UseAcpStreamOptions): UseAcpStreamReturn {
  const [state, setState] = useState<AcpStreamState>({
    streamId: null,
    sessionId: null,
    initialized: false,
    status: 'idle',
    error: null,
  });

  // Events in SessionEvent format — compatible with EventStream/EventBubble
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const currentAssistantIdRef = useRef<string | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const eventSeqRef = useRef(0);

  // Subscribe to OpenHive's global channel where ACP events are bridged
  useSubscribe(state.streamId ? ['global'] : []);

  // Handle streaming session updates (text chunks + tool calls)
  useWSEvent('acp.session.update', useCallback((data: any) => {
    if (!streamIdRef.current) return;
    if (data?.streamId && data.streamId !== streamIdRef.current) return;

    const update = data?.update ?? data?.payload?.update ?? data;
    if (!update) return;

    // Extract content from various update shapes
    const contentText = update?.content?.text ?? update?.text;
    const sessionUpdate = update?.sessionUpdate;

    // Tool call events
    if (sessionUpdate === 'tool_call' || update?.toolCallId) {
      const toolCallId = update.toolCallId ?? `tc-${Date.now()}`;
      const seq = eventSeqRef.current++;

      // Finalize current streaming assistant message
      if (currentAssistantIdRef.current) {
        setEvents(prev => prev.map(e =>
          e.id === currentAssistantIdRef.current
            ? { ...e, _isStreaming: undefined } as any
            : e
        ));
        currentAssistantIdRef.current = null;
      }

      setEvents(prev => [...prev, {
        id: `acp-tc-${toolCallId}`,
        timestamp: new Date().toISOString(),
        sequence: seq,
        type: 'tool_call' as const,
        toolCallId,
        toolName: update.title ?? update.toolName ?? 'tool',
        input: update.rawInput ? JSON.parse(update.rawInput) : undefined,
      } as SessionEvent]);
      return;
    }

    // Tool call update/complete (result)
    if (sessionUpdate === 'tool_call_update' || sessionUpdate === 'tool_call_complete') {
      const toolCallId = update.toolCallId;
      if (!toolCallId) return;
      const seq = eventSeqRef.current++;

      setEvents(prev => [...prev, {
        id: `acp-tr-${toolCallId}-${seq}`,
        timestamp: new Date().toISOString(),
        sequence: seq,
        type: 'tool_result' as const,
        content: [{ type: 'text' as const, text: update.rawOutput ?? update.content ?? '' }],
        isError: update.status === 'error',
      } as SessionEvent]);
      return;
    }

    // Text content — accumulate into current assistant message
    if (contentText) {
      setEvents(prev => {
        const currentId = currentAssistantIdRef.current;
        const existing = currentId ? prev.find(e => e.id === currentId) : null;

        if (existing && (existing as any)._isStreaming) {
          // Append text to current streaming message
          const existingText = existing.content?.[0]?.text ?? '';
          return prev.map(e =>
            e.id === currentId
              ? {
                  ...e,
                  content: [{ type: 'text' as const, text: existingText + contentText }],
                }
              : e
          );
        } else {
          // Start new streaming assistant message
          const id = `acp-msg-${Date.now()}-${eventSeqRef.current}`;
          const seq = eventSeqRef.current++;
          currentAssistantIdRef.current = id;
          return [...prev, {
            id,
            timestamp: new Date().toISOString(),
            sequence: seq,
            type: 'assistant_message' as const,
            content: [{ type: 'text' as const, text: contentText }],
            _isStreaming: true,
          } as SessionEvent & { _isStreaming: boolean }];
        }
      });
    }
  }, []));

  // Handle stream completion
  useWSEvent('acp.prompt.completed', useCallback((data: any) => {
    if (data?.streamId && data.streamId !== streamIdRef.current) return;

    // Finalize current streaming message
    if (currentAssistantIdRef.current) {
      setEvents(prev => prev.map(e =>
        e.id === currentAssistantIdRef.current
          ? { ...e, _isStreaming: undefined } as any
          : e
      ));
      currentAssistantIdRef.current = null;
    }

    setState(prev => ({ ...prev, status: 'ready' }));
  }, []));

  // Handle errors
  useWSEvent('acp.stream.error', useCallback((data: any) => {
    if (data?.streamId && data.streamId !== streamIdRef.current) return;
    setState(prev => ({ ...prev, status: 'error', error: data?.error ?? 'Stream error' }));
  }, []));

  // Connect: create stream → initialize → create session
  const connect = useCallback(async () => {
    if (!serverId || !enabled) return;

    setState(prev => ({ ...prev, status: 'connecting', error: null }));

    try {
      // Resolve target agent if not provided
      let resolvedTarget = targetAgent;
      if (!resolvedTarget) {
        // List agents from the swarm to find a valid target
        try {
          const agents = await scFetch<any[]>(`/agents?mapServerId=${serverId}`);
          const sidecar = agents?.find((a: any) => a.role === 'sidecar' || a.type === 'swarm');
          resolvedTarget = sidecar?.id ?? agents?.[0]?.id;
        } catch {
          // Fall back to serverId
          resolvedTarget = serverId;
        }
      }

      // Step 1: Create ACP stream
      const stream = await scFetch<{ streamId: string }>('/acp/streams', {
        method: 'POST',
        body: JSON.stringify({
          serverId,
          targetAgent: resolvedTarget ?? serverId,
        }),
      });
      streamIdRef.current = stream.streamId;

      // Step 2: Initialize
      await scFetch<any>(
        `/acp/streams/${stream.streamId}/initialize`,
        { method: 'POST' },
      );

      // Step 3: Create session
      const session = await scFetch<{ sessionId: string }>(
        `/acp/streams/${stream.streamId}/session`,
        {
          method: 'POST',
          body: JSON.stringify({
            cwd: cwd ?? '.',
            mcpServers: [],
          }),
        },
      );

      setState({
        streamId: stream.streamId,
        sessionId: session.sessionId,
        initialized: true,
        status: 'ready',
        error: null,
      });
    } catch (err) {
      setState(prev => ({
        ...prev,
        status: 'error',
        error: (err as Error).message,
      }));
    }
  }, [serverId, targetAgent, cwd, enabled]);

  // Send a prompt
  const send = useCallback(async (text: string) => {
    if (!state.streamId || !state.sessionId || state.status !== 'ready') return;

    // Add user message as SessionEvent
    const seq = eventSeqRef.current++;
    setEvents(prev => [...prev, {
      id: `acp-user-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sequence: seq,
      type: 'user_message' as const,
      content: [{ type: 'text' as const, text }],
    } as SessionEvent]);

    setState(prev => ({ ...prev, status: 'streaming' }));

    try {
      await scFetch(`/acp/streams/${state.streamId}/prompt`, {
        method: 'POST',
        body: JSON.stringify({
          sessionId: state.sessionId,
          prompt: [{ type: 'text', text }],
        }),
      });
      // Response arrives via WebSocket events
    } catch (err) {
      setState(prev => ({ ...prev, status: 'error', error: (err as Error).message }));
    }
  }, [state.streamId, state.sessionId, state.status]);

  // Cancel
  const cancel = useCallback(async () => {
    if (!state.streamId) return;
    try {
      await scFetch(`/acp/streams/${state.streamId}/cancel`, { method: 'POST' });
    } catch { /* best effort */ }
    setState(prev => ({ ...prev, status: 'ready' }));
  }, [state.streamId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamIdRef.current) {
        fetch(`${SC_PREFIX}/acp/streams/${streamIdRef.current}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {});
      }
    };
  }, []);

  return { status: state.status, error: state.error, events, send, cancel, connect };
}
