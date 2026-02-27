/**
 * Event Routing Data Access Layer
 *
 * CRUD for post rules, event subscriptions, and delivery log.
 * Follows the same patterns as bridge.ts DAL.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type {
  PostRule,
  PostRuleThreadMode,
  EventSubscription,
  EventFilters,
  EventDeliveryLog,
} from '../../events/types.js';

// ============================================================================
// Row Converters
// ============================================================================

function rowToPostRule(row: Record<string, unknown>): PostRule {
  return {
    id: row.id as string,
    hive_id: row.hive_id as string,
    source: row.source as string,
    event_types: JSON.parse(row.event_types as string),
    filters: row.filters ? JSON.parse(row.filters as string) : null,
    normalizer: row.normalizer as string,
    thread_mode: row.thread_mode as PostRuleThreadMode,
    priority: row.priority as number,
    enabled: !!(row.enabled as number),
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToSubscription(row: Record<string, unknown>): EventSubscription {
  return {
    id: row.id as string,
    hive_id: row.hive_id as string,
    swarm_id: row.swarm_id as string | null,
    source: row.source as string,
    event_types: JSON.parse(row.event_types as string),
    filters: row.filters ? JSON.parse(row.filters as string) : null,
    priority: row.priority as number,
    enabled: !!(row.enabled as number),
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToDeliveryLog(row: Record<string, unknown>): EventDeliveryLog {
  return {
    id: row.id as string,
    delivery_id: row.delivery_id as string,
    subscription_id: row.subscription_id as string | null,
    swarm_id: row.swarm_id as string,
    source: row.source as string,
    event_type: row.event_type as string,
    status: row.status as 'sent' | 'failed' | 'offline',
    error: row.error as string | null,
    created_at: row.created_at as string,
  };
}

// ============================================================================
// Post Rules CRUD
// ============================================================================

export function createPostRule(input: {
  hive_id: string;
  source: string;
  event_types: string[];
  filters?: EventFilters | null;
  normalizer?: string;
  thread_mode?: PostRuleThreadMode;
  priority?: number;
  created_by?: string;
}): PostRule {
  const db = getDatabase();
  const id = `epr_${nanoid()}`;

  db.prepare(`
    INSERT INTO event_post_rules (id, hive_id, source, event_types, filters, normalizer, thread_mode, priority, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.hive_id,
    input.source,
    JSON.stringify(input.event_types),
    input.filters ? JSON.stringify(input.filters) : null,
    input.normalizer ?? 'default',
    input.thread_mode ?? 'post_per_event',
    input.priority ?? 100,
    input.created_by ?? null,
  );

  return findPostRuleById(id)!;
}

export function findPostRuleById(id: string): PostRule | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM event_post_rules WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToPostRule(row) : null;
}

export function listPostRules(hiveId?: string): PostRule[] {
  const db = getDatabase();
  if (hiveId) {
    const rows = db.prepare(
      'SELECT * FROM event_post_rules WHERE hive_id = ? ORDER BY priority ASC, created_at ASC',
    ).all(hiveId) as Record<string, unknown>[];
    return rows.map(rowToPostRule);
  }
  const rows = db.prepare(
    'SELECT * FROM event_post_rules ORDER BY priority ASC, created_at ASC',
  ).all() as Record<string, unknown>[];
  return rows.map(rowToPostRule);
}

export function updatePostRule(id: string, input: {
  source?: string;
  event_types?: string[];
  filters?: EventFilters | null;
  normalizer?: string;
  thread_mode?: PostRuleThreadMode;
  priority?: number;
  enabled?: boolean;
}): PostRule | null {
  const db = getDatabase();
  const existing = findPostRuleById(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.source !== undefined) { sets.push('source = ?'); params.push(input.source); }
  if (input.event_types !== undefined) { sets.push('event_types = ?'); params.push(JSON.stringify(input.event_types)); }
  if (input.filters !== undefined) { sets.push('filters = ?'); params.push(input.filters ? JSON.stringify(input.filters) : null); }
  if (input.normalizer !== undefined) { sets.push('normalizer = ?'); params.push(input.normalizer); }
  if (input.thread_mode !== undefined) { sets.push('thread_mode = ?'); params.push(input.thread_mode); }
  if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority); }
  if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }

  if (sets.length === 0) return existing;

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE event_post_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return findPostRuleById(id)!;
}

export function deletePostRule(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM event_post_rules WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get post rules matching a source and event type.
 * Matches rules where:
 * - source matches or is '*'
 * - event_types JSON array contains the event type or '*'
 */
export function getMatchingPostRules(source: string, eventType: string): PostRule[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM event_post_rules
    WHERE enabled = 1
      AND (source = ? OR source = '*')
      AND (
        EXISTS (SELECT 1 FROM json_each(event_types) WHERE value = ? OR value = '*')
      )
    ORDER BY priority ASC, created_at ASC
  `).all(source, eventType) as Record<string, unknown>[];
  return rows.map(rowToPostRule);
}

// ============================================================================
// Event Subscriptions CRUD
// ============================================================================

export function createSubscription(input: {
  hive_id: string;
  swarm_id?: string | null;
  source: string;
  event_types: string[];
  filters?: EventFilters | null;
  priority?: number;
  created_by?: string;
}): EventSubscription {
  const db = getDatabase();
  const id = `esub_${nanoid()}`;

  db.prepare(`
    INSERT INTO event_subscriptions (id, hive_id, swarm_id, source, event_types, filters, priority, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.hive_id,
    input.swarm_id ?? null,
    input.source,
    JSON.stringify(input.event_types),
    input.filters ? JSON.stringify(input.filters) : null,
    input.priority ?? 100,
    input.created_by ?? null,
  );

  return findSubscriptionById(id)!;
}

export function findSubscriptionById(id: string): EventSubscription | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM event_subscriptions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSubscription(row) : null;
}

export function listSubscriptions(options: {
  hive_id?: string;
  swarm_id?: string;
} = {}): EventSubscription[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.hive_id) { where.push('hive_id = ?'); params.push(options.hive_id); }
  if (options.swarm_id) { where.push('swarm_id = ?'); params.push(options.swarm_id); }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM event_subscriptions ${whereClause} ORDER BY priority ASC, created_at ASC`,
  ).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSubscription);
}

export function updateSubscription(id: string, input: {
  source?: string;
  event_types?: string[];
  filters?: EventFilters | null;
  priority?: number;
  enabled?: boolean;
}): EventSubscription | null {
  const db = getDatabase();
  const existing = findSubscriptionById(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.source !== undefined) { sets.push('source = ?'); params.push(input.source); }
  if (input.event_types !== undefined) { sets.push('event_types = ?'); params.push(JSON.stringify(input.event_types)); }
  if (input.filters !== undefined) { sets.push('filters = ?'); params.push(input.filters ? JSON.stringify(input.filters) : null); }
  if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority); }
  if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }

  if (sets.length === 0) return existing;

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE event_subscriptions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return findSubscriptionById(id)!;
}

export function deleteSubscription(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM event_subscriptions WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get subscriptions matching a source and event type.
 * Supports wildcard matching: '*' in event_types matches any event.
 * Also supports glob-style patterns: 'pull_request.*' matches 'pull_request.opened'.
 */
export function getMatchingSubscriptions(source: string, eventType: string): EventSubscription[] {
  const db = getDatabase();

  // First, get exact matches and wildcard matches from SQL
  const rows = db.prepare(`
    SELECT * FROM event_subscriptions
    WHERE enabled = 1
      AND (source = ? OR source = '*')
      AND (
        EXISTS (SELECT 1 FROM json_each(event_types) WHERE value = ? OR value = '*')
      )
    ORDER BY priority ASC, created_at ASC
  `).all(source, eventType) as Record<string, unknown>[];

  // Also check for glob patterns (e.g., 'pull_request.*')
  const globRows = db.prepare(`
    SELECT * FROM event_subscriptions
    WHERE enabled = 1
      AND (source = ? OR source = '*')
      AND EXISTS (
        SELECT 1 FROM json_each(event_types)
        WHERE value LIKE '%*' AND ? LIKE REPLACE(value, '*', '%')
      )
    ORDER BY priority ASC, created_at ASC
  `).all(source, eventType) as Record<string, unknown>[];

  // Deduplicate by ID
  const seen = new Set<string>();
  const result: EventSubscription[] = [];

  for (const row of [...rows, ...globRows]) {
    const id = row.id as string;
    if (!seen.has(id)) {
      seen.add(id);
      result.push(rowToSubscription(row));
    }
  }

  return result;
}

// ============================================================================
// Delivery Log
// ============================================================================

export function logEventDelivery(input: {
  delivery_id: string;
  subscription_id?: string | null;
  swarm_id: string;
  source: string;
  event_type: string;
  status: 'sent' | 'failed' | 'offline';
  error?: string;
}): EventDeliveryLog {
  const db = getDatabase();
  const id = `edl_${nanoid()}`;

  db.prepare(`
    INSERT INTO event_delivery_log (id, delivery_id, subscription_id, swarm_id, source, event_type, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.delivery_id,
    input.subscription_id ?? null,
    input.swarm_id,
    input.source,
    input.event_type,
    input.status,
    input.error ?? null,
  );

  const row = db.prepare('SELECT * FROM event_delivery_log WHERE id = ?').get(id) as Record<string, unknown>;
  return rowToDeliveryLog(row);
}

export function getDeliveryLog(options: {
  delivery_id?: string;
  swarm_id?: string;
  limit?: number;
  offset?: number;
} = {}): { data: EventDeliveryLog[]; total: number } {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.delivery_id) { where.push('delivery_id = ?'); params.push(options.delivery_id); }
  if (options.swarm_id) { where.push('swarm_id = ?'); params.push(options.swarm_id); }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM event_delivery_log ${whereClause}`,
  ).get(...params) as { count: number };

  const rows = db.prepare(
    `SELECT * FROM event_delivery_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return { data: rows.map(rowToDeliveryLog), total: countRow.count };
}
