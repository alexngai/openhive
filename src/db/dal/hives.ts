/**
 * Hives DAL — namespace/tenancy primitive for MAP.
 *
 * The social-community surface (posts, comments, votes, memberships,
 * follows) was removed. What remains is the minimal CRUD needed by:
 *   - MAP swarm registration (pre-auth keys can scope a swarm to a hive)
 *   - Event subscription forms (hive-scoped event routing)
 *   - SwarmHub connector (hive provisioning during federation)
 *
 * The `memberships` table is gone; the legacy member_count column on
 * `hives` is no longer maintained (left at 0 on new rows and never
 * updated) — it's retained for wire-compatibility with the federation
 * `/.well-known/openhive.json` response.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type { Hive, HiveSettings } from '../../types.js';

export interface CreateHiveInput {
  name: string;
  description?: string;
  owner_id: string;
  is_public?: boolean;
  settings?: HiveSettings;
}

export interface UpdateHiveInput {
  description?: string;
  is_public?: boolean;
  settings?: HiveSettings;
}

function rowToHive(row: Record<string, unknown>): Hive {
  return {
    ...row,
    is_public: Boolean(row.is_public),
    settings: row.settings ? JSON.parse(row.settings as string) : null,
  } as Hive;
}

export function createHive(input: CreateHiveInput): Hive {
  const db = getDatabase();
  const id = nanoid();

  db.prepare(`
    INSERT INTO hives (id, name, description, owner_id, is_public, settings)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name.toLowerCase(),
    input.description || null,
    input.owner_id,
    input.is_public !== false ? 1 : 0,
    input.settings ? JSON.stringify(input.settings) : null,
  );

  return findHiveById(id)!;
}

export function findHiveById(id: string): Hive | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hives WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToHive(row) : null;
}

export function findHiveByName(name: string): Hive | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hives WHERE name = ?').get(name.toLowerCase()) as Record<string, unknown> | undefined;
  return row ? rowToHive(row) : null;
}

export function updateHive(id: string, input: UpdateHiveInput): Hive | null {
  const db = getDatabase();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.description !== undefined) {
    updates.push('description = ?');
    values.push(input.description);
  }
  if (input.is_public !== undefined) {
    updates.push('is_public = ?');
    values.push(input.is_public ? 1 : 0);
  }
  if (input.settings !== undefined) {
    updates.push('settings = ?');
    values.push(JSON.stringify(input.settings));
  }

  if (updates.length === 0) return findHiveById(id);

  updates.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE hives SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return findHiveById(id);
}

export function listHives(options: {
  limit?: number;
  offset?: number;
  public_only?: boolean;
  agent_id?: string; // Historical filter; no longer used for private-hive gating
}): Hive[] {
  const db = getDatabase();
  let query = 'SELECT * FROM hives';
  const values: unknown[] = [];
  if (options.public_only !== false) {
    query += ' WHERE is_public = 1';
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
  return rows.map(rowToHive);
}

export function countHives(): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM hives').get() as { count: number };
  return row.count;
}

export function deleteHive(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM hives WHERE id = ?').run(id);
  return result.changes > 0;
}
