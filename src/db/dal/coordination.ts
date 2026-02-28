/**
 * Coordination Data Access Layer
 *
 * CRUD operations for coordination_tasks, swarm_messages, and shared_contexts.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type {
  CoordinationTask,
  SwarmMessage,
  SharedContext,
  CreateTaskInput,
  UpdateTaskInput,
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

function rowToTask(row: Record<string, unknown>): CoordinationTask {
  return {
    id: row.id as string,
    hive_id: row.hive_id as string,
    title: row.title as string,
    description: row.description as string | null,
    priority: row.priority as CoordinationTask['priority'],
    status: row.status as CoordinationTask['status'],
    assigned_by_agent_id: row.assigned_by_agent_id as string,
    assigned_by_swarm_id: row.assigned_by_swarm_id as string | null,
    assigned_to_swarm_id: row.assigned_to_swarm_id as string | null,
    context: parseJsonField(row.context),
    result: parseJsonField(row.result),
    error: row.error as string | null,
    progress: row.progress as number,
    deadline: row.deadline as string | null,
    origin_instance_id: row.origin_instance_id as string | null,
    origin_task_id: row.origin_task_id as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    completed_at: row.completed_at as string | null,
  };
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
// Coordination Tasks
// ============================================================================

export function createTask(hiveId: string, input: CreateTaskInput): CoordinationTask {
  const db = getDatabase();
  const id = `ct_${nanoid()}`;

  db.prepare(`
    INSERT INTO coordination_tasks (id, hive_id, title, description, priority,
      assigned_by_agent_id, assigned_by_swarm_id, assigned_to_swarm_id, context, deadline,
      origin_instance_id, origin_task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    hiveId,
    input.title,
    input.description || null,
    input.priority || 'medium',
    input.assigned_by_agent_id,
    input.assigned_by_swarm_id || null,
    input.assigned_to_swarm_id,
    input.context ? JSON.stringify(input.context) : null,
    input.deadline || null,
    input.origin_instance_id || null,
    input.origin_task_id || null,
  );

  return findTaskById(id)!;
}

export function findTaskById(id: string): CoordinationTask | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM coordination_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function findTaskByOrigin(originInstanceId: string, originTaskId: string): CoordinationTask | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM coordination_tasks WHERE origin_instance_id = ? AND origin_task_id = ?'
  ).get(originInstanceId, originTaskId) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function updateTask(id: string, input: UpdateTaskInput): CoordinationTask | null {
  const db = getDatabase();
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (input.status !== undefined) {
    sets.push('status = ?');
    values.push(input.status);
    if (input.status === 'completed' || input.status === 'failed') {
      sets.push("completed_at = datetime('now')");
    }
  }
  if (input.progress !== undefined) { sets.push('progress = ?'); values.push(input.progress); }
  if (input.result !== undefined) { sets.push('result = ?'); values.push(JSON.stringify(input.result)); }
  if (input.error !== undefined) { sets.push('error = ?'); values.push(input.error); }

  values.push(id);
  db.prepare(`UPDATE coordination_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return findTaskById(id);
}

export function listTasks(options: {
  hive_id?: string;
  status?: string;
  assigned_to_swarm_id?: string;
  limit?: number;
  offset?: number;
} = {}): { data: CoordinationTask[]; total: number } {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.hive_id) {
    where.push('hive_id = ?');
    params.push(options.hive_id);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.assigned_to_swarm_id) {
    where.push('assigned_to_swarm_id = ?');
    params.push(options.assigned_to_swarm_id);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM coordination_tasks ${whereClause}`
  ).get(...params) as { count: number };

  const rows = db.prepare(
    `SELECT * FROM coordination_tasks ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return { data: rows.map(rowToTask), total: countRow.count };
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
