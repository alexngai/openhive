/**
 * Event Router — Central Dispatcher
 *
 * Routes normalized webhook events (GitHub, Slack, etc.) to subscribed
 * swarms via MAP. Post-to-hive pipeline was removed with the social layer;
 * incoming events are only dispatched to swarms now.
 */

import * as eventsDAL from '../db/dal/events.js';
import { broadcastToChannel } from '../realtime/index.js';
import { dispatchToSwarms } from './dispatch.js';
import type { NormalizedEvent, EventFilters, RouteResult } from './types.js';

/**
 * Route a normalized event to all matching swarm subscriptions.
 */
export function routeEvent(event: NormalizedEvent): RouteResult {
  const result: RouteResult = {
    swarms_notified: 0,
    deliveries: [],
  };

  const subscriptions = eventsDAL.getMatchingSubscriptions(event.source, event.event_type);

  const matchedSubs = subscriptions.filter((sub) =>
    matchesFilters(sub.filters, event.metadata),
  );

  if (matchedSubs.length > 0) {
    const deliveries = dispatchToSwarms(event, matchedSubs);
    result.deliveries = deliveries;
    result.swarms_notified = deliveries.filter((d) => d.status === 'sent').length;
  }

  // Live stream for the Events page's Live tab. Frontend ring-buffers
  // these for "why didn't this fire" debugging. Includes unmatched events
  // (matched_subs=0) so subscribers can see them too.
  broadcastToChannel('events:live', {
    type: 'events.received',
    data: {
      received_at: new Date().toISOString(),
      event,
      matched_subs: matchedSubs.length,
      deliveries: result.deliveries,
    },
  });

  if (result.swarms_notified > 0) {
    console.log(
      `[events] Routed ${event.source}:${event.event_type} → ${result.swarms_notified} swarm(s)`,
    );
  }

  return result;
}

/**
 * Check if event metadata passes the subscription filters.
 * null filters = match all.
 */
function matchesFilters(
  filters: EventFilters | null,
  metadata: NormalizedEvent['metadata'],
): boolean {
  if (!filters) return true;

  if (filters.repos && filters.repos.length > 0) {
    if (!metadata.repo || !filters.repos.includes(metadata.repo)) return false;
  }

  if (filters.channels && filters.channels.length > 0) {
    if (!metadata.channel_id || !filters.channels.includes(metadata.channel_id)) return false;
  }

  if (filters.branches && filters.branches.length > 0) {
    if (!metadata.branch || !filters.branches.includes(metadata.branch)) return false;
  }

  return true;
}
