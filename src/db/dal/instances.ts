import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';

export interface FederatedInstance {
  id: string;
  url: string;
  name: string | null;
  description: string | null;
  protocol_version: string | null;
  status: 'pending' | 'active' | 'blocked' | 'unreachable';
  is_trusted: boolean;
  agent_count: number;
  post_count: number;
  hive_count: number;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateInstanceInput {
  url: string;
  name?: string;
  description?: string;
  is_trusted?: boolean;
}

export interface UpdateInstanceInput {
  name?: string;
  description?: string;
  protocol_version?: string;
  status?: 'pending' | 'active' | 'blocked' | 'unreachable';
  is_trusted?: boolean;
  agent_count?: number;
  post_count?: number;
  hive_count?: number;
  last_sync_at?: string;
  last_error?: string | null;
}

function rowToInstance(row: Record<string, unknown>): FederatedInstance {
  return {
    ...row,
    is_trusted: Boolean(row.is_trusted),
    status: row.status as FederatedInstance['status'],
  } as FederatedInstance;
}

export function createInstance(input: CreateInstanceInput): FederatedInstance {
  const db = getDatabase();
  const id = nanoid();

  // Normalize URL (remove trailing slash)
  const normalizedUrl = input.url.replace(/\/$/, '');

  db.prepare(
    `INSERT INTO federated_instances (id, url, name, description, is_trusted)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, normalizedUrl, input.name || null, input.description || null, input.is_trusted ? 1 : 0);

  return findInstanceById(id)!;
}

export function findInstanceById(id: string): FederatedInstance | undefined {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM federated_instances WHERE id = ?').get(id);
  return row ? rowToInstance(row as Record<string, unknown>) : undefined;
}

export function findInstanceByUrl(url: string): FederatedInstance | undefined {
  const db = getDatabase();
  const normalizedUrl = url.replace(/\/$/, '');
  const row = db.prepare('SELECT * FROM federated_instances WHERE url = ?').get(normalizedUrl);
  return row ? rowToInstance(row as Record<string, unknown>) : undefined;
}

export function updateInstance(id: string, input: UpdateInstanceInput): FederatedInstance | undefined {
  const db = getDatabase();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    updates.push('name = ?');
    values.push(input.name);
  }
  if (input.description !== undefined) {
    updates.push('description = ?');
    values.push(input.description);
  }
  if (input.protocol_version !== undefined) {
    updates.push('protocol_version = ?');
    values.push(input.protocol_version);
  }
  if (input.status !== undefined) {
    updates.push('status = ?');
    values.push(input.status);
  }
  if (input.is_trusted !== undefined) {
    updates.push('is_trusted = ?');
    values.push(input.is_trusted ? 1 : 0);
  }
  if (input.agent_count !== undefined) {
    updates.push('agent_count = ?');
    values.push(input.agent_count);
  }
  if (input.post_count !== undefined) {
    updates.push('post_count = ?');
    values.push(input.post_count);
  }
  if (input.hive_count !== undefined) {
    updates.push('hive_count = ?');
    values.push(input.hive_count);
  }
  if (input.last_sync_at !== undefined) {
    updates.push('last_sync_at = ?');
    values.push(input.last_sync_at);
  }
  if (input.last_error !== undefined) {
    updates.push('last_error = ?');
    values.push(input.last_error);
  }

  if (updates.length === 0) {
    return findInstanceById(id);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE federated_instances SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return findInstanceById(id);
}

export function listInstances(options: {
  status?: string;
  trusted_only?: boolean;
  limit?: number;
  offset?: number;
} = {}): FederatedInstance[] {
  const db = getDatabase();
  let query = 'SELECT * FROM federated_instances';
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (options.status) {
    conditions.push('status = ?');
    values.push(options.status);
  }

  if (options.trusted_only) {
    conditions.push('is_trusted = 1');
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }
  if (options.offset) {
    query += ' OFFSET ?';
    values.push(options.offset);
  }

  const rows = db.prepare(query).all(...values) as Record<string, unknown>[];
  return rows.map(rowToInstance);
}

export function deleteInstance(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM federated_instances WHERE id = ?').run(id);
  return result.changes > 0;
}

export function countInstances(): { total: number; active: number; blocked: number } {
  const db = getDatabase();
  const total = (
    db.prepare('SELECT COUNT(*) as count FROM federated_instances').get() as { count: number }
  ).count;
  const active = (
    db.prepare('SELECT COUNT(*) as count FROM federated_instances WHERE status = ?').get('active') as {
      count: number;
    }
  ).count;
  const blocked = (
    db.prepare('SELECT COUNT(*) as count FROM federated_instances WHERE status = ?').get('blocked') as {
      count: number;
    }
  ).count;

  return { total, active, blocked };
}
