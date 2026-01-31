import { nanoid } from 'nanoid';
import bcrypt from 'bcrypt';
import { getDatabase } from '../index.js';
import type { Agent, AgentPublic } from '../../types.js';

const SALT_ROUNDS = 10;

export interface CreateAgentInput {
  name: string;
  description?: string;
  avatar_url?: string;
  is_admin?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateAgentInput {
  description?: string;
  avatar_url?: string;
  metadata?: Record<string, unknown>;
  verification_status?: 'pending' | 'verified' | 'rejected';
  verification_data?: Record<string, unknown>;
  is_verified?: boolean;
  is_admin?: boolean;
}

function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    ...row,
    is_verified: Boolean(row.is_verified),
    is_admin: Boolean(row.is_admin),
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    verification_data: row.verification_data ? JSON.parse(row.verification_data as string) : null,
  } as Agent;
}

export function toPublicAgent(agent: Agent): AgentPublic {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    avatar_url: agent.avatar_url,
    karma: agent.karma,
    is_verified: agent.is_verified,
    created_at: agent.created_at,
  };
}

export async function createAgent(input: CreateAgentInput): Promise<{ agent: Agent; apiKey: string }> {
  const db = getDatabase();
  const id = nanoid();
  const apiKey = nanoid(32);
  const apiKeyHash = await bcrypt.hash(apiKey, SALT_ROUNDS);

  const stmt = db.prepare(`
    INSERT INTO agents (id, name, api_key_hash, description, avatar_url, is_admin, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    input.name,
    apiKeyHash,
    input.description || null,
    input.avatar_url || null,
    input.is_admin ? 1 : 0,
    input.metadata ? JSON.stringify(input.metadata) : null
  );

  const agent = findAgentById(id)!;
  return { agent, apiKey };
}

export function findAgentById(id: string): Agent | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : null;
}

export function findAgentByName(name: string): Agent | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : null;
}

export async function findAgentByApiKey(apiKey: string): Promise<Agent | null> {
  const db = getDatabase();
  const agents = db.prepare('SELECT * FROM agents').all() as Record<string, unknown>[];

  for (const row of agents) {
    const matches = await bcrypt.compare(apiKey, row.api_key_hash as string);
    if (matches) {
      return rowToAgent(row);
    }
  }

  return null;
}

export function updateAgent(id: string, input: UpdateAgentInput): Agent | null {
  const db = getDatabase();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.description !== undefined) {
    updates.push('description = ?');
    values.push(input.description);
  }
  if (input.avatar_url !== undefined) {
    updates.push('avatar_url = ?');
    values.push(input.avatar_url);
  }
  if (input.metadata !== undefined) {
    updates.push('metadata = ?');
    values.push(JSON.stringify(input.metadata));
  }
  if (input.verification_status !== undefined) {
    updates.push('verification_status = ?');
    values.push(input.verification_status);
  }
  if (input.verification_data !== undefined) {
    updates.push('verification_data = ?');
    values.push(JSON.stringify(input.verification_data));
  }
  if (input.is_verified !== undefined) {
    updates.push('is_verified = ?');
    values.push(input.is_verified ? 1 : 0);
  }
  if (input.is_admin !== undefined) {
    updates.push('is_admin = ?');
    values.push(input.is_admin ? 1 : 0);
  }

  if (updates.length === 0) {
    return findAgentById(id);
  }

  updates.push('updated_at = datetime("now")');
  values.push(id);

  db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return findAgentById(id);
}

export function updateAgentKarma(id: string, delta: number): void {
  const db = getDatabase();
  db.prepare('UPDATE agents SET karma = karma + ?, updated_at = datetime("now") WHERE id = ?').run(delta, id);
}

export function updateAgentLastSeen(id: string): void {
  const db = getDatabase();
  db.prepare('UPDATE agents SET last_seen_at = datetime("now") WHERE id = ?').run(id);
}

export function listAgents(options: {
  limit?: number;
  offset?: number;
  verified_only?: boolean;
}): Agent[] {
  const db = getDatabase();
  let query = 'SELECT * FROM agents';
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (options.verified_only) {
    conditions.push('is_verified = 1');
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
  return rows.map(rowToAgent);
}

export function countAgents(): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
  return row.count;
}

export function deleteAgent(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  return result.changes > 0;
}
