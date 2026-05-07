/**
 * useHostedChatChannel — chat channel hook for any programmatic-mode
 * (`mode: 'rpc'`) hosted swarm. Provider-agnostic: subscribes to the
 * normalized `hosted-chat.event` stream and renders any provider's
 * streaming output through the same UI primitives.
 *
 * Returns a `ChatChannel`-shaped object that swarmcraft's `ChatMessageList`
 * + `ChatInput` consume directly. The provider-specific protocol details
 * (codex's JSON-RPC method names, future alternatives) are translated to
 * a stable event shape (`HostedChatEvent`) inside the manager bridge —
 * see `src/swarm/hosted-chat-events.ts`. This hook only knows about the
 * normalized shape.
 *
 * Send path: POST `/map/hosted/:id/chat/turn` with `{ text }`. The route
 * dispatches to the right provider based on the row's kind+mode.
 *
 * Receive path: subscribe to `hosted-chat:<hostedSwarmId>` on openhive's
 * `/ws`. The bridge fans normalized events of type `'hosted-chat.event'`
 * with payload `{ hosted_swarm_id, provider, event: HostedChatEvent }`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatChannel,
  ChatMessage,
  ChatStatus,
} from 'swarmcraft/ui/embed';
import { api } from '../lib/api';
import { useSubscribe, useWSEvent } from './useWebSocket';

interface UseHostedChatChannelOptions {
  hostedSwarmId: string;
  /** When false, the hook no-ops (skip subscribe + send). */
  enabled?: boolean;
}

/** Mirror of `HostedChatEvent` in `src/swarm/hosted-chat-events.ts`. */
type HostedChatEvent =
  | { kind: 'message.start'; itemId: string; role: 'assistant' | 'user' | 'system' }
  | { kind: 'message.delta'; itemId: string; delta: string }
  | { kind: 'message.complete'; itemId: string; finalText?: string }
  | { kind: 'turn.started'; turnId: string }
  | { kind: 'turn.completed'; turnId: string }
  | { kind: 'error'; message: string; code?: string | number }
  | { kind: 'raw'; provider: string; method: string; params?: unknown };

interface HostedChatWSEvent {
  type: 'hosted-chat.event';
  channel?: string;
  data: {
    hosted_swarm_id: string;
    provider: string;
    event: HostedChatEvent;
  };
}

export function useHostedChatChannel(opts: UseHostedChatChannelOptions): ChatChannel {
  const { hostedSwarmId, enabled = true } = opts;

  const channelName = useMemo(() => `hosted-chat:${hostedSwarmId}`, [hostedSwarmId]);
  const channels = useMemo(() => (enabled ? [channelName] : []), [enabled, channelName]);
  useSubscribe(channels);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | undefined>(undefined);

  // itemId → message id, so streaming deltas know which message to patch.
  const itemToMessageId = useRef<Map<string, string>>(new Map());
  // itemIds we've explicitly chosen to suppress (e.g. provider-emitted
  // user-message echoes — we echo locally on send()). Subsequent deltas
  // and completes for these ids are dropped, not auto-promoted into a
  // fresh assistant bubble.
  const suppressedItems = useRef<Set<string>>(new Set());

  const ensureMessage = useCallback(
    (itemId: string, role: 'assistant' | 'user' | 'system', initialText: string): string => {
      const existing = itemToMessageId.current.get(itemId);
      if (existing) return existing;
      const id = `hosted-${itemId}`;
      itemToMessageId.current.set(itemId, id);
      const senderForRole: ChatMessage['sender'] = role === 'user' ? 'user' : 'agent';
      setMessages((prev) => [
        ...prev,
        {
          id,
          role,
          sender: senderForRole,
          content: initialText,
          contentType: 'text',
          timestamp: new Date().toISOString(),
          isStreaming: role !== 'user',
        },
      ]);
      return id;
    },
    [],
  );

  const appendDelta = useCallback(
    (itemId: string, delta: string) => {
      const msgId = itemToMessageId.current.get(itemId)
        ?? ensureMessage(itemId, 'assistant', '');
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, content: (m.content ?? '') + delta } : m)),
      );
    },
    [ensureMessage],
  );

  const finalizeItem = useCallback((itemId: string, finalText?: string) => {
    const msgId = itemToMessageId.current.get(itemId);
    if (!msgId) return;
    itemToMessageId.current.delete(itemId);
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== msgId) return m;
        return {
          ...m,
          content: finalText && finalText.length > 0 ? finalText : m.content,
          isStreaming: false,
        };
      }),
    );
  }, []);

  useWSEvent<HostedChatWSEvent>('hosted-chat.event', (event) => {
    if (!enabled) return;
    if (event.data?.hosted_swarm_id !== hostedSwarmId) return;
    const ev = event.data.event;
    switch (ev.kind) {
      case 'turn.started':
        setStatus('streaming');
        setStatusDetail(undefined);
        break;
      case 'turn.completed':
        // Sweep any items that didn't get a clean message.complete (rare —
        // the translator usually fires it, but defensive).
        for (const itemId of Array.from(itemToMessageId.current.keys())) {
          finalizeItem(itemId);
        }
        setStatus('connected');
        break;
      case 'message.start':
        // User messages are echoed locally on send() — suppress provider
        // echoes to avoid duplicates. Track the itemId so any subsequent
        // delta/complete on it is dropped (otherwise the delta path
        // would auto-create a fresh assistant bubble).
        if (ev.role === 'user') {
          suppressedItems.current.add(ev.itemId);
          break;
        }
        ensureMessage(ev.itemId, ev.role, '');
        break;
      case 'message.delta':
        if (suppressedItems.current.has(ev.itemId)) break;
        appendDelta(ev.itemId, ev.delta);
        break;
      case 'message.complete':
        if (suppressedItems.current.has(ev.itemId)) {
          suppressedItems.current.delete(ev.itemId);
          break;
        }
        finalizeItem(ev.itemId, ev.finalText);
        break;
      case 'error':
        setStatus('error');
        setStatusDetail(ev.message);
        break;
      case 'raw':
        // Provider-specific events the translator didn't normalize. Drop
        // silently here; debug surfaces can subscribe separately.
        break;
    }
  });

  useEffect(() => {
    if (!enabled) {
      setStatus('disconnected');
      setStatusDetail(undefined);
    } else if (status === 'disconnected') {
      setStatus('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const send = useCallback(
    async (text: string): Promise<void> => {
      if (!enabled) throw new Error('hosted-chat channel is disabled');
      const trimmed = text.trim();
      if (!trimmed) return;

      // Optimistic user echo. ID prefix avoids any collision with the
      // provider-side itemId space.
      const userMsgId = `local-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setMessages((prev) => [
        ...prev,
        {
          id: userMsgId,
          role: 'user',
          sender: 'user',
          content: trimmed,
          contentType: 'text',
          timestamp: new Date().toISOString(),
        },
      ]);

      try {
        await api.post<{ turn_id: string }>(
          `/map/hosted/${hostedSwarmId}/chat/turn`,
          { text: trimmed },
        );
        setStatusDetail(undefined);
      } catch (err) {
        const msg = (err as Error).message ?? 'send failed';
        setMessages((prev) => prev.filter((m) => m.id !== userMsgId));
        setStatus('error');
        setStatusDetail(msg);
        throw err;
      }
    },
    [enabled, hostedSwarmId],
  );

  return {
    mode: 'inject',
    status,
    statusDetail,
    messages,
    send,
  };
}
