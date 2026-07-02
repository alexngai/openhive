/**
 * HostedChatService — module-level singleton implementing swarmcraft's
 * `HostedChatServiceLike` interface against openhive's REST + WS surface.
 *
 * Translates the openhive wire format (`hosted-chat.event` notifications
 * carrying a normalized `HostedChatEvent`) into the
 * `HostedChatSubscriptionHandlers` shape the adapter expects.
 *
 * Channel subscriptions are ref-counted per `hostedSwarmId` so multiple
 * subscribers (e.g. ChatFab + Threads detail simultaneously) share one
 * WS channel. A single module-level WS listener fans `hosted-chat.event`
 * out to the per-id handler set.
 */

import type {
  HostedChatServiceLike,
  HostedChatSubscriptionHandlers,
  HostedChatPermissionPayload,
} from 'swarmcraft/ui/embed';
import { api } from '../lib/api';
import { useWSStore, subscribeChannelImperatively } from '../hooks/useWebSocket';

// Mirror of `HostedChatEvent` in `src/swarm/hosted-chat-events.ts`. Keep
// the union in sync — both files derive from the same backend wire shape.
type HostedChatEvent =
  | { kind: 'message.start'; itemId: string; role: 'assistant' | 'user' | 'system' }
  | { kind: 'message.delta'; itemId: string; delta: string }
  | { kind: 'message.complete'; itemId: string; finalText?: string }
  | { kind: 'turn.started'; turnId: string }
  | { kind: 'turn.completed'; turnId: string }
  | { kind: 'error'; message: string; code?: string | number }
  | { kind: 'permission.request'; request: HostedChatPermissionPayload }
  | { kind: 'permission.resolved'; requestId: string; decision: 'approved' | 'denied' }
  | { kind: 'raw'; provider: string; method: string; params?: unknown };

interface HostedChatPayload {
  hosted_swarm_id: string;
  provider: string;
  event: HostedChatEvent;
}

const handlerSets = new Map<string, Set<HostedChatSubscriptionHandlers>>();
let wsListenerRegistered = false;

function dispatch(payload: HostedChatPayload): void {
  const set = handlerSets.get(payload.hosted_swarm_id);
  if (!set || set.size === 0) return;
  for (const h of set) {
    routeEvent(h, payload.provider, payload.event);
  }
}

function routeEvent(
  h: HostedChatSubscriptionHandlers,
  provider: string,
  ev: HostedChatEvent,
): void {
  switch (ev.kind) {
    case 'message.start':
      h.onMessageStart(ev.itemId, ev.role);
      break;
    case 'message.delta':
      h.onMessageDelta(ev.itemId, ev.delta);
      break;
    case 'message.complete':
      h.onMessageComplete(ev.itemId, ev.finalText);
      break;
    case 'turn.started':
      h.onTurnStarted(ev.turnId);
      break;
    case 'turn.completed':
      h.onTurnCompleted(ev.turnId);
      break;
    case 'error':
      h.onError(ev.message, ev.code);
      break;
    case 'permission.request':
      h.onPermissionRequest?.(ev.request);
      break;
    case 'permission.resolved':
      h.onPermissionResolved?.(ev.requestId, ev.decision);
      break;
    case 'raw':
      h.onRaw?.(provider, ev.method, ev.params);
      break;
  }
}

function ensureWSListener(): void {
  if (wsListenerRegistered) return;
  wsListenerRegistered = true;
  useWSStore.getState().addListener('hosted-chat.event', (raw) => {
    // The store emits the full WS envelope (`{type, channel, data}`); unwrap.
    const envelope = raw as { data?: HostedChatPayload } | undefined;
    const payload = envelope?.data ?? (raw as HostedChatPayload | undefined);
    if (!payload?.hosted_swarm_id) return;
    dispatch(payload);
  });
}

/**
 * Interrupt the in-flight turn on a hosted rpc swarm (clean cancel — the
 * session stays usable). Not part of `HostedChatServiceLike`, so exposed
 * as a standalone helper; callers track the active turn id from the
 * `turn.started` / `turn.completed` events.
 */
export async function interruptHostedTurn(
  hostedSwarmId: string,
  turnId: string,
): Promise<void> {
  await api.post(`/map/hosted/${hostedSwarmId}/chat/interrupt`, { turn_id: turnId });
}

export const hostedChatService: HostedChatServiceLike = {
  sendTurn: async (hostedSwarmId, text) => {
    return api.post<{ turn_id: string }>(
      `/map/hosted/${hostedSwarmId}/chat/turn`,
      { text },
    ).then((r) => ({ turnId: r.turn_id }));
  },

  replyPermission: async (hostedSwarmId, requestId, decision) => {
    await api.post(
      `/map/hosted/${hostedSwarmId}/chat/permission/${encodeURIComponent(requestId)}`,
      { decision },
    );
  },

  subscribe: (hostedSwarmId, handlers) => {
    ensureWSListener();
    const unsubChannel = subscribeChannelImperatively(`hosted-chat:${hostedSwarmId}`);

    let set = handlerSets.get(hostedSwarmId);
    if (!set) {
      set = new Set();
      handlerSets.set(hostedSwarmId, set);
    }
    set.add(handlers);

    return () => {
      const current = handlerSets.get(hostedSwarmId);
      if (current) {
        current.delete(handlers);
        if (current.size === 0) handlerSets.delete(hostedSwarmId);
      }
      unsubChannel();
    };
  },
};
