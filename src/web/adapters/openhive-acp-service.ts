/**
 * OpenHive AcpServiceLike — wraps SwarmCraft's /acp/streams REST API proxied
 * through OpenHive (`/api/swarmcraft/acp/streams/...`) and OpenHive's WS
 * bridge (acp.* events on the `global` channel).
 *
 * Implements the same contract as SwarmCraft's in-app ACP service so the
 * generic createAcpAdapter() works identically.
 *
 * Requires the consumer to have `useSubscribe(['global'])` active somewhere
 * in the React tree so ACP events reach the local useWSStore.
 */

import type {
  AcpServiceLike,
  AcpSubscriptionHandlers,
  ACPPermissionRequest,
  ACPQuestionRequest,
  ChatMessage,
} from 'swarmcraft/ui/embed';
import { useWSStore } from '../hooks/useWebSocket';

const API_BASE = '/api/swarmcraft';

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('openhive_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function acpFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send Content-Type when a body is actually present — Fastify rejects
  // empty POSTs that declare application/json (FST_ERR_CTP_EMPTY_JSON_BODY).
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      (err as { error?: string }).error
        ?? (err as { message?: string }).message
        ?? `Request failed: ${res.status}`,
    );
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json();
  return (body as { data?: T }).data ?? (body as T);
}

// ---------------------------------------------------------------------------
// Per-stream event subscription bookkeeping
// ---------------------------------------------------------------------------

interface StreamSubscription {
  /** Null between prepareSubscription() and subscribe() — events still
   *  accumulate into messageMap and buffered queues, then flush on subscribe. */
  handlers: AcpSubscriptionHandlers | null;
  /** Messages accumulated by id — ACP streams in as chunks */
  messageMap: Map<string, ChatMessage>;
  /** Currently-streaming assistant message id (for chunk accumulation) */
  currentAssistantId: string | null;
  /** Agent display name captured from createStream(). Applied to assistant
   *  + tool messages on notify so the chat bubbles render the agent's name
   *  + boring-avatar instead of a generic "agent" label. */
  agentName: string | null;
  /**
   * Time-windowed fingerprint dedup. MAP SDK can deliver the same update 2×
   * within a few ms; legitimate repeats (agent emitting "." twice in quick
   * succession) are rare but possible. We track each fingerprint's last-seen
   * timestamp and dedupe within DEDUP_WINDOW_MS. Older entries are purged.
   */
  recentFingerprints: Map<string, number>;
  eventSeq: number;
  /** Permission/question events buffered until handlers attach */
  pendingPermissions: ACPPermissionRequest[];
  pendingQuestions: ACPQuestionRequest[];
  pendingStatus: { status: import('swarmcraft/ui/embed').ChatStatus; detail?: string } | null;
  pendingError: Error | null;
}

/** Window for considering two identical updates as duplicates. */
const DEDUP_WINDOW_MS = 200;

const subscriptions = new Map<string, StreamSubscription>();
let wsListenersRegistered = false;

/**
 * Registered WS handlers — tracked on globalThis so they survive HMR module
 * reloads. Without this, each HMR cycle would add another listener set to the
 * persistent Zustand store and we'd invoke handlers N× after N reloads.
 */
type HandlerRecord = Array<[string, (data: unknown) => void]>;
const HMR_HANDLERS_KEY = '__openhive_acp_handlers__';
function getRegisteredHandlers(): HandlerRecord {
  const g = globalThis as unknown as Record<string, HandlerRecord>;
  if (!g[HMR_HANDLERS_KEY]) g[HMR_HANDLERS_KEY] = [];
  return g[HMR_HANDLERS_KEY];
}

function emptySubscription(): StreamSubscription {
  return {
    handlers: null,
    messageMap: new Map(),
    currentAssistantId: null,
    agentName: null,
    recentFingerprints: new Map(),
    eventSeq: 0,
    pendingPermissions: [],
    pendingQuestions: [],
    pendingStatus: null,
    pendingError: null,
  };
}

/**
 * Returns true if this fingerprint was seen within DEDUP_WINDOW_MS (i.e. it's
 * a duplicate that should be dropped). Records the fingerprint regardless and
 * prunes entries older than the window.
 */
function isDuplicate(sub: StreamSubscription, fingerprint: string): boolean {
  const now = Date.now();
  // Prune stale entries. Small Map (<20 entries typically), full scan is fine.
  for (const [fp, ts] of sub.recentFingerprints) {
    if (now - ts > DEDUP_WINDOW_MS) sub.recentFingerprints.delete(fp);
  }
  const prev = sub.recentFingerprints.get(fingerprint);
  sub.recentFingerprints.set(fingerprint, now);
  return prev !== undefined && (now - prev) <= DEDUP_WINDOW_MS;
}

/** Close out any in-progress assistant bubble so the next distinct event
 *  starts fresh. Safe to call when no bubble is in progress. */
function finalizeAssistantBubble(sub: StreamSubscription): void {
  if (!sub.currentAssistantId) return;
  const prev = sub.messageMap.get(sub.currentAssistantId);
  if (prev) {
    sub.messageMap.set(sub.currentAssistantId, { ...prev, isStreaming: false });
  }
  sub.currentAssistantId = null;
}

/**
 * Inject the agent's identity (name + boring-avatar palette) into every
 * non-user message before notifying the channel. Done at notify-time rather
 * than message-construction-time so that:
 *   - all message-creation sites stay clean (no copy-paste of identity wiring)
 *   - if the agent name resolves later, all historical bubbles re-paint with
 *     the right avatar on the next notify
 */
function decorateWithAgentIdentity(messages: ChatMessage[], agentName: string | null): ChatMessage[] {
  if (!agentName) return messages;
  return messages.map((m) => {
    if (m.role === 'user') return m;
    if (m.senderName && m.agentIdentity) return m; // already set
    return {
      ...m,
      senderName: m.senderName ?? agentName,
      agentIdentity: m.agentIdentity ?? { name: agentName },
    };
  });
}

function notifyMessages(sub: StreamSubscription) {
  sub.handlers?.onMessages(decorateWithAgentIdentity(Array.from(sub.messageMap.values()), sub.agentName));
}

function registerGlobalListeners() {
  if (wsListenersRegistered) return;
  wsListenersRegistered = true;

  const store = useWSStore.getState();

  // HMR safety: remove any handlers registered by a previous module instance
  // before registering the new set. The handler list lives on globalThis so
  // it survives HMR (the Zustand store also survives, so without cleanup we'd
  // double-register each reload).
  const registeredHandlers = getRegisteredHandlers();
  for (const [evt, h] of registeredHandlers) {
    try { store.removeListener(evt, h); } catch { /* best effort */ }
  }
  registeredHandlers.length = 0;
  const track = (evt: string, handler: (data: unknown) => void) => {
    store.addListener(evt, handler);
    registeredHandlers.push([evt, handler]);
  };

  const onSessionUpdate = (raw: unknown) => {
    const msg = raw as { data?: { streamId?: string; update?: unknown; payload?: { update?: unknown } } };
    const data = msg?.data ?? (raw as typeof msg.data);
    if (!data?.streamId) return;
    const sub = subscriptions.get(data.streamId);
    if (!sub) return;

    const update: Record<string, unknown> = (data.update
      ?? (data as { payload?: { update?: Record<string, unknown> } }).payload?.update
      ?? data) as Record<string, unknown>;
    if (!update) return;

    const fingerprint = JSON.stringify(update);
    if (isDuplicate(sub, fingerprint)) return;

    const sessionUpdate = (update.sessionUpdate ?? update.type) as string | undefined;
    const chunk = update.chunk as { text?: string } | undefined;
    const content = update.content as { text?: string } | undefined;
    const text = chunk?.text ?? content?.text ?? (update.text as string | undefined);

    // Tool call results
    if (sessionUpdate === 'tool_call_update' || sessionUpdate === 'tool_call_complete') {
      const toolCallId = update.toolCallId as string | undefined;
      if (!toolCallId) {
        // Malformed tool_call_update — still finalize any in-flight bubble
        // so a later legitimate agent_message_chunk starts a fresh one.
        finalizeAssistantBubble(sub);
        return;
      }
      finalizeAssistantBubble(sub);
      const id = `acp-tr-${toolCallId}-${sub.eventSeq++}`;
      const m: ChatMessage = {
        id,
        role: 'system',
        sender: 'tool',
        content: String(update.rawOutput ?? update.content ?? ''),
        contentType: 'event',
        rawContent: update,
        timestamp: Date.now(),
      };
      sub.messageMap.set(id, m);
      notifyMessages(sub);
      return;
    }

    // Tool call start
    if (sessionUpdate === 'tool_call' || update.toolCallId) {
      const toolCallId = (update.toolCallId as string | undefined) ?? `tc-${Date.now()}`;
      finalizeAssistantBubble(sub);
      const id = `acp-tc-${toolCallId}`;
      const m: ChatMessage = {
        id,
        role: 'assistant',
        sender: 'agent',
        content: `[${(update.title ?? update.toolName ?? 'tool') as string}]`,
        contentType: 'event',
        rawContent: update,
        timestamp: Date.now(),
      };
      sub.messageMap.set(id, m);
      notifyMessages(sub);
      return;
    }

    // User message replay (during session/load)
    if (text && sessionUpdate === 'user_message_chunk') {
      finalizeAssistantBubble(sub);
      const id = `acp-user-${Date.now()}-${sub.eventSeq++}`;
      sub.messageMap.set(id, {
        id, role: 'user', sender: 'user', senderName: 'You',
        content: text, contentType: 'text', timestamp: Date.now(),
      });
      notifyMessages(sub);
      return;
    }

    // Assistant streaming text
    //
    // Intentionally does NOT set status to 'streaming'. Chunks arrive
    // both from live streaming and from session/load replay, and there's
    // no reliable per-chunk marker to distinguish them. Inferring live
    // activity from chunk arrivals made every resumed session appear as
    // "Agent is responding..." forever whenever the replayed transcript
    // didn't end with an end_turn/stopReason event (truncation, crashed
    // mid-turn, SDK replay window). Instead, status is driven by user
    // intent: `prompt()` flips to 'streaming', `end_turn`/`stopReason`
    // flips back to 'ready'.
    if (text && (sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'content_chunk' || !sessionUpdate)) {
      if (!sub.currentAssistantId) {
        sub.currentAssistantId = `acp-a-${Date.now()}-${sub.eventSeq++}`;
        sub.messageMap.set(sub.currentAssistantId, {
          id: sub.currentAssistantId,
          role: 'assistant',
          sender: 'agent',
          content: text,
          contentType: 'text',
          timestamp: Date.now(),
          isStreaming: true,
        });
      } else {
        const existing = sub.messageMap.get(sub.currentAssistantId);
        if (existing) {
          sub.messageMap.set(sub.currentAssistantId, {
            ...existing,
            content: existing.content + text,
          });
        }
      }
      notifyMessages(sub);
    }

    // End of turn
    if (sessionUpdate === 'end_turn' || update.stopReason) {
      finalizeAssistantBubble(sub);
      notifyMessages(sub);
      if (sub.handlers) {
        sub.handlers.onStatus('ready');
      } else {
        sub.pendingStatus = { status: 'ready' };
      }
    }
  };

  const onPermissionRequest = (raw: unknown) => {
    const data = (raw as { data?: { streamId?: string; requestId?: string; toolCall?: unknown; description?: string } }).data ?? raw as Record<string, unknown>;
    const streamId = (data as { streamId?: string }).streamId;
    if (!streamId) return;
    const sub = subscriptions.get(streamId);
    if (!sub) return;
    const req: ACPPermissionRequest = {
      id: (data as { requestId?: string; id?: string }).requestId ?? (data as { id?: string }).id ?? `perm-${Date.now()}`,
      streamId,
      agentId: '',
      description: (data as { description?: string }).description ?? String(
        ((data as { toolCall?: { name?: string } }).toolCall?.name) ?? 'Tool approval',
      ),
      timestamp: Date.now(),
      status: 'pending',
    };
    if (sub.handlers) sub.handlers.onPermission(req);
    else sub.pendingPermissions.push(req);
  };

  const onQuestionRequest = (raw: unknown) => {
    const data = (raw as { data?: Record<string, unknown> }).data ?? raw as Record<string, unknown>;
    const streamId = (data as { streamId?: string }).streamId;
    if (!streamId) return;
    const sub = subscriptions.get(streamId);
    if (!sub) return;
    const req: ACPQuestionRequest = {
      id: (data as { requestId?: string; id?: string }).requestId ?? (data as { id?: string }).id ?? `q-${Date.now()}`,
      streamId,
      sessionId: (data as { sessionId?: string }).sessionId ?? '',
      questions: (data as { questions?: ACPQuestionRequest['questions'] }).questions ?? [],
      timestamp: Date.now(),
      status: 'pending',
    };
    if (sub.handlers) sub.handlers.onQuestion(req);
    else sub.pendingQuestions.push(req);
  };

  const onStreamError = (raw: unknown) => {
    const data = (raw as { data?: { streamId?: string; error?: string } }).data
      ?? raw as Record<string, unknown>;
    const streamId = (data as { streamId?: string }).streamId;
    if (!streamId) return;
    const sub = subscriptions.get(streamId);
    if (!sub) return;
    const err = new Error(String((data as { error?: string }).error ?? 'ACP stream error'));
    if (sub.handlers) sub.handlers.onError(err);
    else sub.pendingError = err;
  };

  track('acp.session.update', onSessionUpdate);
  track('acp.permission.request', onPermissionRequest);
  track('acp.question.request', onQuestionRequest);
  track('acp.stream.error', onStreamError);
  track('acp.prompt.completed', (raw) => {
    const data = (raw as { data?: { streamId?: string } }).data ?? raw as Record<string, unknown>;
    const streamId = (data as { streamId?: string }).streamId;
    if (!streamId) return;
    const sub = subscriptions.get(streamId);
    if (!sub) return;
    finalizeAssistantBubble(sub);
    notifyMessages(sub);
    if (sub.handlers) sub.handlers.onStatus('ready');
    else sub.pendingStatus = { status: 'ready' };
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Register the module-level WS listeners. Must be invoked from a useEffect
 * (not during render) — it mutates useWSStore, which otherwise triggers
 * setState-during-render warnings for any store subscriber higher in the tree.
 * Safe to call repeatedly; guarded by wsListenersRegistered.
 */
export function ensureAcpListenersRegistered() {
  registerGlobalListeners();
}

/**
 * Update the agent display name for a stream after the fact. Used by the
 * chat panel on resumed sessions where `createStream()` wasn't called this
 * page-load, so the name has to be backfilled from the MAP registry.
 * No-op when the name hasn't actually changed.
 */
export function setAcpStreamAgentName(streamId: string, name: string | null): void {
  const sub = subscriptions.get(streamId) ?? emptySubscription();
  if (sub.agentName === name) return;
  sub.agentName = name;
  subscriptions.set(streamId, sub);
  notifyMessages(sub);
}

export function createOpenHiveAcpServiceLike(): AcpServiceLike {
  return {
    createStream: async (serverId, targetAgent, agentName) => {
      const res = await acpFetch<{ streamId: string }>('/acp/streams', {
        method: 'POST',
        body: JSON.stringify({ serverId, targetAgent, agentName }),
      });
      // Stash the display name on (or pre-create) the per-stream subscription
      // so chat bubbles can render the agent's avatar + name. Done unconditionally
      // — even when the subscription was already created by prepareSubscription.
      const sub = subscriptions.get(res.streamId) ?? emptySubscription();
      sub.agentName = agentName ?? targetAgent ?? null;
      subscriptions.set(res.streamId, sub);
      // Re-notify so any messages already in the map (e.g. from a prior
      // session/load replay) re-render with the freshly-set identity.
      notifyMessages(sub);
      return res.streamId;
    },

    initialize: async (streamId) => {
      await acpFetch(`/acp/streams/${streamId}/initialize`, { method: 'POST' });
    },

    newSession: async (streamId, cwd) => {
      await acpFetch(`/acp/streams/${streamId}/session`, {
        method: 'POST',
        body: JSON.stringify({ cwd: cwd ?? '.', mcpServers: [] }),
      });
    },

    loadSession: async (streamId, sessionId, cwd, meta) => {
      await acpFetch(`/acp/streams/${streamId}/session/load`, {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          cwd: cwd ?? '.',
          mcpServers: [],
          ...(meta ? { _meta: meta } : {}),
        }),
      });
      // Baseline reset after load. The RPC returns once the server has
      // the session loaded; historical `session/update` replays then
      // arrive asynchronously via WS and rebuild the message list. We
      // don't let those replays drive status (see chunk handler), so the
      // default state for a newly-loaded session is 'ready'. Any in-
      // progress assistant bubble from a previous live turn gets
      // finalized here so a subsequent live chunk starts a fresh one.
      const sub = subscriptions.get(streamId);
      if (sub) {
        finalizeAssistantBubble(sub);
        if (sub.handlers) {
          sub.handlers.onStatus('ready');
        } else {
          sub.pendingStatus = { status: 'ready' };
        }
      }
    },

    prompt: async (streamId, text) => {
      // Optimistically flip to 'streaming' before the POST so the UI
      // reflects "agent is responding…" the instant the user sends,
      // rather than waiting for the first WS chunk. Status transitions
      // back to 'ready' when `end_turn` or `stopReason` arrives.
      const sub = subscriptions.get(streamId);
      if (sub) {
        if (sub.handlers) {
          sub.handlers.onStatus('streaming');
        } else {
          sub.pendingStatus = { status: 'streaming' };
        }
      }
      // SwarmCraft's /prompt endpoint accepts either { message } (simple) or
      // { prompt: [...] } (full ACP). It does NOT accept { text } — that would
      // silently normalize to an empty prompt.
      await acpFetch(`/acp/streams/${streamId}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });
    },

    cancel: async (streamId) => {
      await acpFetch(`/acp/streams/${streamId}/cancel`, { method: 'POST' });
    },

    replyPermission: async (streamId, requestId, granted) => {
      await acpFetch(`/acp/streams/${streamId}/permission`, {
        method: 'POST',
        body: JSON.stringify({
          requestId,
          reply: { outcome: granted ? 'approved' : 'denied' },
        }),
      });
    },

    replyQuestion: async (streamId, requestId, answers) => {
      await acpFetch(`/acp/streams/${streamId}/question`, {
        method: 'POST',
        body: JSON.stringify({ requestId, answers }),
      });
    },

    prepareSubscription: (streamId) => {
      if (!subscriptions.has(streamId)) {
        subscriptions.set(streamId, emptySubscription());
      }
    },

    releaseSubscription: (streamId) => {
      const sub = subscriptions.get(streamId);
      // Only release if subscribe() never attached handlers. Active
      // subscriptions are torn down via the unsubscribe fn returned from
      // subscribe(), which also deletes from the Map.
      if (sub && !sub.handlers) {
        subscriptions.delete(streamId);
      }
    },

    subscribe: (streamId, handlers) => {
      let sub = subscriptions.get(streamId);
      if (!sub) {
        sub = emptySubscription();
        subscriptions.set(streamId, sub);
      }
      sub.handlers = handlers;

      // Flush anything buffered between prepareSubscription and subscribe.
      if (sub.messageMap.size > 0) {
        handlers.onMessages(Array.from(sub.messageMap.values()));
      }
      if (sub.pendingStatus) {
        handlers.onStatus(sub.pendingStatus.status, sub.pendingStatus.detail);
        sub.pendingStatus = null;
      }
      for (const p of sub.pendingPermissions) handlers.onPermission(p);
      sub.pendingPermissions = [];
      for (const q of sub.pendingQuestions) handlers.onQuestion(q);
      sub.pendingQuestions = [];
      if (sub.pendingError) {
        handlers.onError(sub.pendingError);
        sub.pendingError = null;
      }

      return () => {
        subscriptions.delete(streamId);
      };
    },
  };
}
