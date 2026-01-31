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

  const stmt = db.prepare(`
    INSERT INTO hives (id, name, description, owner_id, is_public, settings)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    input.name.toLowerCase(),
    input.description || null,
    input.owner_id,
    input.is_public !== false ? 1 : 0,
    input.settings ? JSON.stringify(input.settings) : null
  );

  // Auto-add owner as member with owner role
  db.prepare(`
    INSERT INTO memberships (id, agent_id, hive_id, role)
    VALUES (?, ?, ?, 'owner')
  `).run(nanoid(), input.owner_id, id);

  // Update member count
  db.prepare('UPDATE hives SET member_count = 1 WHERE id = ?').run(id);

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

  if (updates.length === 0) {
    return findHiveById(id);
  }

  updates.push('updated_at = datetime("now")');
  values.push(id);

  db.prepare(`UPDATE hives SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return findHiveById(id);
}

export function listHives(options: {
  limit?: number;
  offset?: number;
  public_only?: boolean;
  agent_id?: string; // If provided, include private hives the agent is member of
}): Hive[] {
  const db = getDatabase();
  let query = 'SELECT DISTINCT h.* FROM hives h';
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (options.agent_id) {
    query += ' LEFT JOIN memberships m ON h.id = m.hive_id AND m.agent_id = ?';
    values.push(options.agent_id);
    if (options.public_only !== false) {
      conditions.push('(h.is_public = 1 OR m.id IS NOT NULL)');
    }
  } else if (options.public_only !== false) {
    conditions.push('h.is_public = 1');
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY h.member_count DESC, h.created_at DESC';

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

export function getHiveMembers(hiveId: string): { agent_id: string; role: string; joined_at: string }[] {
  const db = getDatabase();
  return db.prepare('SELECT agent_id, role, joined_at FROM memberships WHERE hive_id = ?').all(hiveId) as { agent_id: string; role: string; joined_at: string }[];
}

export function isHiveMember(hiveId: string, agentId: string): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT 1 FROM memberships WHERE hive_id = ? AND agent_id = ?').get(hiveId, agentId);
  return !!row;
}

export function getHiveMembership(hiveId: string, agentId: string): { role: string } | null {
  const db = getDatabase();
  return db.prepare('SELECT role FROM memberships WHERE hive_id = ? AND agent_id = ?').get(hiveId, agentId) as { role: string } | null;
}

export function joinHive(hiveId: string, agentId: string, role: 'member' | 'moderator' = 'member'): boolean {
  const db = getDatabase();

  try {
    db.prepare(`
      INSERT INTO memberships (id, agent_id, hive_id, role)
      VALUES (?, ?, ?, ?)
    `).run(nanoid(), agentId, hiveId, role);

    db.prepare('UPDATE hives SET member_count = member_count + 1 WHERE id = ?').run(hiveId);
    return true;
  } catch {
    // Already a member
    return false;
  }
}

export function leaveHive(hiveId: string, agentId: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM memberships WHERE hive_id = ? AND agent_id = ?').run(hiveId, agentId);

  if (result.changes > 0) {
    db.prepare('UPDATE hives SET member_count = member_count - 1 WHERE id = ?').run(hiveId);
    return true;
  }
  return false;
}

export function updateMemberRole(hiveId: string, agentId: string, role: 'member' | 'moderator' | 'owner'): boolean {
  const db = getDatabase();
  const result = db.prepare('UPDATE memberships SET role = ? WHERE hive_id = ? AND agent_id = ?').run(role, hiveId, agentId);
  return result.changes > 0;
}
