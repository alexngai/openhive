/**
 * Coordination Data Access Layer
 *
 * CRUD operations for swarm_messages and shared_contexts.
 * The coordination_tasks table has been dropped — tasks now route through OpenTasks.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type {
  SwarmMessage,
  SharedContext,
  CreateMessageInput,
  CreateContextInput,
} from '../../coordination/types.js';

// ============================================================================
// Helpers
// ============================================================================

function parseJsonField<T>(value: unknown): T | null {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function rowToMessage(row: Record<string, unknown>): SwarmMessage {
  return {
    id: row.id as string,
    hive_id: row.hive_id as string | null,
    from_swarm_id: row.from_swarm_id as string,
    to_swarm_id: row.to_swarm_id as string | null,
    content_type: row.content_type as SwarmMessage['content_type'],
    content: row.content as string,
    reply_to: row.reply_to as string | null,
    metadata: parseJsonField(row.metadata),
    read_at: row.read_at as string | null,
    created_at: row.created_at as string,
  };
}

function rowToContext(row: Record<string, unknown>): SharedContext {
  return {
    id: row.id as string,
    hive_id: row.hive_id as string,
    source_swarm_id: row.source_swarm_id as string,
    context_type: row.context_type as string,
    data: parseJsonField(row.data) ?? {},
    expires_at: row.expires_at as string | null,
    created_at: row.created_at as string,
  };
}

// ============================================================================
// Swarm Messages
// ============================================================================

export function createMessage(input: CreateMessageInput): SwarmMessage {
  const db = getDatabase();
  const id = `sm_${nanoid()}`;

  db.prepare(`
    INSERT INTO swarm_messages (id, hive_id, from_swarm_id, to_swarm_id,
      content_type, content, reply_to, metadata,
      origin_instance_id, origin_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.hive_id || null,
    input.from_swarm_id,
    input.to_swarm_id,
    input.content_type || 'text',
    input.content,
    input.reply_to || null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.origin_instance_id || null,
    input.origin_message_id || null,
  );

  return findMessageById(id)!;
}

export function findMessageById(id: string): SwarmMessage | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM swarm_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

export function findMessageByOrigin(originInstanceId: string, originMessageId: string): SwarmMessage | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM swarm_messages WHERE origin_instance_id = ? AND origin_message_id = ?'
  ).get(originInstanceId, originMessageId) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

export function listMessages(options: {
  to_swarm_id?: string;
  from_swarm_id?: string;
  hive_id?: string;
  since?: string;
  limit?: number;
  offset?: number;
} = {}): { data: SwarmMessage[]; total: number } {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.to_swarm_id) {
    where.push('to_swarm_id = ?');
    params.push(options.to_swarm_id);
  }
  if (options.from_swarm_id) {
    where.push('from_swarm_id = ?');
    params.push(options.from_swarm_id);
  }
  if (options.hive_id) {
    where.push('hive_id = ?');
    params.push(options.hive_id);
  }
  if (options.since) {
    where.push('created_at > ?');
    params.push(options.since);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM swarm_messages ${whereClause}`
  ).get(...params) as { count: number };

  const rows = db.prepare(
    `SELECT * FROM swarm_messages ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return { data: rows.map(rowToMessage), total: countRow.count };
}

export function markMessageRead(id: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE swarm_messages SET read_at = datetime('now') WHERE id = ?`).run(id);
}

// ============================================================================
// Shared Contexts
// ============================================================================

export function createContext(hiveId: string, input: CreateContextInput): SharedContext {
  const db = getDatabase();
  const id = `sc_${nanoid()}`;

  let expiresAt: string | null = null;
  if (input.ttl_seconds) {
    const date = new Date();
    date.setSeconds(date.getSeconds() + input.ttl_seconds);
    expiresAt = date.toISOString();
  }

  db.prepare(`
    INSERT INTO shared_contexts (id, hive_id, source_swarm_id, context_type, data, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    hiveId,
    input.source_swarm_id,
    input.context_type,
    JSON.stringify(input.data),
    expiresAt,
  );

  return findContextById(id)!;
}

export function findContextById(id: string): SharedContext | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM shared_contexts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToContext(row) : null;
}

export function listContexts(options: {
  hive_id?: string;
  context_type?: string;
  source_swarm_id?: string;
  limit?: number;
  offset?: number;
} = {}): { data: SharedContext[]; total: number } {
  const db = getDatabase();
  const where: string[] = ["(expires_at IS NULL OR expires_at > datetime('now'))"];
  const params: unknown[] = [];

  if (options.hive_id) {
    where.push('hive_id = ?');
    params.push(options.hive_id);
  }
  if (options.context_type) {
    where.push('context_type = ?');
    params.push(options.context_type);
  }
  if (options.source_swarm_id) {
    where.push('source_swarm_id = ?');
    params.push(options.source_swarm_id);
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM shared_contexts ${whereClause}`
  ).get(...params) as { count: number };

  const rows = db.prepare(
    `SELECT * FROM shared_contexts ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return { data: rows.map(rowToContext), total: countRow.count };
}

export function deleteExpiredContexts(): number {
  const db = getDatabase();
  const result = db.prepare(
    `DELETE FROM shared_contexts WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')`
  ).run();
  return result.changes;
}
