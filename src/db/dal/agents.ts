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

export interface CreateHumanInput {
  name: string;
  email: string;
  password: string;
  description?: string;
  avatar_url?: string;
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
    email_verified: Boolean(row.email_verified),
    account_type: (row.account_type as string) || 'agent',
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
    account_type: agent.account_type || 'agent',
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

/**
 * Get or create the built-in "local" agent used in local auth mode.
 * Returns the existing agent if found, or creates a new admin agent.
 */
export async function getOrCreateLocalAgent(): Promise<Agent> {
  const existing = findAgentByName('local');
  if (existing) return existing;

  const { agent } = await createAgent({
    name: 'local',
    description: 'Local auto-authenticated user',
    is_admin: true,
  });
  return agent;
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
  const agents = db.prepare('SELECT * FROM agents WHERE api_key_hash IS NOT NULL').all() as Record<string, unknown>[];

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

  updates.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return findAgentById(id);
}

export function updateAgentKarma(id: string, delta: number): void {
  const db = getDatabase();
  db.prepare(`UPDATE agents SET karma = karma + ?, updated_at = datetime('now') WHERE id = ?`).run(delta, id);
}

export function updateAgentLastSeen(id: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?`).run(id);
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

// Human account functions

export async function createHumanAccount(input: CreateHumanInput): Promise<Agent> {
  const db = getDatabase();
  const id = nanoid();
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const stmt = db.prepare(`
    INSERT INTO agents (id, name, email, password_hash, description, avatar_url, account_type, is_verified, verification_status)
    VALUES (?, ?, ?, ?, ?, ?, 'human', 0, 'pending')
  `);

  stmt.run(
    id,
    input.name,
    input.email.toLowerCase(),
    passwordHash,
    input.description || null,
    input.avatar_url || null
  );

  return findAgentById(id)!;
}

export function findAgentByEmail(email: string): Agent | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM agents WHERE email = ? AND account_type = ?')
    .get(email.toLowerCase(), 'human') as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : null;
}

export async function verifyPassword(agent: Agent, password: string): Promise<boolean> {
  if (!agent.password_hash) {
    return false;
  }
  return bcrypt.compare(password, agent.password_hash);
}

export function updatePassword(id: string, passwordHash: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE agents SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(
    passwordHash,
    id
  );
}

export async function setNewPassword(id: string, password: string): Promise<void> {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  updatePassword(id, passwordHash);
}

export function verifyEmail(id: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE agents SET email_verified = 1, is_verified = 1, verification_status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run('verified', id);
}

export function isEmailTaken(email: string): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT id FROM agents WHERE email = ?').get(email.toLowerCase());
  return row !== undefined;
}

export function isNameTaken(name: string): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT id FROM agents WHERE name = ?').get(name);
  return row !== undefined;
}

// Password reset functions

export function setPasswordResetToken(id: string, token: string, expiresAt: Date): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE agents SET password_reset_token = ?, password_reset_expires = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(token, expiresAt.toISOString(), id);
}

export function findAgentByResetToken(token: string): Agent | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM agents WHERE password_reset_token = ?')
    .get(token) as Record<string, unknown> | undefined;

  if (!row) return null;

  const agent = rowToAgent(row);

  // Check if token is expired
  if (agent.password_reset_expires) {
    const expiresAt = new Date(agent.password_reset_expires);
    if (expiresAt < new Date()) {
      return null; // Token expired
    }
  }

  return agent;
}

export async function resetPassword(id: string, newPassword: string): Promise<void> {
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const db = getDatabase();
  db.prepare(
    `UPDATE agents SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(passwordHash, id);
}

export function clearPasswordResetToken(id: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE agents SET password_reset_token = NULL, password_reset_expires = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(id);
}

// SwarmHub OAuth account functions

export interface SwarmHubUserInfo {
  swarmhubUserId: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  role?: 'owner' | 'admin' | 'member';
}

/**
 * Find an existing agent linked to a SwarmHub user, or create one.
 * Used during SwarmHub OAuth authentication.
 */
export function findOrCreateSwarmHubAgent(info: SwarmHubUserInfo): Agent {
  const db = getDatabase();

  const existing = db
    .prepare('SELECT * FROM agents WHERE swarmhub_user_id = ?')
    .get(info.swarmhubUserId) as Record<string, unknown> | undefined;

  if (existing) {
    const agent = rowToAgent(existing);
    // Update name/avatar/admin status if changed on SwarmHub
    const updates: string[] = [];
    const values: unknown[] = [];

    if (info.name && info.name !== agent.name && !isNameTaken(info.name)) {
      updates.push('name = ?');
      values.push(info.name);
    }
    if (info.avatarUrl && info.avatarUrl !== agent.avatar_url) {
      updates.push('avatar_url = ?');
      values.push(info.avatarUrl);
    }
    // Sync admin status from SwarmHub role on each login
    if (info.role) {
      const shouldBeAdmin = info.role === 'owner' || info.role === 'admin';
      if (shouldBeAdmin !== agent.is_admin) {
        updates.push('is_admin = ?');
        values.push(shouldBeAdmin ? 1 : 0);
      }
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(agent.id);
      db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    return findAgentById(agent.id)!;
  }

  // Create new agent linked to SwarmHub user
  const id = nanoid();
  let finalName = info.name || `swarmhub-${info.swarmhubUserId.slice(0, 8)}`;
  let attempt = 0;
  while (isNameTaken(finalName)) {
    attempt++;
    finalName = `${info.name || 'swarmhub'}-${nanoid(4)}`;
  }

  // Grant admin to hive owners and org admins
  const isAdmin = (info.role === 'owner' || info.role === 'admin') ? 1 : 0;

  db.prepare(`
    INSERT INTO agents (
      id, name, account_type, swarmhub_user_id,
      email, avatar_url, is_verified, verification_status, is_admin
    ) VALUES (?, ?, 'swarmhub', ?, ?, ?, 1, 'verified', ?)
  `).run(
    id,
    finalName,
    info.swarmhubUserId,
    info.email || null,
    info.avatarUrl || null,
    isAdmin,
  );

  return findAgentById(id)!;
}

export function findAgentBySwarmHubUserId(swarmhubUserId: string): Agent | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM agents WHERE swarmhub_user_id = ?')
    .get(swarmhubUserId) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : null;
}
