/**
 * MAP Event Subscriptions
 *
 * In-memory subscription store for MAP protocol event delivery.
 * Implements map/subscribe and map/unsubscribe per the MAP spec.
 * Events are delivered in the MAP envelope format with subscriptionId,
 * sequence number, timestamp, and eventId.
 */

import { nanoid } from 'nanoid';
import { WebSocket } from 'ws';

// ─── Types ───────────────────────────────────────────────────────────────────

interface MapSubscription {
  id: string;
  swarmId: string;
  ws: WebSocket;
  sequence: number;
  filter: {
    eventTypes?: string[];
    hive?: string;
    conversationId?: string;
  };
}

interface SubscriptionContext {
  hive?: string;
  conversationId?: string;
}

// ─── Store ───────────────────────────────────────────────────────────────────

/** subscriptionId → MapSubscription */
const subscriptions = new Map<string, MapSubscription>();

/** swarmId → Set<subscriptionId> for cleanup on disconnect */
const swarmSubscriptions = new Map<string, Set<string>>();

// ─── Handlers ────────────────────────────────────────────────────────────────

export function handleMapSubscribe(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  swarmId: string,
): void {
  const filter = (msg.params?.filter as MapSubscription['filter']) ?? {};

  const sub: MapSubscription = {
    id: nanoid(),
    swarmId,
    ws,
    sequence: 0,
    filter,
  };

  subscriptions.set(sub.id, sub);

  let swarmSet = swarmSubscriptions.get(swarmId);
  if (!swarmSet) {
    swarmSet = new Set();
    swarmSubscriptions.set(swarmId, swarmSet);
  }
  swarmSet.add(sub.id);

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id ?? null,
      result: { subscriptionId: sub.id },
    }));
  }
}

export function handleMapUnsubscribe(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  swarmId: string,
): void {
  const subscriptionId = msg.params?.subscriptionId as string | undefined;

  if (!subscriptionId) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: { code: -32602, message: 'Missing subscriptionId' },
      }));
    }
    return;
  }

  const sub = subscriptions.get(subscriptionId);
  const removed = sub?.swarmId === swarmId && subscriptions.delete(subscriptionId);

  if (removed) {
    swarmSubscriptions.get(swarmId)?.delete(subscriptionId);
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id ?? null,
      result: { unsubscribed: !!removed },
    }));
  }
}

// ─── Event delivery ──────────────────────────────────────────────────────────

export function notifySubscribers(
  eventType: string,
  data: unknown,
  context?: SubscriptionContext,
): void {
  for (const sub of subscriptions.values()) {
    if (!matchesFilter(sub.filter, eventType, context)) continue;
    if (sub.ws.readyState !== WebSocket.OPEN) continue;

    sub.sequence++;
    sub.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'map/event',
      params: {
        subscriptionId: sub.id,
        sequence: sub.sequence,
        timestamp: new Date().toISOString(),
        event: { type: eventType, data },
        eventId: nanoid(),
      },
    }));
  }
}

function matchesFilter(
  filter: MapSubscription['filter'],
  eventType: string,
  context?: SubscriptionContext,
): boolean {
  if (filter.eventTypes && filter.eventTypes.length > 0) {
    if (!filter.eventTypes.includes(eventType)) return false;
  }
  if (filter.hive && context?.hive !== filter.hive) return false;
  if (filter.conversationId && context?.conversationId !== filter.conversationId) return false;
  return true;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export function cleanupSubscriptions(swarmId: string): void {
  const ids = swarmSubscriptions.get(swarmId);
  if (!ids) return;
  for (const id of ids) {
    subscriptions.delete(id);
  }
  swarmSubscriptions.delete(swarmId);
}
