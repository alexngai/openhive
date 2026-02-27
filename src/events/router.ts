/**
 * Event Router — Central Dispatcher
 *
 * Dual-path event routing:
 * 1. Post Pipeline: matching post rules → create posts in hives
 * 2. MAP Pipeline: matching subscriptions → dispatch to swarms
 *
 * Both paths can fire for the same event.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../db/index.js';
import { createPost } from '../db/dal/posts.js';
import * as eventsDAL from '../db/dal/events.js';
import { broadcastToChannel } from '../realtime/index.js';
import { dispatchToSwarms } from './dispatch.js';
import type { NormalizedEvent, EventFilters, RouteResult } from './types.js';

/**
 * Route a normalized event through both the post and MAP pipelines.
 */
export function routeEvent(event: NormalizedEvent): RouteResult {
  const result: RouteResult = {
    posts_created: 0,
    swarms_notified: 0,
    deliveries: [],
  };

  // ── Post Pipeline ──────────────────────────────────────────────────────
  const postRules = eventsDAL.getMatchingPostRules(event.source, event.event_type);

  for (const rule of postRules) {
    // Check filters
    if (!matchesFilters(rule.filters, event.metadata)) continue;

    // Only create posts if the normalizer produced post data
    if (!event.post) continue;

    // Skip if thread_mode says so
    if (rule.thread_mode === 'skip') continue;

    // Resolve the event author proxy agent
    const authorId = resolveEventAuthor(event.source);

    // Create the post
    const post = createPost({
      hive_id: rule.hive_id,
      author_id: authorId,
      title: event.post.title,
      content: event.post.content,
      url: event.post.url,
    });

    result.posts_created++;

    // Broadcast to WebSocket subscribers for real-time UI updates
    broadcastToChannel(`hive:*`, {
      type: 'new_post',
      data: {
        post_id: post.id,
        hive_id: rule.hive_id,
        source: event.source,
        event_type: event.event_type,
      },
    });
  }

  // ── MAP Pipeline ───────────────────────────────────────────────────────
  const subscriptions = eventsDAL.getMatchingSubscriptions(event.source, event.event_type);

  // Filter subscriptions by event metadata
  const matchedSubs = subscriptions.filter((sub) =>
    matchesFilters(sub.filters, event.metadata),
  );

  if (matchedSubs.length > 0) {
    const deliveries = dispatchToSwarms(event, matchedSubs);
    result.deliveries = deliveries;
    result.swarms_notified = deliveries.filter((d) => d.status === 'sent').length;
  }

  if (result.posts_created > 0 || result.swarms_notified > 0) {
    console.log(
      `[events] Routed ${event.source}:${event.event_type} → ` +
      `${result.posts_created} post(s), ${result.swarms_notified} swarm(s)`,
    );
  }

  return result;
}

/**
 * Check if event metadata passes the subscription/rule filters.
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

// ============================================================================
// Event Author Resolution
// ============================================================================

// Cache proxy agent IDs per source
const eventAuthorCache = new Map<string, string>();

/**
 * Resolve or create a system proxy agent for event posts.
 * e.g., `event:github` or `event:slack`.
 */
function resolveEventAuthor(source: string): string {
  const cached = eventAuthorCache.get(source);
  if (cached) return cached;

  const db = getDatabase();
  const agentName = `event:${source}`;

  // Check if already exists
  const existing = db.prepare('SELECT id FROM agents WHERE name = ?').get(agentName) as { id: string } | undefined;
  if (existing) {
    eventAuthorCache.set(source, existing.id);
    return existing.id;
  }

  // Create the proxy agent
  const agentId = nanoid();
  db.prepare(`
    INSERT INTO agents (id, name, description, account_type, metadata)
    VALUES (?, ?, ?, 'agent', ?)
  `).run(
    agentId,
    agentName,
    `System agent for ${source} webhook events`,
    JSON.stringify({ event_proxy: true, source }),
  );

  eventAuthorCache.set(source, agentId);
  return agentId;
}
