import { nanoid } from 'nanoid';
import { randomBytes } from 'crypto';
import { getDatabase } from '../index.js';
import type {
  MemoryBank,
  MemoryBankSubscription,
  MemorySyncEvent,
  MemoryBankWithMeta,
  MemoryBankSubscriptionWithAgent,
  MemoryBankVisibility,
  MemoryBankPermission,
} from '../../types.js';

// Generate a webhook secret
function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

// ============================================================================
// Memory Bank CRUD
// ============================================================================

export interface CreateMemoryBankInput {
  name: string;
  description?: string;
  git_remote_url: string;
  visibility?: MemoryBankVisibility;
  owner_agent_id: string;
}

export function createMemoryBank(input: CreateMemoryBankInput): MemoryBank {
  const db = getDatabase();
  const id = `bank_${nanoid()}`;
  const webhookSecret = generateWebhookSecret();

  db.prepare(`
    INSERT INTO memory_banks (id, name, description, git_remote_url, webhook_secret, visibility, owner_agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.description || null,
    input.git_remote_url,
    webhookSecret,
    input.visibility || 'private',
    input.owner_agent_id
  );

  // Auto-subscribe owner with admin permission
  const subId = nanoid();
  db.prepare(`
    INSERT INTO memory_bank_subscriptions (id, agent_id, bank_id, permission)
    VALUES (?, ?, ?, 'admin')
  `).run(subId, input.owner_agent_id, id);

  return findMemoryBankById(id)!;
}

export function findMemoryBankById(id: string): MemoryBank | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM memory_banks WHERE id = ?').get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return row as unknown as MemoryBank;
}

export function findMemoryBankByWebhookSecret(secret: string): MemoryBank | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM memory_banks WHERE webhook_secret = ?').get(secret) as Record<string, unknown> | undefined;

  if (!row) return null;

  return row as unknown as MemoryBank;
}

/**
 * Normalize a git remote URL to a canonical form for matching.
 * Handles various formats:
 * - git@github.com:user/repo.git
 * - https://github.com/user/repo.git
 * - https://github.com/user/repo
 * - github.com/user/repo
 *
 * Returns: "github.com/user/repo" (lowercase, no protocol, no .git)
 */
export function normalizeGitUrl(url: string): string {
  let normalized = url.toLowerCase().trim();

  // Remove protocol
  normalized = normalized.replace(/^(https?:\/\/|git:\/\/|ssh:\/\/)/i, '');

  // Handle SSH format: git@github.com:user/repo -> github.com/user/repo
  normalized = normalized.replace(/^git@([^:]+):/, '$1/');

  // Remove .git suffix
  normalized = normalized.replace(/\.git$/, '');

  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, '');

  // Remove any auth info (user:pass@)
  normalized = normalized.replace(/^[^@]+@/, '');

  return normalized;
}

/**
 * Find memory banks that match a repository URL.
 * Uses normalized URL matching to handle different URL formats.
 */
export function findMemoryBanksByRepoUrl(repoUrl: string): MemoryBank[] {
  const db = getDatabase();
  const normalizedInput = normalizeGitUrl(repoUrl);

  // Get all memory banks and filter by normalized URL
  // This is not the most efficient but allows flexible matching
  const rows = db.prepare('SELECT * FROM memory_banks').all() as Record<string, unknown>[];

  return rows
    .filter((row) => normalizeGitUrl(row.git_remote_url as string) === normalizedInput)
    .map((row) => row as unknown as MemoryBank);
}

/**
 * Find a single memory bank by repository full name (e.g., "user/repo")
 * and optional host (defaults to github.com)
 */
export function findMemoryBankByRepoName(
  fullName: string,
  host: string = 'github.com'
): MemoryBank | null {
  const normalizedInput = `${host.toLowerCase()}/${fullName.toLowerCase()}`;
  const banks = findMemoryBanksByRepoUrl(normalizedInput);
  return banks.length > 0 ? banks[0] : null;
}

export interface UpdateMemoryBankInput {
  name?: string;
  description?: string;
  git_remote_url?: string;
  visibility?: MemoryBankVisibility;
}

export function updateMemoryBank(id: string, input: UpdateMemoryBankInput): MemoryBank | null {
  const db = getDatabase();
  const sets: string[] = ['updated_at = datetime(\'now\')'];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    values.push(input.description);
  }
  if (input.git_remote_url !== undefined) {
    sets.push('git_remote_url = ?');
    values.push(input.git_remote_url);
  }
  if (input.visibility !== undefined) {
    sets.push('visibility = ?');
    values.push(input.visibility);
  }

  values.push(id);

  db.prepare(`UPDATE memory_banks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  return findMemoryBankById(id);
}

export function updateMemoryBankSyncState(
  id: string,
  commitHash: string,
  pushBy: string | null
): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE memory_banks
    SET last_commit_hash = ?, last_push_by = ?, last_push_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(commitHash, pushBy, id);
}

export function regenerateWebhookSecret(id: string): string {
  const db = getDatabase();
  const newSecret = generateWebhookSecret();

  db.prepare(`
    UPDATE memory_banks SET webhook_secret = ?, updated_at = datetime('now') WHERE id = ?
  `).run(newSecret, id);

  return newSecret;
}

export function deleteMemoryBank(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM memory_banks WHERE id = ?').run(id);
  return result.changes > 0;
}

// ============================================================================
// Memory Bank Queries with Metadata
// ============================================================================

export function getMemoryBankWithMeta(id: string, viewerAgentId?: string): MemoryBankWithMeta | null {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT
      mb.*,
      a.id as owner_id,
      a.name as owner_name,
      a.description as owner_description,
      a.avatar_url as owner_avatar_url,
      a.karma as owner_karma,
      a.is_verified as owner_is_verified,
      a.created_at as owner_created_at,
      a.account_type as owner_account_type,
      (SELECT COUNT(*) FROM memory_bank_subscriptions WHERE bank_id = mb.id) as subscriber_count
    FROM memory_banks mb
    JOIN agents a ON mb.owner_agent_id = a.id
    WHERE mb.id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  // Get tags
  const tags = db.prepare('SELECT tag FROM memory_bank_tags WHERE bank_id = ?').all(id) as { tag: string }[];

  // Get viewer's subscription if authenticated
  let isSubscribed = false;
  let myPermission: MemoryBankPermission | null = null;

  if (viewerAgentId) {
    const sub = db.prepare(`
      SELECT permission FROM memory_bank_subscriptions WHERE bank_id = ? AND agent_id = ?
    `).get(id, viewerAgentId) as { permission: MemoryBankPermission } | undefined;

    if (sub) {
      isSubscribed = true;
      myPermission = sub.permission;
    }
  }

  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | null,
    git_remote_url: row.git_remote_url as string,
    webhook_secret: row.webhook_secret as string | null,
    visibility: row.visibility as MemoryBankVisibility,
    last_commit_hash: row.last_commit_hash as string | null,
    last_push_by: row.last_push_by as string | null,
    last_push_at: row.last_push_at as string | null,
    owner_agent_id: row.owner_agent_id as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    owner: {
      id: row.owner_id as string,
      name: row.owner_name as string,
      description: row.owner_description as string | null,
      avatar_url: row.owner_avatar_url as string | null,
      karma: row.owner_karma as number,
      is_verified: Boolean(row.owner_is_verified),
      created_at: row.owner_created_at as string,
      account_type: row.owner_account_type as 'agent' | 'human',
    },
    tags: tags.map((t) => t.tag),
    subscriber_count: row.subscriber_count as number,
    is_subscribed: isSubscribed,
    my_permission: myPermission,
  };
}

export interface ListMemoryBanksOptions {
  agentId: string;
  owned?: boolean;
  visibility?: MemoryBankVisibility;
  limit?: number;
  offset?: number;
}

export function listAccessibleMemoryBanks(options: ListMemoryBanksOptions): {
  data: MemoryBankWithMeta[];
  total: number;
} {
  const db = getDatabase();
  const { agentId, owned, visibility, limit = 50, offset = 0 } = options;

  // Build query for banks the agent can access
  let whereClause: string;
  const params: unknown[] = [];

  if (owned) {
    whereClause = 'WHERE mb.owner_agent_id = ?';
    params.push(agentId);
  } else {
    // Agent can access: owned banks, subscribed banks, or public banks
    whereClause = `
      WHERE (
        mb.owner_agent_id = ?
        OR mb.id IN (SELECT bank_id FROM memory_bank_subscriptions WHERE agent_id = ?)
        OR mb.visibility = 'public'
      )
    `;
    params.push(agentId, agentId);
  }

  if (visibility) {
    whereClause += ' AND mb.visibility = ?';
    params.push(visibility);
  }

  // Get total count
  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM memory_banks mb ${whereClause}
  `).get(...params) as { count: number };

  // Get paginated results
  const rows = db.prepare(`
    SELECT
      mb.*,
      a.id as owner_id,
      a.name as owner_name,
      a.description as owner_description,
      a.avatar_url as owner_avatar_url,
      a.karma as owner_karma,
      a.is_verified as owner_is_verified,
      a.created_at as owner_created_at,
      a.account_type as owner_account_type,
      (SELECT COUNT(*) FROM memory_bank_subscriptions WHERE bank_id = mb.id) as subscriber_count,
      (SELECT permission FROM memory_bank_subscriptions WHERE bank_id = mb.id AND agent_id = ?) as my_permission
    FROM memory_banks mb
    JOIN agents a ON mb.owner_agent_id = a.id
    ${whereClause}
    ORDER BY mb.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(agentId, ...params, limit, offset) as Record<string, unknown>[];

  const data = rows.map((row) => {
    const tags = db.prepare('SELECT tag FROM memory_bank_tags WHERE bank_id = ?').all(row.id as string) as { tag: string }[];

    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | null,
      git_remote_url: row.git_remote_url as string,
      webhook_secret: row.webhook_secret as string | null,
      visibility: row.visibility as MemoryBankVisibility,
      last_commit_hash: row.last_commit_hash as string | null,
      last_push_by: row.last_push_by as string | null,
      last_push_at: row.last_push_at as string | null,
      owner_agent_id: row.owner_agent_id as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      owner: {
        id: row.owner_id as string,
        name: row.owner_name as string,
        description: row.owner_description as string | null,
        avatar_url: row.owner_avatar_url as string | null,
        karma: row.owner_karma as number,
        is_verified: Boolean(row.owner_is_verified),
        created_at: row.owner_created_at as string,
        account_type: row.owner_account_type as 'agent' | 'human',
      },
      tags: tags.map((t) => t.tag),
      subscriber_count: row.subscriber_count as number,
      is_subscribed: row.my_permission !== null,
      my_permission: row.my_permission as MemoryBankPermission | null,
    };
  });

  return { data, total: countRow.count };
}

export interface DiscoverMemoryBanksOptions {
  query?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export function discoverPublicMemoryBanks(options: DiscoverMemoryBanksOptions): {
  data: MemoryBankWithMeta[];
  total: number;
} {
  const db = getDatabase();
  const { query, tags, limit = 50, offset = 0 } = options;

  let whereClause = "WHERE mb.visibility = 'public'";
  const params: unknown[] = [];

  if (query) {
    whereClause += ' AND (mb.name LIKE ? OR mb.description LIKE ?)';
    params.push(`%${query}%`, `%${query}%`);
  }

  if (tags && tags.length > 0) {
    const placeholders = tags.map(() => '?').join(', ');
    whereClause += ` AND mb.id IN (
      SELECT bank_id FROM memory_bank_tags WHERE tag IN (${placeholders})
      GROUP BY bank_id HAVING COUNT(DISTINCT tag) = ?
    )`;
    params.push(...tags, tags.length);
  }

  // Get total count
  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM memory_banks mb ${whereClause}
  `).get(...params) as { count: number };

  // Get paginated results
  const rows = db.prepare(`
    SELECT
      mb.id, mb.name, mb.description, mb.visibility,
      mb.last_commit_hash, mb.last_push_by, mb.last_push_at,
      mb.owner_agent_id, mb.created_at, mb.updated_at,
      a.id as owner_id,
      a.name as owner_name,
      a.description as owner_description,
      a.avatar_url as owner_avatar_url,
      a.karma as owner_karma,
      a.is_verified as owner_is_verified,
      a.created_at as owner_created_at,
      a.account_type as owner_account_type,
      (SELECT COUNT(*) FROM memory_bank_subscriptions WHERE bank_id = mb.id) as subscriber_count
    FROM memory_banks mb
    JOIN agents a ON mb.owner_agent_id = a.id
    ${whereClause}
    ORDER BY subscriber_count DESC, mb.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Record<string, unknown>[];

  const data = rows.map((row) => {
    const bankTags = db.prepare('SELECT tag FROM memory_bank_tags WHERE bank_id = ?').all(row.id as string) as { tag: string }[];

    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | null,
      git_remote_url: '', // Don't expose git URL for public discovery
      webhook_secret: null,
      visibility: row.visibility as MemoryBankVisibility,
      last_commit_hash: row.last_commit_hash as string | null,
      last_push_by: row.last_push_by as string | null,
      last_push_at: row.last_push_at as string | null,
      owner_agent_id: row.owner_agent_id as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      owner: {
        id: row.owner_id as string,
        name: row.owner_name as string,
        description: row.owner_description as string | null,
        avatar_url: row.owner_avatar_url as string | null,
        karma: row.owner_karma as number,
        is_verified: Boolean(row.owner_is_verified),
        created_at: row.owner_created_at as string,
        account_type: row.owner_account_type as 'agent' | 'human',
      },
      tags: bankTags.map((t) => t.tag),
      subscriber_count: row.subscriber_count as number,
    };
  });

  return { data, total: countRow.count };
}

// ============================================================================
// Subscriptions
// ============================================================================

export function subscribeToMemoryBank(
  agentId: string,
  bankId: string,
  permission: MemoryBankPermission = 'read'
): MemoryBankSubscription | null {
  const db = getDatabase();

  try {
    const id = nanoid();
    db.prepare(`
      INSERT INTO memory_bank_subscriptions (id, agent_id, bank_id, permission)
      VALUES (?, ?, ?, ?)
    `).run(id, agentId, bankId, permission);

    return {
      id,
      agent_id: agentId,
      bank_id: bankId,
      permission,
      subscribed_at: new Date().toISOString(),
    };
  } catch {
    // Already subscribed - update permission instead
    db.prepare(`
      UPDATE memory_bank_subscriptions SET permission = ? WHERE agent_id = ? AND bank_id = ?
    `).run(permission, agentId, bankId);

    const row = db.prepare(`
      SELECT * FROM memory_bank_subscriptions WHERE agent_id = ? AND bank_id = ?
    `).get(agentId, bankId) as MemoryBankSubscription | undefined;

    return row || null;
  }
}

export function unsubscribeFromMemoryBank(agentId: string, bankId: string): boolean {
  const db = getDatabase();

  // Don't allow owner to unsubscribe
  const bank = findMemoryBankById(bankId);
  if (bank && bank.owner_agent_id === agentId) {
    return false;
  }

  const result = db.prepare(`
    DELETE FROM memory_bank_subscriptions WHERE agent_id = ? AND bank_id = ?
  `).run(agentId, bankId);

  return result.changes > 0;
}

export function getSubscription(agentId: string, bankId: string): MemoryBankSubscription | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT * FROM memory_bank_subscriptions WHERE agent_id = ? AND bank_id = ?
  `).get(agentId, bankId) as MemoryBankSubscription | undefined;

  return row || null;
}

export function getMemoryBankSubscribers(
  bankId: string,
  limit = 50,
  offset = 0
): { data: MemoryBankSubscriptionWithAgent[]; total: number } {
  const db = getDatabase();

  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM memory_bank_subscriptions WHERE bank_id = ?
  `).get(bankId) as { count: number };

  const rows = db.prepare(`
    SELECT
      mbs.*,
      a.id as agent_id,
      a.name as agent_name,
      a.description as agent_description,
      a.avatar_url as agent_avatar_url,
      a.karma as agent_karma,
      a.is_verified as agent_is_verified,
      a.created_at as agent_created_at,
      a.account_type as agent_account_type
    FROM memory_bank_subscriptions mbs
    JOIN agents a ON mbs.agent_id = a.id
    WHERE mbs.bank_id = ?
    ORDER BY mbs.subscribed_at DESC
    LIMIT ? OFFSET ?
  `).all(bankId, limit, offset) as Record<string, unknown>[];

  const data = rows.map((row) => ({
    id: row.id as string,
    agent_id: row.agent_id as string,
    bank_id: row.bank_id as string,
    permission: row.permission as MemoryBankPermission,
    subscribed_at: row.subscribed_at as string,
    agent: {
      id: row.agent_id as string,
      name: row.agent_name as string,
      description: row.agent_description as string | null,
      avatar_url: row.agent_avatar_url as string | null,
      karma: row.agent_karma as number,
      is_verified: Boolean(row.agent_is_verified),
      created_at: row.agent_created_at as string,
      account_type: row.agent_account_type as 'agent' | 'human',
    },
  }));

  return { data, total: countRow.count };
}

// ============================================================================
// Tags
// ============================================================================

export function setMemoryBankTags(bankId: string, tags: string[]): void {
  const db = getDatabase();

  // Normalize tags
  const normalizedTags = tags
    .map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter((t) => t.length > 0);

  db.transaction(() => {
    // Remove existing tags
    db.prepare('DELETE FROM memory_bank_tags WHERE bank_id = ?').run(bankId);

    // Add new tags
    const stmt = db.prepare('INSERT INTO memory_bank_tags (bank_id, tag) VALUES (?, ?)');
    for (const tag of normalizedTags) {
      stmt.run(bankId, tag);
    }
  })();
}

export function getMemoryBankTags(bankId: string): string[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT tag FROM memory_bank_tags WHERE bank_id = ?').all(bankId) as { tag: string }[];
  return rows.map((r) => r.tag);
}

// ============================================================================
// Sync Events
// ============================================================================

export interface CreateSyncEventInput {
  bank_id: string;
  commit_hash?: string;
  commit_message?: string;
  pusher?: string;
  files_added?: number;
  files_modified?: number;
  files_removed?: number;
}

export function createSyncEvent(input: CreateSyncEventInput): MemorySyncEvent {
  const db = getDatabase();
  const id = `evt_${nanoid()}`;

  db.prepare(`
    INSERT INTO memory_sync_events (id, bank_id, commit_hash, commit_message, pusher, files_added, files_modified, files_removed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.bank_id,
    input.commit_hash || null,
    input.commit_message || null,
    input.pusher || null,
    input.files_added || 0,
    input.files_modified || 0,
    input.files_removed || 0
  );

  return {
    id,
    bank_id: input.bank_id,
    commit_hash: input.commit_hash || null,
    commit_message: input.commit_message || null,
    pusher: input.pusher || null,
    files_added: input.files_added || 0,
    files_modified: input.files_modified || 0,
    files_removed: input.files_removed || 0,
    timestamp: new Date().toISOString(),
  };
}

export function getSyncEvents(
  bankId: string,
  limit = 50,
  offset = 0
): { data: MemorySyncEvent[]; total: number } {
  const db = getDatabase();

  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM memory_sync_events WHERE bank_id = ?
  `).get(bankId) as { count: number };

  const rows = db.prepare(`
    SELECT * FROM memory_sync_events
    WHERE bank_id = ?
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(bankId, limit, offset) as MemorySyncEvent[];

  return { data: rows, total: countRow.count };
}

// ============================================================================
// Access Control Helpers
// ============================================================================

export function canAccessMemoryBank(agentId: string, bank: MemoryBank): boolean {
  if (bank.visibility === 'public') return true;
  if (bank.owner_agent_id === agentId) return true;

  const sub = getSubscription(agentId, bank.id);
  return sub !== null;
}

export function canModifyMemoryBank(agentId: string, bank: MemoryBank): boolean {
  if (bank.owner_agent_id === agentId) return true;

  const sub = getSubscription(agentId, bank.id);
  return sub !== null && sub.permission === 'admin';
}

export function getAgentPermission(agentId: string, bank: MemoryBank): MemoryBankPermission | null {
  if (bank.owner_agent_id === agentId) return 'admin';

  const sub = getSubscription(agentId, bank.id);
  if (sub) return sub.permission;

  if (bank.visibility === 'public') return 'read';

  return null;
}
