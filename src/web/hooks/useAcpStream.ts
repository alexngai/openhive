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
  /** Attach to an existing ACP stream (created by create-acp endpoint). Skips create/initialize/session. */
  existingStreamId?: string | null;
  /** ACP session ID for the existing stream. Required when existingStreamId is set. */
  existingSessionId?: string | null;
  /**
   * Underlying Claude Code session UUID. Passed to ACP loadSession via _meta
   * so the agent can replay history from its on-disk transcript even after
   * a process restart (when its in-memory session mapping is gone).
   */
  providerSessionId?: string | null;
}

export interface AcpPermissionRequest {
  requestId: string;
  streamId: string;
  sessionId?: string;
  toolCall?: { name: string; input?: unknown };
}

export interface UseAcpStreamReturn {
  status: AcpStreamState['status'];
  error: string | null;
  /** Streaming events in SessionEvent format — ready for EventStream rendering */
  events: SessionEvent[];
  /** Pending permission requests from the agent */
  permissions: AcpPermissionRequest[];
  send: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  connect: () => Promise<void>;
  /** Reply to a permission request (grant or deny tool execution) */
  replyPermission: (requestId: string, granted: boolean) => Promise<void>;
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
  existingStreamId,
  existingSessionId,
  providerSessionId,
}: UseAcpStreamOptions): UseAcpStreamReturn {
  const [state, setState] = useState<AcpStreamState>({
    streamId: null,
    sessionId: null,
    initialized: false,
    status: 'idle',
    error: null,
  });

  // Attach to an existing stream (created by create-acp endpoint) on mount.
  // This avoids creating a duplicate stream/subscription on the same MAP connection.
  // Also call session/load so the agent replays prior session/update notifications —
  // the acp.session.update WebSocket handler below accumulates them into state
  // exactly as if they were live events, reconstructing the conversation.
  const attachedRef = useRef(false);
  useEffect(() => {
    if (existingStreamId && existingSessionId && !attachedRef.current) {
      attachedRef.current = true;
      streamIdRef.current = existingStreamId;
      setState({
        streamId: existingStreamId,
        sessionId: existingSessionId,
        initialized: true,
        status: 'ready',
        error: null,
      });

      // Ask the agent to replay the session's history via session/update notifications.
      // The existing WebSocket handler will accumulate them into `events` state.
      // Passes provider_session_id via _meta so the agent can recover history
      // from its on-disk JSONL even if its in-memory session mapping is gone
      // (e.g., after a process restart).
      (async () => {
        try {
          await scFetch(`/acp/streams/${existingStreamId}/session/load`, {
            method: 'POST',
            body: JSON.stringify({
              sessionId: existingSessionId,
              cwd: cwd ?? '.',
              mcpServers: [],
              ...(providerSessionId
                ? { _meta: { provider_session_id: providerSessionId } }
                : {}),
            }),
          });
        } catch (err) {
          const msg = (err as Error).message || '';
          // If the underlying MAP connection is dead (agent restarted, stream
          // aborted), the URL's streamId/sessionId are stale. Reset attachment
          // so the auto-connect path creates a fresh stream+session. History
          // from the prior session can't be recovered — it lived in the dead
          // agent process — but the chat becomes usable again.
          const lower = msg.toLowerCase();
          const isDead =
            lower.includes('connection closed') ||
            lower.includes('session not found') ||
            lower.includes('not found') ||  // generic fallback: "ACP stream X not found" etc.
            lower.includes('expired') ||
            (lower.includes('stream') && lower.includes('closed'));
          if (isDead) {
            attachedRef.current = false;
            streamIdRef.current = null;
            setState({
              streamId: null,
              sessionId: null,
              initialized: false,
              status: 'idle',
              error: null,
            });
            // Strip the dead streamId/sessionId from the URL so a reload
            // doesn't re-attach to the same stale references. We replace (not
            // push) so the back button isn't polluted. Auto-connect will
            // create a fresh stream via the normal flow.
            try {
              if (typeof window !== 'undefined' && window.history?.replaceState) {
                const url = new URL(window.location.href);
                let changed = false;
                if (url.searchParams.has('streamId')) {
                  url.searchParams.delete('streamId');
                  changed = true;
                }
                if (url.searchParams.has('sessionId')) {
                  url.searchParams.delete('sessionId');
                  changed = true;
                }
                if (changed) {
                  window.history.replaceState({}, '', url.toString());
                }
              }
            } catch { /* best-effort URL cleanup */ }
          }
          // Otherwise non-fatal — agent may not support loadSession, or history
          // may be empty. The user can still interact with the live stream.
        }
      })();
    }
  }, [existingStreamId, existingSessionId, cwd]);

  // Events in SessionEvent format — compatible with EventStream/EventBubble
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [permissions, setPermissions] = useState<AcpPermissionRequest[]>([]);
  const currentAssistantIdRef = useRef<string | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const eventSeqRef = useRef(0);
  // Dedup: MAP SDK can deliver duplicate session updates. Track last seen
  // update fingerprint to skip exact duplicates.
  const lastUpdateFingerprintRef = useRef<string | null>(null);

  // Subscribe to OpenHive's global channel where ACP events are bridged
  useSubscribe(state.streamId ? ['global'] : []);

  // Handle streaming session updates (text chunks + tool calls)
  // useWSEvent passes the full WSEvent ({type, data, channel, timestamp}),
  // so unwrap .data first to get the ACP payload.
  useWSEvent('acp.session.update', useCallback((msg: any) => {
    if (!streamIdRef.current) return;
    const data = msg?.data ?? msg;
    if (data?.streamId && data.streamId !== streamIdRef.current) return;

    const update = data?.update ?? data?.payload?.update ?? data;
    if (!update) return;

    // Deduplicate: MAP SDK may deliver each session update twice.
    // Fingerprint by JSON-serializing the update and skip exact duplicates.
    const fingerprint = JSON.stringify(update);
    if (fingerprint === lastUpdateFingerprintRef.current) {
      lastUpdateFingerprintRef.current = null; // Reset so triple+ duplicates still work
      return;
    }
    lastUpdateFingerprintRef.current = fingerprint;

    // Extract content from various update shapes.
    // ACP content_chunk updates: { type: 'content_chunk', chunk: { type: 'text', text: '...' } }
    // Fallbacks for other shapes: update.content.text, update.text
    const contentText = update?.chunk?.text ?? update?.content?.text ?? update?.text;
    const sessionUpdate = update?.sessionUpdate ?? update?.type;

    // Tool call result events (must check before the generic toolCallId check below)
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

    // Tool call start events
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

    // User message text — emitted during session/load replay to reconstruct
    // historical user prompts (live prompts are handled by the UI directly,
    // not via session/update). Each user_message_chunk becomes its own bubble.
    if (contentText && sessionUpdate === 'user_message_chunk') {
      // Finalize any current streaming assistant message before the user bubble
      if (currentAssistantIdRef.current) {
        setEvents(prev => prev.map(e =>
          e.id === currentAssistantIdRef.current
            ? { ...e, _isStreaming: undefined } as any
            : e
        ));
        currentAssistantIdRef.current = null;
      }
      const seq = eventSeqRef.current++;
      setEvents(prev => [...prev, {
        id: `acp-user-${Date.now()}-${seq}`,
        timestamp: new Date().toISOString(),
        sequence: seq,
        type: 'user_message' as const,
        content: [{ type: 'text' as const, text: contentText }],
      } as SessionEvent]);
      return;
    }

    // Agent/assistant text content — accumulate into current streaming bubble.
    // Chunks without an explicit sessionUpdate type (e.g., generic content_chunk)
    // also fall here for backwards compat.
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
  useWSEvent('acp.prompt.completed', useCallback((msg: any) => {
    const data = msg?.data ?? msg;
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
  useWSEvent('acp.stream.error', useCallback((msg: any) => {
    const data = msg?.data ?? msg;
    if (data?.streamId && data.streamId !== streamIdRef.current) return;
    setState(prev => ({ ...prev, status: 'error', error: data?.error ?? 'Stream error' }));
  }, []));

  // Handle permission requests from agent (tool approval)
  useWSEvent('acp.permission.request', useCallback((msg: any) => {
    const data = msg?.data ?? msg;
    if (!streamIdRef.current) return;
    if (data?.streamId && data.streamId !== streamIdRef.current) return;

    const request: AcpPermissionRequest = {
      requestId: data?.requestId ?? `perm-${Date.now()}`,
      streamId: data?.streamId ?? streamIdRef.current!,
      sessionId: data?.sessionId,
      toolCall: data?.toolCall,
    };
    setPermissions(prev => [...prev, request]);
  }, []));

  // Reply to a permission request
  const replyPermission = useCallback(async (requestId: string, granted: boolean) => {
    if (!state.streamId) return;
    try {
      await scFetch(`/acp/streams/${state.streamId}/permission`, {
        method: 'POST',
        body: JSON.stringify({
          requestId,
          reply: { outcome: granted ? 'approved' : 'denied' },
        }),
      });
    } catch { /* best effort */ }
    // Remove from pending list
    setPermissions(prev => prev.filter(p => p.requestId !== requestId));
  }, [state.streamId]);

  // Connect: create stream → initialize → create session
  const connect = useCallback(async () => {
    if (!serverId || !enabled || !targetAgent) return;
    // Don't create a new stream if we have an existing one (attach effect handles it)
    if (existingStreamId) return;

    setState(prev => ({ ...prev, status: 'connecting', error: null }));

    try {
      const resolvedTarget = targetAgent;

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
        { method: 'POST', body: '{}' },
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
  }, [serverId, targetAgent, cwd, enabled, existingStreamId]);

  // Send a prompt
  const send = useCallback(async (text: string) => {
    if (!state.streamId || !state.sessionId || state.status !== 'ready') return;

    // Finalize any currently streaming assistant bubble before appending the
    // new user message. Prevents the next prompt's agent chunks from
    // concatenating into the prior assistant bubble if prompt.completed
    // didn't fire cleanly (e.g. during attached-stream edge cases).
    if (currentAssistantIdRef.current) {
      setEvents(prev => prev.map(e =>
        e.id === currentAssistantIdRef.current
          ? { ...e, _isStreaming: undefined } as any
          : e
      ));
      currentAssistantIdRef.current = null;
    }

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
      const msg = (err as Error).message;
      // Detect stale stream (server restarted, stream expired)
      const isStale = msg.includes('not found') || msg.includes('404') || msg.includes('expired');
      setState(prev => ({
        ...prev,
        status: 'error',
        error: isStale ? 'ACP stream expired — reconnect or use mail fallback' : msg,
        ...(isStale ? { streamId: null, sessionId: null, initialized: false } : {}),
      }));
      if (isStale) streamIdRef.current = null;
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

  // Reset ACP stream when disabled (e.g., swarm goes offline mid-chat).
  // Preserves accumulated events so they remain visible in the UI.
  // Skip reset when we have an existing stream — `enabled` starts false before
  // async swarm data loads, but we don't want to destroy the pre-created stream.
  useEffect(() => {
    if (!enabled && state.streamId && !existingStreamId) {
      // Best-effort cancel the server-side stream
      fetch(`${SC_PREFIX}/acp/streams/${state.streamId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {});
      setState(prev => ({ ...prev, status: 'idle', streamId: null, sessionId: null, initialized: false }));
      streamIdRef.current = null;
      currentAssistantIdRef.current = null;
      setPermissions([]);
    }
  }, [enabled, state.streamId, existingStreamId]);

  // Streams persist across navigations — server-side cleanup handles stale
  // streams (create-acp closes old streams before creating new ones).

  return { status: state.status, error: state.error, events, permissions, send, cancel, connect, replyPermission };
}
