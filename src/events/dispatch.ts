/**
 * MAP Event Dispatch
 *
 * Sends webhook events to subscribed swarms via their MAP WebSocket connections.
 * Uses the connection pool from sync-listener.ts.
 */

import { sendToSwarm } from '../map/sync-listener.js';
import { listSwarms } from '../db/dal/map.js';
import * as eventsDAL from '../db/dal/events.js';
import type {
  NormalizedEvent,
  EventSubscription,
  EventDeliveryLog,
  MapWebhookEventMessage,
} from './types.js';

/**
 * Dispatch a normalized event to all subscribed swarms.
 * Returns the list of delivery log entries.
 */
export function dispatchToSwarms(
  event: NormalizedEvent,
  subscriptions: EventSubscription[],
): EventDeliveryLog[] {
  if (subscriptions.length === 0) return [];

  // Build the MAP message once
  const message: MapWebhookEventMessage = {
    jsonrpc: '2.0',
    method: 'x-openhive/event.webhook',
    params: {
      source: event.source,
      event_type: event.event_type,
      action: event.action,
      delivery_id: event.delivery_id,
      payload: event.raw_payload,
      metadata: event.metadata,
    },
  };

  // Resolve target swarms from subscriptions (additive model)
  const targetSwarms = resolveTargetSwarms(subscriptions);

  const deliveries: EventDeliveryLog[] = [];

  for (const target of targetSwarms) {
    const sent = sendToSwarm(target.swarmId, message);

    const delivery = eventsDAL.logEventDelivery({
      delivery_id: event.delivery_id,
      subscription_id: target.subscriptionId,
      swarm_id: target.swarmId,
      source: event.source,
      event_type: event.event_type,
      status: sent ? 'sent' : 'offline',
      error: sent ? undefined : 'Swarm not connected',
    });

    deliveries.push(delivery);
  }

  return deliveries;
}

interface TargetSwarm {
  swarmId: string;
  subscriptionId: string | null;
}

/**
 * Resolve the set of target swarms from subscriptions.
 * Hive defaults (swarm_id IS NULL) expand to all online swarms in that hive.
 * Swarm-specific subscriptions add directly.
 * Deduplicates by swarm ID.
 */
function resolveTargetSwarms(subscriptions: EventSubscription[]): TargetSwarm[] {
  const seen = new Set<string>();
  const targets: TargetSwarm[] = [];

  for (const sub of subscriptions) {
    if (sub.swarm_id) {
      // Swarm-specific subscription
      if (!seen.has(sub.swarm_id)) {
        seen.add(sub.swarm_id);
        targets.push({ swarmId: sub.swarm_id, subscriptionId: sub.id });
      }
    } else {
      // Hive default — expand to all online swarms in this hive
      const { data: onlineSwarms } = listSwarms({
        hive_id: sub.hive_id,
        status: 'online',
        limit: 500,
      });

      for (const swarm of onlineSwarms) {
        if (!seen.has(swarm.id)) {
          seen.add(swarm.id);
          targets.push({ swarmId: swarm.id, subscriptionId: sub.id });
        }
      }
    }
  }

  return targets;
}
