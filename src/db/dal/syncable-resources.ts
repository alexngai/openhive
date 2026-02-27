import { nanoid } from 'nanoid';
import { randomBytes } from 'crypto';
import { getDatabase } from '../index.js';
import type {
  SyncableResource,
  ResourceSubscription,
  ResourceSyncEvent,
  SyncableResourceWithMeta,
  ResourceSubscriptionWithAgent,
  SyncableResourceType,
  ResourceVisibility,
  ResourcePermission,
  ResourceScope,
} from '../../types.js';

// Generate a webhook secret
function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

// ============================================================================
// Resource CRUD
// ============================================================================

export interface CreateResourceInput {
  resource_type: SyncableResourceType;
  name: string;
  description?: string;
  git_remote_url: string;
  visibility?: ResourceVisibility;
  owner_agent_id: string;
  scope?: ResourceScope;
  metadata?: Record<string, unknown>;
}

export function createResource(input: CreateResourceInput): SyncableResource {
  const db = getDatabase();
  const id = `res_${nanoid()}`;
  const webhookSecret = generateWebhookSecret();

  db.prepare(`
    INSERT INTO syncable_resources (id, resource_type, name, description, git_remote_url, webhook_secret, visibility, owner_agent_id, scope, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.resource_type,
    input.name,
    input.description || null,
    input.git_remote_url,
    webhookSecret,
    input.visibility || 'private',
    input.owner_agent_id,
    input.scope || 'manual',
    input.metadata ? JSON.stringify(input.metadata) : null
  );

  // Auto-subscribe owner with admin permission
  const subId = nanoid();
  db.prepare(`
    INSERT INTO resource_subscriptions (id, agent_id, resource_id, permission)
    VALUES (?, ?, ?, 'admin')
  `).run(subId, input.owner_agent_id, id);

  return findResourceById(id)!;
}

/**
 * Idempotent upsert for discovered resources.
 * Uses the UNIQUE(owner_agent_id, resource_type, name) constraint.
 * On conflict, updates git_remote_url, description, scope, and metadata.
 * Returns the resource and whether it was newly created.
 */
export function upsertDiscoveredResource(input: CreateResourceInput): { resource: SyncableResource; created: boolean } {
  const db = getDatabase();

  // Check if the resource already exists
  const existing = db.prepare(`
    SELECT id FROM syncable_resources
    WHERE owner_agent_id = ? AND resource_type = ? AND name = ?
  `).get(input.owner_agent_id, input.resource_type, input.name) as { id: string } | undefined;

  if (existing) {
    // Update the existing resource
    db.prepare(`
      UPDATE syncable_resources
      SET git_remote_url = ?, description = ?, scope = ?, metadata = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      input.git_remote_url,
      input.description || null,
      input.scope || 'manual',
      input.metadata ? JSON.stringify(input.metadata) : null,
      existing.id
    );
    return { resource: findResourceById(existing.id)!, created: false };
  }

  // Create new resource
  const resource = createResource(input);
  return { resource, created: true };
}

export function findResourceById(id: string): SyncableResource | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM syncable_resources WHERE id = ?').get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  } as unknown as SyncableResource;
}

export function findResourceByWebhookSecret(secret: string): SyncableResource | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM syncable_resources WHERE webhook_secret = ?').get(secret) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  } as unknown as SyncableResource;
}

/**
 * Normalize a git remote URL to a canonical form for matching.
 */
export function normalizeGitUrl(url: string): string {
  let normalized = url.toLowerCase().trim();
  normalized = normalized.replace(/^(https?:\/\/|git:\/\/|ssh:\/\/)/i, '');
  normalized = normalized.replace(/^git@([^:]+):/, '$1/');
  normalized = normalized.replace(/\.git$/, '');
  normalized = normalized.replace(/\/+$/, '');
  normalized = normalized.replace(/^[^@]+@/, '');
  return normalized;
}

/**
 * Find resources that match a repository URL.
 */
export function findResourcesByRepoUrl(
  repoUrl: string,
  resourceType?: SyncableResourceType
): SyncableResource[] {
  const db = getDatabase();
  const normalizedInput = normalizeGitUrl(repoUrl);

  let query = 'SELECT * FROM syncable_resources';
  const params: unknown[] = [];

  if (resourceType) {
    query += ' WHERE resource_type = ?';
    params.push(resourceType);
  }

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];

  return rows
    .filter((row) => normalizeGitUrl(row.git_remote_url as string) === normalizedInput)
    .map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    }) as unknown as SyncableResource);
}

/**
 * Find a single resource by repository full name
 */
export function findResourceByRepoName(
  fullName: string,
  resourceType?: SyncableResourceType,
  host: string = 'github.com'
): SyncableResource | null {
  const normalizedInput = `${host.toLowerCase()}/${fullName.toLowerCase()}`;
  const resources = findResourcesByRepoUrl(normalizedInput, resourceType);
  return resources.length > 0 ? resources[0] : null;
}

export interface UpdateResourceInput {
  name?: string;
  description?: string;
  git_remote_url?: string;
  visibility?: ResourceVisibility;
  metadata?: Record<string, unknown>;
}

export function updateResource(id: string, input: UpdateResourceInput): SyncableResource | null {
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
  if (input.metadata !== undefined) {
    sets.push('metadata = ?');
    values.push(JSON.stringify(input.metadata));
  }

  values.push(id);

  db.prepare(`UPDATE syncable_resources SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  return findResourceById(id);
}

export function updateResourceSyncState(
  id: string,
  commitHash: string,
  pushBy: string | null
): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE syncable_resources
    SET last_commit_hash = ?, last_push_by = ?, last_push_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(commitHash, pushBy, id);
}

export function regenerateWebhookSecret(id: string): string {
  const db = getDatabase();
  const newSecret = generateWebhookSecret();

  db.prepare(`
    UPDATE syncable_resources SET webhook_secret = ?, updated_at = datetime('now') WHERE id = ?
  `).run(newSecret, id);

  return newSecret;
}

export function deleteResource(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM syncable_resources WHERE id = ?').run(id);
  return result.changes > 0;
}

// ============================================================================
// Resource Queries with Metadata
// ============================================================================

export function getResourceWithMeta(id: string, viewerAgentId?: string): SyncableResourceWithMeta | null {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT
      r.*,
      a.id as owner_id,
      a.name as owner_name,
      a.description as owner_description,
      a.avatar_url as owner_avatar_url,
      a.karma as owner_karma,
      a.is_verified as owner_is_verified,
      a.created_at as owner_created_at,
      a.account_type as owner_account_type,
      (SELECT COUNT(*) FROM resource_subscriptions WHERE resource_id = r.id) as subscriber_count
    FROM syncable_resources r
    JOIN agents a ON r.owner_agent_id = a.id
    WHERE r.id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  // Get tags
  const tags = db.prepare('SELECT tag FROM resource_tags WHERE resource_id = ?').all(id) as { tag: string }[];

  // Get viewer's subscription if authenticated
  let isSubscribed = false;
  let myPermission: ResourcePermission | null = null;

  if (viewerAgentId) {
    const sub = db.prepare(`
      SELECT permission FROM resource_subscriptions WHERE resource_id = ? AND agent_id = ?
    `).get(id, viewerAgentId) as { permission: ResourcePermission } | undefined;

    if (sub) {
      isSubscribed = true;
      myPermission = sub.permission;
    }
  }

  return {
    id: row.id as string,
    resource_type: row.resource_type as SyncableResourceType,
    name: row.name as string,
    description: row.description as string | null,
    git_remote_url: row.git_remote_url as string,
    webhook_secret: row.webhook_secret as string | null,
    visibility: row.visibility as ResourceVisibility,
    last_commit_hash: row.last_commit_hash as string | null,
    last_push_by: row.last_push_by as string | null,
    last_push_at: row.last_push_at as string | null,
    owner_agent_id: row.owner_agent_id as string,
    scope: (row.scope as ResourceScope) || 'manual',
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
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

export interface ListResourcesOptions {
  agentId: string;
  resourceType?: SyncableResourceType;
  owned?: boolean;
  visibility?: ResourceVisibility;
  scope?: ResourceScope;
  limit?: number;
  offset?: number;
}

export function listAccessibleResources(options: ListResourcesOptions): {
  data: SyncableResourceWithMeta[];
  total: number;
} {
  const db = getDatabase();
  const { agentId, resourceType, owned, visibility, scope, limit = 50, offset = 0 } = options;

  // Build query for resources the agent can access
  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (owned) {
    whereClauses.push('r.owner_agent_id = ?');
    params.push(agentId);
  } else {
    // Agent can access: owned resources, subscribed resources, or public resources
    whereClauses.push(`(
      r.owner_agent_id = ?
      OR r.id IN (SELECT resource_id FROM resource_subscriptions WHERE agent_id = ?)
      OR r.visibility = 'public'
    )`);
    params.push(agentId, agentId);
  }

  if (resourceType) {
    whereClauses.push('r.resource_type = ?');
    params.push(resourceType);
  }

  if (visibility) {
    whereClauses.push('r.visibility = ?');
    params.push(visibility);
  }

  if (scope) {
    whereClauses.push('r.scope = ?');
    params.push(scope);
  }

  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Get total count
  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM syncable_resources r ${whereClause}
  `).get(...params) as { count: number };

  // Get paginated results
  const rows = db.prepare(`
    SELECT
      r.*,
      a.id as owner_id,
      a.name as owner_name,
      a.description as owner_description,
      a.avatar_url as owner_avatar_url,
      a.karma as owner_karma,
      a.is_verified as owner_is_verified,
      a.created_at as owner_created_at,
      a.account_type as owner_account_type,
      (SELECT COUNT(*) FROM resource_subscriptions WHERE resource_id = r.id) as subscriber_count,
      (SELECT permission FROM resource_subscriptions WHERE resource_id = r.id AND agent_id = ?) as my_permission
    FROM syncable_resources r
    JOIN agents a ON r.owner_agent_id = a.id
    ${whereClause}
    ORDER BY r.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(agentId, ...params, limit, offset) as Record<string, unknown>[];

  const data = rows.map((row) => {
    const tags = db.prepare('SELECT tag FROM resource_tags WHERE resource_id = ?').all(row.id as string) as { tag: string }[];

    return {
      id: row.id as string,
      resource_type: row.resource_type as SyncableResourceType,
      name: row.name as string,
      description: row.description as string | null,
      git_remote_url: row.git_remote_url as string,
      webhook_secret: row.webhook_secret as string | null,
      visibility: row.visibility as ResourceVisibility,
      last_commit_hash: row.last_commit_hash as string | null,
      last_push_by: row.last_push_by as string | null,
      last_push_at: row.last_push_at as string | null,
      owner_agent_id: row.owner_agent_id as string,
      scope: (row.scope as ResourceScope) || 'manual',
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
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
      my_permission: row.my_permission as ResourcePermission | null,
    };
  });

  return { data, total: countRow.count };
}

export interface DiscoverResourcesOptions {
  resourceType?: SyncableResourceType;
  query?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export function discoverPublicResources(options: DiscoverResourcesOptions): {
  data: SyncableResourceWithMeta[];
  total: number;
} {
  const db = getDatabase();
  const { resourceType, query, tags, limit = 50, offset = 0 } = options;

  const whereClauses: string[] = ["r.visibility = 'public'"];
  const params: unknown[] = [];

  if (resourceType) {
    whereClauses.push('r.resource_type = ?');
    params.push(resourceType);
  }

  if (query) {
    whereClauses.push('(r.name LIKE ? OR r.description LIKE ?)');
    params.push(`%${query}%`, `%${query}%`);
  }

  if (tags && tags.length > 0) {
    const placeholders = tags.map(() => '?').join(', ');
    whereClauses.push(`r.id IN (
      SELECT resource_id FROM resource_tags WHERE tag IN (${placeholders})
      GROUP BY resource_id HAVING COUNT(DISTINCT tag) = ?
    )`);
    params.push(...tags, tags.length);
  }

  const whereClause = `WHERE ${whereClauses.join(' AND ')}`;

  // Get total count
  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM syncable_resources r ${whereClause}
  `).get(...params) as { count: number };

  // Get paginated results
  const rows = db.prepare(`
    SELECT
      r.id, r.resource_type, r.name, r.description, r.visibility,
      r.last_commit_hash, r.last_push_by, r.last_push_at,
      r.owner_agent_id, r.metadata, r.created_at, r.updated_at,
      a.id as owner_id,
      a.name as owner_name,
      a.description as owner_description,
      a.avatar_url as owner_avatar_url,
      a.karma as owner_karma,
      a.is_verified as owner_is_verified,
      a.created_at as owner_created_at,
      a.account_type as owner_account_type,
      (SELECT COUNT(*) FROM resource_subscriptions WHERE resource_id = r.id) as subscriber_count
    FROM syncable_resources r
    JOIN agents a ON r.owner_agent_id = a.id
    ${whereClause}
    ORDER BY subscriber_count DESC, r.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Record<string, unknown>[];

  const data = rows.map((row) => {
    const resourceTags = db.prepare('SELECT tag FROM resource_tags WHERE resource_id = ?').all(row.id as string) as { tag: string }[];

    return {
      id: row.id as string,
      resource_type: row.resource_type as SyncableResourceType,
      name: row.name as string,
      description: row.description as string | null,
      git_remote_url: '', // Don't expose git URL for public discovery
      webhook_secret: null,
      visibility: row.visibility as ResourceVisibility,
      last_commit_hash: row.last_commit_hash as string | null,
      last_push_by: row.last_push_by as string | null,
      last_push_at: row.last_push_at as string | null,
      owner_agent_id: row.owner_agent_id as string,
      scope: (row.scope as ResourceScope) || 'manual',
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
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
      tags: resourceTags.map((t) => t.tag),
      subscriber_count: row.subscriber_count as number,
    };
  });

  return { data, total: countRow.count };
}

// ============================================================================
// Subscriptions
// ============================================================================

export function subscribeToResource(
  agentId: string,
  resourceId: string,
  permission: ResourcePermission = 'read'
): ResourceSubscription | null {
  const db = getDatabase();

  try {
    const id = nanoid();
    db.prepare(`
      INSERT INTO resource_subscriptions (id, agent_id, resource_id, permission)
      VALUES (?, ?, ?, ?)
    `).run(id, agentId, resourceId, permission);

    return {
      id,
      agent_id: agentId,
      resource_id: resourceId,
      permission,
      subscribed_at: new Date().toISOString(),
    };
  } catch {
    // Already subscribed - update permission instead
    db.prepare(`
      UPDATE resource_subscriptions SET permission = ? WHERE agent_id = ? AND resource_id = ?
    `).run(permission, agentId, resourceId);

    const row = db.prepare(`
      SELECT * FROM resource_subscriptions WHERE agent_id = ? AND resource_id = ?
    `).get(agentId, resourceId) as ResourceSubscription | undefined;

    return row || null;
  }
}

export function unsubscribeFromResource(agentId: string, resourceId: string): boolean {
  const db = getDatabase();

  // Don't allow owner to unsubscribe
  const resource = findResourceById(resourceId);
  if (resource && resource.owner_agent_id === agentId) {
    return false;
  }

  const result = db.prepare(`
    DELETE FROM resource_subscriptions WHERE agent_id = ? AND resource_id = ?
  `).run(agentId, resourceId);

  return result.changes > 0;
}

export function getSubscription(agentId: string, resourceId: string): ResourceSubscription | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT * FROM resource_subscriptions WHERE agent_id = ? AND resource_id = ?
  `).get(agentId, resourceId) as ResourceSubscription | undefined;

  return row || null;
}

export function getResourceSubscribers(
  resourceId: string,
  limit = 50,
  offset = 0
): { data: ResourceSubscriptionWithAgent[]; total: number } {
  const db = getDatabase();

  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM resource_subscriptions WHERE resource_id = ?
  `).get(resourceId) as { count: number };

  const rows = db.prepare(`
    SELECT
      rs.*,
      a.id as agent_id,
      a.name as agent_name,
      a.description as agent_description,
      a.avatar_url as agent_avatar_url,
      a.karma as agent_karma,
      a.is_verified as agent_is_verified,
      a.created_at as agent_created_at,
      a.account_type as agent_account_type
    FROM resource_subscriptions rs
    JOIN agents a ON rs.agent_id = a.id
    WHERE rs.resource_id = ?
    ORDER BY rs.subscribed_at DESC
    LIMIT ? OFFSET ?
  `).all(resourceId, limit, offset) as Record<string, unknown>[];

  const data = rows.map((row) => ({
    id: row.id as string,
    agent_id: row.agent_id as string,
    resource_id: row.resource_id as string,
    permission: row.permission as ResourcePermission,
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

export function setResourceTags(resourceId: string, tags: string[]): void {
  const db = getDatabase();

  // Normalize tags
  const normalizedTags = tags
    .map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter((t) => t.length > 0);

  db.transaction(() => {
    // Remove existing tags
    db.prepare('DELETE FROM resource_tags WHERE resource_id = ?').run(resourceId);

    // Add new tags
    const stmt = db.prepare('INSERT INTO resource_tags (resource_id, tag) VALUES (?, ?)');
    for (const tag of normalizedTags) {
      stmt.run(resourceId, tag);
    }
  })();
}

export function getResourceTags(resourceId: string): string[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT tag FROM resource_tags WHERE resource_id = ?').all(resourceId) as { tag: string }[];
  return rows.map((r) => r.tag);
}

// ============================================================================
// Sync Events
// ============================================================================

export interface CreateSyncEventInput {
  resource_id: string;
  commit_hash?: string;
  commit_message?: string;
  pusher?: string;
  files_added?: number;
  files_modified?: number;
  files_removed?: number;
}

export function createSyncEvent(input: CreateSyncEventInput): ResourceSyncEvent {
  const db = getDatabase();
  const id = `evt_${nanoid()}`;

  db.prepare(`
    INSERT INTO resource_sync_events (id, resource_id, commit_hash, commit_message, pusher, files_added, files_modified, files_removed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.resource_id,
    input.commit_hash || null,
    input.commit_message || null,
    input.pusher || null,
    input.files_added || 0,
    input.files_modified || 0,
    input.files_removed || 0
  );

  return {
    id,
    resource_id: input.resource_id,
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
  resourceId: string,
  limit = 50,
  offset = 0
): { data: ResourceSyncEvent[]; total: number } {
  const db = getDatabase();

  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM resource_sync_events WHERE resource_id = ?
  `).get(resourceId) as { count: number };

  const rows = db.prepare(`
    SELECT * FROM resource_sync_events
    WHERE resource_id = ?
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(resourceId, limit, offset) as ResourceSyncEvent[];

  return { data: rows, total: countRow.count };
}

// ============================================================================
// Access Control Helpers
// ============================================================================

export function canAccessResource(agentId: string, resource: SyncableResource): boolean {
  if (resource.visibility === 'public') return true;
  if (resource.owner_agent_id === agentId) return true;

  const sub = getSubscription(agentId, resource.id);
  return sub !== null;
}

export function canModifyResource(agentId: string, resource: SyncableResource): boolean {
  if (resource.owner_agent_id === agentId) return true;

  const sub = getSubscription(agentId, resource.id);
  return sub !== null && sub.permission === 'admin';
}

export function getAgentPermission(agentId: string, resource: SyncableResource): ResourcePermission | null {
  if (resource.owner_agent_id === agentId) return 'admin';

  const sub = getSubscription(agentId, resource.id);
  if (sub) return sub.permission;

  if (resource.visibility === 'public') return 'read';

  return null;
}

// ============================================================================
// Polling Support
// ============================================================================

/**
 * Get resources that an agent can poll for updates.
 * This includes resources the agent owns or has write/admin access to.
 */
export function getAgentPollableResources(
  agentId: string,
  resourceType?: SyncableResourceType
): SyncableResource[] {
  const db = getDatabase();

  let query = `
    SELECT DISTINCT r.* FROM syncable_resources r
    LEFT JOIN resource_subscriptions rs ON r.id = rs.resource_id
    WHERE r.owner_agent_id = ?
       OR (rs.agent_id = ? AND rs.permission IN ('write', 'admin'))
  `;

  const params: unknown[] = [agentId, agentId];

  if (resourceType) {
    query += ' AND r.resource_type = ?';
    params.push(resourceType);
  }

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  }) as unknown as SyncableResource);
}

/**
 * Get specific resources by IDs that an agent can poll.
 */
export function getAgentPollableResourcesByIds(
  agentId: string,
  resourceIds: string[],
  resourceType?: SyncableResourceType
): SyncableResource[] {
  if (resourceIds.length === 0) return [];

  const db = getDatabase();
  const placeholders = resourceIds.map(() => '?').join(', ');

  let query = `
    SELECT DISTINCT r.* FROM syncable_resources r
    LEFT JOIN resource_subscriptions rs ON r.id = rs.resource_id
    WHERE r.id IN (${placeholders})
      AND (
        r.owner_agent_id = ?
        OR (rs.agent_id = ? AND rs.permission IN ('write', 'admin'))
      )
  `;

  const params: unknown[] = [...resourceIds, agentId, agentId];

  if (resourceType) {
    query += ' AND r.resource_type = ?';
    params.push(resourceType);
  }

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  }) as unknown as SyncableResource);
}

/**
 * Check if an agent can poll a specific resource for updates.
 */
export function canPollResource(agentId: string, resource: SyncableResource): boolean {
  if (resource.owner_agent_id === agentId) return true;

  const sub = getSubscription(agentId, resource.id);
  return sub !== null && (sub.permission === 'write' || sub.permission === 'admin');
}

// ============================================================================
// Resource Type Helpers
// ============================================================================

/**
 * Get the WebSocket channel name for a resource
 */
export function getResourceChannel(resource: SyncableResource): string {
  return `resource:${resource.resource_type}:${resource.id}`;
}

/**
 * Get the webhook URL path for a resource
 */
export function getWebhookPath(resourceId: string): string {
  return `/webhooks/resource/${resourceId}`;
}
