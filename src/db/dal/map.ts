/**
 * MAP Hub Data Access Layer
 *
 * CRUD operations for MAP swarms, agent nodes, swarm-hive memberships,
 * and federation connection logging. Preauth keys retired in RFC v4.
 */

import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import { getDatabase } from '../index.js';
import type {
  MapSwarm,
  MapNode,
  MapSwarmHive,
  MapFederationLogEntry,
  RegisterSwarmInput,
  UpdateSwarmInput,
  RegisterNodeInput,
  UpdateNodeInput,
  DiscoverNodesOptions,
  SwarmPeer,
  MapSwarmPublic,
  MapNodePublic,
  FederationConnectionStatus,
} from '../../map/types.js';
import type { WorkspacePolicy } from '../../types.js';

// ============================================================================
// Helpers
// ============================================================================

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseJsonField<T>(value: unknown): T | null {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function rowToSwarm(row: Record<string, unknown>): MapSwarm {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | null,
    map_endpoint: row.map_endpoint as string,
    map_transport: row.map_transport as MapSwarm['map_transport'],
    owner_agent_id: row.owner_agent_id as string,
    status: row.status as MapSwarm['status'],
    last_seen_at: row.last_seen_at as string,
    capabilities: parseJsonField(row.capabilities),
    auth_method: row.auth_method as MapSwarm['auth_method'],
    auth_token_hash: row.auth_token_hash as string | null,
    agent_count: row.agent_count as number,
    scope_count: row.scope_count as number,
    headscale_node_id: row.headscale_node_id as string | null,
    tailscale_ips: parseJsonField(row.tailscale_ips),
    tailscale_dns_name: row.tailscale_dns_name as string | null,
    metadata: parseJsonField(row.metadata),
    archived: !!(row.archived as number),
    canonical_key: (row.canonical_key as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToNode(row: Record<string, unknown>): MapNode {
  return {
    id: row.id as string,
    swarm_id: row.swarm_id as string,
    map_agent_id: row.map_agent_id as string,
    name: row.name as string | null,
    description: row.description as string | null,
    role: row.role as string | null,
    state: row.state as MapNode['state'],
    presence: (row.presence as MapNode['presence']) ?? 'offline',
    capabilities: parseJsonField(row.capabilities),
    scopes: parseJsonField(row.scopes),
    visibility: row.visibility as MapNode['visibility'],
    metadata: parseJsonField(row.metadata),
    tags: parseJsonField(row.tags),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// ============================================================================
// Swarm CRUD
// ============================================================================

export function createSwarm(
  ownerAgentId: string,
  input: RegisterSwarmInput & { id?: string }
): MapSwarm {
  const db = getDatabase();
  const id = input.id || `swarm_${nanoid()}`;

  db.prepare(`
    INSERT INTO map_swarms (id, name, description, map_endpoint, map_transport,
      owner_agent_id, capabilities, auth_method, auth_token_hash, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.description || null,
    input.map_endpoint,
    input.map_transport || 'websocket',
    ownerAgentId,
    input.capabilities ? JSON.stringify(input.capabilities) : null,
    input.auth_method || 'bearer',
    input.auth_token ? hashToken(input.auth_token) : null,
    input.metadata ? JSON.stringify(input.metadata) : null
  );

  return findSwarmById(id)!;
}

export function findSwarmById(id: string): MapSwarm | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM map_swarms WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSwarm(row) : null;
}

export function findSwarmByEndpoint(endpoint: string): MapSwarm | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM map_swarms WHERE map_endpoint = ?').get(endpoint) as Record<string, unknown> | undefined;
  return row ? rowToSwarm(row) : null;
}

/**
 * Read just the workspace_policy JSON for a swarm.
 *
 * Returns `null` for swarms with no policy set (legacy rows or operators
 * who didn't pass `workspace_policy` at spawn). The handler treats `null`
 * as `mode: 'open'` for backwards compatibility.
 *
 * Kept as a separate helper from `findSwarmById` so the policy gate doesn't
 * load the whole MapSwarm row (and so the handler doesn't need to know
 * about MapSwarm at all).
 */
export function findSwarmWorkspacePolicy(swarmId: string): WorkspacePolicy | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT workspace_policy FROM map_swarms WHERE id = ?',
  ).get(swarmId) as { workspace_policy: string | null } | undefined;
  if (!row?.workspace_policy) return null;
  try {
    // Trust the schema validator that wrote the row — `superRefine` in
    // SpawnSwarmSchema rejects malformed policies before they land here.
    return JSON.parse(row.workspace_policy) as WorkspacePolicy;
  } catch {
    return null;
  }
}

/**
 * Update the workspace_policy for a swarm. Pass `null` to clear (revert
 * to "open" by absence of a row). Returns true if the row was found and
 * updated, false if the swarm doesn't exist.
 *
 * Caller is expected to have validated the policy shape with
 * `WorkspacePolicySchema` from `src/api/routes/swarm-hosting.ts` so the
 * mode-specific `superRefine` rules apply uniformly across the
 * spawn-time path and the post-spawn PATCH path.
 */
export function updateSwarmWorkspacePolicy(
  swarmId: string,
  policy: WorkspacePolicy | null,
): boolean {
  const db = getDatabase();
  const json = policy === null ? null : JSON.stringify(policy);
  const result = db.prepare(
    "UPDATE map_swarms SET workspace_policy = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(json, swarmId);
  return result.changes > 0;
}

export function updateSwarm(id: string, input: UpdateSwarmInput): MapSwarm | null {
  const db = getDatabase();
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  if (input.description !== undefined) { sets.push('description = ?'); values.push(input.description); }
  if (input.map_endpoint !== undefined) { sets.push('map_endpoint = ?'); values.push(input.map_endpoint); }
  if (input.map_transport !== undefined) { sets.push('map_transport = ?'); values.push(input.map_transport); }
  if (input.status !== undefined) { sets.push('status = ?'); values.push(input.status); }
  if (input.capabilities !== undefined) { sets.push('capabilities = ?'); values.push(JSON.stringify(input.capabilities)); }
  if (input.auth_method !== undefined) { sets.push('auth_method = ?'); values.push(input.auth_method); }
  if (input.auth_token !== undefined) { sets.push('auth_token_hash = ?'); values.push(hashToken(input.auth_token)); }
  if (input.agent_count !== undefined) { sets.push('agent_count = ?'); values.push(input.agent_count); }
  if (input.scope_count !== undefined) { sets.push('scope_count = ?'); values.push(input.scope_count); }
  if (input.headscale_node_id !== undefined) { sets.push('headscale_node_id = ?'); values.push(input.headscale_node_id); }
  if (input.tailscale_ips !== undefined) { sets.push('tailscale_ips = ?'); values.push(JSON.stringify(input.tailscale_ips)); }
  if (input.tailscale_dns_name !== undefined) { sets.push('tailscale_dns_name = ?'); values.push(input.tailscale_dns_name); }
  if (input.metadata !== undefined) { sets.push('metadata = ?'); values.push(JSON.stringify(input.metadata)); }

  values.push(id);
  db.prepare(`UPDATE map_swarms SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return findSwarmById(id);
}

export function heartbeatSwarm(id: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE map_swarms SET last_seen_at = datetime('now'), status = 'online', updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

export function deleteSwarm(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM map_swarms WHERE id = ?').run(id);
  return result.changes > 0;
}

export function listSwarms(options: {
  hive_id?: string;
  status?: string | string[];
  owner_agent_id?: string;
  include_archived?: boolean;
  limit?: number;
  offset?: number;
} = {}): { data: MapSwarm[]; total: number } {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (!options.include_archived) {
    where.push('s.archived = 0');
  }
  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    where.push(`s.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (options.owner_agent_id) {
    where.push('s.owner_agent_id = ?');
    params.push(options.owner_agent_id);
  }
  if (options.hive_id) {
    where.push('s.id IN (SELECT swarm_id FROM map_swarm_hives WHERE hive_id = ?)');
    params.push(options.hive_id);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM map_swarms s ${whereClause}`
  ).get(...params) as { count: number };

  const rows = db.prepare(
    `SELECT s.* FROM map_swarms s ${whereClause} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return { data: rows.map(rowToSwarm), total: countRow.count };
}

export interface SwarmPickerItem extends MapSwarm {
  variant_count: number;
}

export function listSwarmsForPicker(options: {
  recency_days?: number;
  status?: string[];
  include_archived?: boolean;
} = {}): SwarmPickerItem[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (!options.include_archived) {
    where.push('archived = 0');
  }
  if (options.recency_days) {
    where.push("last_seen_at >= datetime('now', ?)");
    params.push(`-${options.recency_days} days`);
  }
  if (options.status && options.status.length > 0) {
    where.push(`status IN (${options.status.map(() => '?').join(',')})`);
    params.push(...options.status);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT s.*, cnt.variant_count
    FROM map_swarms s
    INNER JOIN (
      SELECT
        MAX(last_seen_at) AS max_seen,
        COALESCE(name, '') AS gn,
        COALESCE(json_extract(metadata, '$.projectPath'), '') AS gp,
        COALESCE(json_extract(metadata, '$.branch'), '') AS gb,
        COUNT(*) AS variant_count
      FROM map_swarms
      ${whereClause}
      GROUP BY gn, gp, gb
    ) cnt
      ON s.last_seen_at = cnt.max_seen
      AND COALESCE(s.name, '') = cnt.gn
      AND COALESCE(json_extract(s.metadata, '$.projectPath'), '') = cnt.gp
      AND COALESCE(json_extract(s.metadata, '$.branch'), '') = cnt.gb
    ${whereClause ? whereClause.replace(/^WHERE/, 'WHERE') : ''}
    ORDER BY s.last_seen_at DESC
  `).all(...params, ...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    ...rowToSwarm(row),
    variant_count: (row.variant_count as number) || 1,
  }));
}

export function findSwarmByCanonicalKey(key: string): MapSwarm | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM map_swarms WHERE canonical_key = ?').get(key) as Record<string, unknown> | undefined;
  return row ? rowToSwarm(row) : null;
}

export function upsertSwarmByCanonicalKey(
  canonicalKey: string,
  ownerAgentId: string,
  input: RegisterSwarmInput & { id?: string },
): MapSwarm {
  const db = getDatabase();
  const existing = findSwarmByCanonicalKey(canonicalKey);

  if (existing) {
    db.prepare(`
      UPDATE map_swarms
      SET name = ?, map_endpoint = ?, map_transport = ?, status = 'online',
          last_seen_at = datetime('now'), capabilities = ?, metadata = ?,
          archived = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      input.name,
      input.map_endpoint,
      input.map_transport || 'websocket',
      input.capabilities ? JSON.stringify(input.capabilities) : existing.capabilities ? JSON.stringify(existing.capabilities) : null,
      input.metadata ? JSON.stringify(input.metadata) : existing.metadata ? JSON.stringify(existing.metadata) : null,
      existing.id,
    );
    return findSwarmById(existing.id)!;
  }

  const id = input.id || `swarm_${nanoid()}`;
  db.prepare(`
    INSERT INTO map_swarms (id, name, description, map_endpoint, map_transport,
      owner_agent_id, capabilities, auth_method, auth_token_hash, metadata, canonical_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.description || null,
    input.map_endpoint,
    input.map_transport || 'websocket',
    ownerAgentId,
    input.capabilities ? JSON.stringify(input.capabilities) : null,
    input.auth_method || 'bearer',
    input.auth_token ? hashToken(input.auth_token) : null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    canonicalKey,
  );
  return findSwarmById(id)!;
}

/**
 * Distinct project paths recorded across all swarms (archived included so a
 * recent project is still suggested even if the swarm went stale). Sorted by
 * most-recently-seen first, deduped, and trimmed of empty / placeholder
 * values like "." or "..". Used by the spawn dialog's project-directory
 * autocomplete in the openhive UI.
 */
export function listKnownProjectPaths(limit: number = 50): string[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT DISTINCT json_extract(metadata, '$.projectPath') AS p,
           MAX(last_seen_at) AS seen
    FROM map_swarms
    WHERE json_extract(metadata, '$.projectPath') IS NOT NULL
    GROUP BY p
    ORDER BY seen DESC
    LIMIT ?
  `).all(limit) as Array<{ p: string | null }>;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const p = (row.p ?? '').trim();
    if (!p || p === '.' || p === '..') continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function archiveStaleSwarms(archiveDays: number = 30): number {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE map_swarms
    SET archived = 1, updated_at = datetime('now')
    WHERE status = 'offline'
      AND archived = 0
      AND last_seen_at < datetime('now', ?)
  `).run(`-${archiveDays} days`);
  return result.changes;
}

/**
 * Get a swarm with its hive memberships for public display
 */
export function getSwarmPublic(id: string): MapSwarmPublic | null {
  const swarm = findSwarmById(id);
  if (!swarm) return null;

  const hives = getSwarmHiveNames(id);

  return {
    id: swarm.id,
    name: swarm.name,
    description: swarm.description,
    map_endpoint: swarm.map_endpoint,
    map_transport: swarm.map_transport,
    status: swarm.status,
    last_seen_at: swarm.last_seen_at,
    capabilities: swarm.capabilities,
    auth_method: swarm.auth_method,
    agent_count: swarm.agent_count,
    scope_count: swarm.scope_count,
    tailscale_ips: swarm.tailscale_ips,
    tailscale_dns_name: swarm.tailscale_dns_name,
    metadata: swarm.metadata,
    hives,
    created_at: swarm.created_at,
  };
}

// ============================================================================
// Node CRUD
// ============================================================================

export function createNode(input: RegisterNodeInput): MapNode {
  const db = getDatabase();
  const id = `node_${nanoid()}`;

  db.prepare(`
    INSERT INTO map_nodes (id, swarm_id, map_agent_id, name, description, role,
      state, presence, capabilities, scopes, visibility, metadata, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.swarm_id,
    input.map_agent_id,
    input.name || null,
    input.description || null,
    input.role || null,
    input.state || 'registered',
    input.presence || 'online',
    input.capabilities ? JSON.stringify(input.capabilities) : null,
    input.scopes ? JSON.stringify(input.scopes) : null,
    input.visibility || 'public',
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.tags ? JSON.stringify(input.tags) : null
  );

  return findNodeById(id)!;
}

/**
 * Idempotently ensure a `map_nodes` row exists with the given id. Used by
 * paths (like the workspace handler + trajectory bootstrap) where
 * `ctx.agentId` is treated as the projected node id but no prior REST-style
 * `createNode` registered the row. Returns silently if a row already
 * exists for this id.
 *
 * Uses `INSERT OR IGNORE` so concurrent callers don't race; the swarm FK
 * still enforces that `swarm_id` is valid.
 *
 * **Partial row caveat.** Rows inserted via this shim populate only:
 * `id`, `swarm_id`, `map_agent_id`, `state='registered'`, `presence='online'`,
 * and (if provided) `name` / `role`. Other columns —
 * `capabilities`, `scopes`, `visibility`, `metadata`, `tags`, `description` —
 * are NULL because the shim doesn't have the registration payload that
 * the explicit `createNode` path receives.
 *
 * Consumers that need the richer fields (e.g. UI agent panels) should
 * fall back to `connection-registry`'s `RegisteredAgent` map for
 * authoritative per-agent capabilities. The shim's job is FK satisfaction,
 * not full projection.
 *
 * If the broader `map/agents/register` path ever projects into `map_nodes`
 * directly, this shim becomes a no-op — see CLAUDE.md "Repos and Workspaces"
 * pending follow-ups.
 */
export function ensureNodeWithId(input: {
  id: string;
  swarm_id: string;
  map_agent_id?: string;
  name?: string;
  role?: string;
}): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO map_nodes (id, swarm_id, map_agent_id, name, role, state, presence)
    VALUES (?, ?, ?, ?, ?, 'registered', 'online')
  `).run(
    input.id,
    input.swarm_id,
    input.map_agent_id ?? input.id,
    input.name ?? null,
    input.role ?? null,
  );
}

export function findNodeById(id: string): MapNode | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM map_nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToNode(row) : null;
}

export function findNodeBySwarmAndAgentId(swarmId: string, mapAgentId: string): MapNode | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM map_nodes WHERE swarm_id = ? AND map_agent_id = ?'
  ).get(swarmId, mapAgentId) as Record<string, unknown> | undefined;
  return row ? rowToNode(row) : null;
}

export function updateNode(id: string, input: UpdateNodeInput): MapNode | null {
  const db = getDatabase();
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  if (input.description !== undefined) { sets.push('description = ?'); values.push(input.description); }
  if (input.role !== undefined) { sets.push('role = ?'); values.push(input.role); }
  if (input.state !== undefined) { sets.push('state = ?'); values.push(input.state); }
  if (input.presence !== undefined) { sets.push('presence = ?'); values.push(input.presence); }
  if (input.capabilities !== undefined) { sets.push('capabilities = ?'); values.push(JSON.stringify(input.capabilities)); }
  if (input.scopes !== undefined) { sets.push('scopes = ?'); values.push(JSON.stringify(input.scopes)); }
  if (input.visibility !== undefined) { sets.push('visibility = ?'); values.push(input.visibility); }
  if (input.metadata !== undefined) { sets.push('metadata = ?'); values.push(JSON.stringify(input.metadata)); }
  if (input.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(input.tags)); }

  values.push(id);
  db.prepare(`UPDATE map_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return findNodeById(id);
}

/**
 * Bulk-flip presence for every node of a swarm. Used on swarm disconnect /
 * heartbeat timeout / markStaleSwarms so the UI immediately stops showing
 * their last-known MAP state as if it were current. Returns rows changed.
 */
export function bulkUpdateSwarmNodesPresence(
  swarmId: string,
  presence: MapNode['presence'],
): number {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE map_nodes
    SET presence = ?, updated_at = datetime('now')
    WHERE swarm_id = ? AND presence != ?
  `).run(presence, swarmId, presence);
  return result.changes;
}

export function deleteNode(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM map_nodes WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteSwarmNodes(swarmId: string): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM map_nodes WHERE swarm_id = ?').run(swarmId);
  return result.changes;
}

/**
 * Discover nodes across swarms with flexible filtering.
 * This is the core discovery endpoint -- the "headscale peer list" equivalent.
 */
export function discoverNodes(options: DiscoverNodesOptions): {
  data: MapNodePublic[];
  total: number;
} {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  // Filter by hive membership (only show nodes from swarms that share a hive)
  if (options.hive_id) {
    where.push('n.swarm_id IN (SELECT swarm_id FROM map_swarm_hives WHERE hive_id = ?)');
    params.push(options.hive_id);
  }

  if (options.swarm_id) {
    where.push('n.swarm_id = ?');
    params.push(options.swarm_id);
  }

  if (options.role) {
    where.push('n.role = ?');
    params.push(options.role);
  }

  if (options.state) {
    where.push('n.state = ?');
    params.push(options.state);
  }

  if (options.visibility) {
    where.push('n.visibility = ?');
    params.push(options.visibility);
  }

  // Tag-based filtering: match nodes where tags JSON array contains any of the requested tags
  // Use json_each to avoid LIKE wildcard injection and JSON escaping issues
  if (options.tags && options.tags.length > 0) {
    const tagPlaceholders = options.tags.map(() => '?').join(', ');
    where.push(`EXISTS (SELECT 1 FROM json_each(n.tags) AS jt WHERE jt.value IN (${tagPlaceholders}))`);
    for (const tag of options.tags) {
      params.push(tag);
    }
  }

  // Only show publicly visible nodes by default
  if (!options.swarm_id) {
    where.push("n.visibility != 'swarm-only'");
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM map_nodes n ${whereClause}`
  ).get(...params) as { count: number };

  const rows = db.prepare(`
    SELECT n.*, s.name as swarm_name
    FROM map_nodes n
    JOIN map_swarms s ON n.swarm_id = s.id
    ${whereClause}
    ORDER BY n.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Record<string, unknown>[];

  const data: MapNodePublic[] = rows.map((row) => ({
    id: row.id as string,
    swarm_id: row.swarm_id as string,
    swarm_name: row.swarm_name as string,
    map_agent_id: row.map_agent_id as string,
    name: row.name as string | null,
    description: row.description as string | null,
    role: row.role as string | null,
    state: row.state as MapNode['state'],
    presence: (row.presence as MapNode['presence']) ?? 'offline',
    capabilities: parseJsonField(row.capabilities),
    scopes: parseJsonField(row.scopes),
    visibility: row.visibility as MapNode['visibility'],
    tags: parseJsonField(row.tags),
    created_at: row.created_at as string,
  }));

  return { data, total: countRow.count };
}

// ============================================================================
// Swarm-Hive Memberships
// ============================================================================

export function joinHive(swarmId: string, hiveId: string): MapSwarmHive {
  const db = getDatabase();
  const id = nanoid();

  db.prepare(`
    INSERT OR IGNORE INTO map_swarm_hives (id, swarm_id, hive_id)
    VALUES (?, ?, ?)
  `).run(id, swarmId, hiveId);

  const row = db.prepare(
    'SELECT * FROM map_swarm_hives WHERE swarm_id = ? AND hive_id = ?'
  ).get(swarmId, hiveId) as Record<string, unknown>;

  return {
    id: row.id as string,
    swarm_id: row.swarm_id as string,
    hive_id: row.hive_id as string,
    joined_at: row.joined_at as string,
  };
}

export function leaveHive(swarmId: string, hiveId: string): boolean {
  const db = getDatabase();
  const result = db.prepare(
    'DELETE FROM map_swarm_hives WHERE swarm_id = ? AND hive_id = ?'
  ).run(swarmId, hiveId);
  return result.changes > 0;
}

export function getSwarmHives(swarmId: string): MapSwarmHive[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM map_swarm_hives WHERE swarm_id = ?'
  ).all(swarmId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    swarm_id: row.swarm_id as string,
    hive_id: row.hive_id as string,
    joined_at: row.joined_at as string,
  }));
}

export function getSwarmHiveNames(swarmId: string): string[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT h.name FROM map_swarm_hives msh
    JOIN hives h ON msh.hive_id = h.id
    WHERE msh.swarm_id = ?
  `).all(swarmId) as { name: string }[];
  return rows.map((r) => r.name);
}

// ============================================================================
// Peer Discovery (headscale-style peer list)
// ============================================================================

/**
 * Get the list of peers for a swarm -- all other swarms that share at least one hive.
 * This is the equivalent of headscale's peer list / DERP map.
 */
export function getPeerList(swarmId: string): SwarmPeer[] {
  const db = getDatabase();

  // Find all swarms that share at least one hive with the requesting swarm
  const rows = db.prepare(`
    SELECT DISTINCT s.*
    FROM map_swarms s
    JOIN map_swarm_hives msh ON s.id = msh.swarm_id
    WHERE msh.hive_id IN (SELECT hive_id FROM map_swarm_hives WHERE swarm_id = ?)
      AND s.id != ?
    ORDER BY s.name
  `).all(swarmId, swarmId) as Record<string, unknown>[];

  return rows.map((row) => {
    // Get shared hive names
    const sharedHives = db.prepare(`
      SELECT h.name FROM map_swarm_hives msh1
      JOIN map_swarm_hives msh2 ON msh1.hive_id = msh2.hive_id
      JOIN hives h ON msh1.hive_id = h.id
      WHERE msh1.swarm_id = ? AND msh2.swarm_id = ?
    `).all(swarmId, row.id as string) as { name: string }[];

    return {
      swarm_id: row.id as string,
      name: row.name as string,
      map_endpoint: row.map_endpoint as string,
      map_transport: row.map_transport as MapSwarm['map_transport'],
      auth_method: row.auth_method as MapSwarm['auth_method'],
      status: row.status as MapSwarm['status'],
      agent_count: row.agent_count as number,
      capabilities: parseJsonField(row.capabilities),
      shared_hives: sharedHives.map((h) => h.name),
      tailscale_ips: parseJsonField(row.tailscale_ips),
      tailscale_dns_name: row.tailscale_dns_name as string | null,
    };
  });
}

// ============================================================================
// Federation Log
// ============================================================================

export function logFederationEvent(
  sourceSwarmId: string | null,
  targetSwarmId: string | null,
  status: FederationConnectionStatus,
  error?: string
): MapFederationLogEntry {
  const db = getDatabase();
  const id = `flog_${nanoid()}`;

  db.prepare(`
    INSERT INTO map_federation_log (id, source_swarm_id, target_swarm_id, status, error)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, sourceSwarmId, targetSwarmId, status, error || null);

  return {
    id,
    source_swarm_id: sourceSwarmId,
    target_swarm_id: targetSwarmId,
    status,
    error: error || null,
    created_at: new Date().toISOString(),
  };
}

export function getFederationLog(options: {
  swarm_id?: string;
  limit?: number;
} = {}): MapFederationLogEntry[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.swarm_id) {
    where.push('(source_swarm_id = ? OR target_swarm_id = ?)');
    params.push(options.swarm_id, options.swarm_id);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit || 100;

  const rows = db.prepare(`
    SELECT * FROM map_federation_log ${whereClause}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    source_swarm_id: row.source_swarm_id as string | null,
    target_swarm_id: row.target_swarm_id as string | null,
    status: row.status as FederationConnectionStatus,
    error: row.error as string | null,
    created_at: row.created_at as string,
  }));
}

// ============================================================================
// Stats
// ============================================================================

export function getMapStats(): {
  swarms: { total: number; online: number; offline: number };
  nodes: { total: number; active: number };
  hive_memberships: number;
} {
  const db = getDatabase();

  const swarmsTotal = (db.prepare('SELECT COUNT(*) as count FROM map_swarms').get() as { count: number }).count;
  const swarmsOnline = (db.prepare("SELECT COUNT(*) as count FROM map_swarms WHERE status = 'online'").get() as { count: number }).count;
  const swarmsOffline = (db.prepare("SELECT COUNT(*) as count FROM map_swarms WHERE status != 'online'").get() as { count: number }).count;

  const nodesTotal = (db.prepare('SELECT COUNT(*) as count FROM map_nodes').get() as { count: number }).count;
  const nodesActive = (db.prepare("SELECT COUNT(*) as count FROM map_nodes WHERE state IN ('active', 'busy', 'idle')").get() as { count: number }).count;

  const hiveMemberships = (db.prepare('SELECT COUNT(*) as count FROM map_swarm_hives').get() as { count: number }).count;

  return {
    swarms: { total: swarmsTotal, online: swarmsOnline, offline: swarmsOffline },
    nodes: { total: nodesTotal, active: nodesActive },
    hive_memberships: hiveMemberships,
  };
}

// ============================================================================
// Ownership Checks
// ============================================================================

export function isSwarmOwner(swarmId: string, agentId: string): boolean {
  const swarm = findSwarmById(swarmId);
  return swarm !== null && swarm.owner_agent_id === agentId;
}

// ============================================================================
// Token Revocation Persistence
// ============================================================================

export function addRevokedToken(agentId: string, reason?: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO map_revoked_tokens (agent_id, reason)
    VALUES (?, ?)
  `).run(agentId, reason || null);
}

export function removeRevokedToken(agentId: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM map_revoked_tokens WHERE agent_id = ?').run(agentId);
}

export function listRevokedTokens(): string[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT agent_id FROM map_revoked_tokens').all() as { agent_id: string }[];
  return rows.map((r) => r.agent_id);
}

/**
 * Find online swarms owned by any of the given agent IDs.
 * Used by the sync relay to map resource subscribers → swarm endpoints.
 */
export function findSwarmsByOwnerAgentIds(agentIds: string[]): MapSwarm[] {
  if (agentIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = agentIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT * FROM map_swarms
    WHERE owner_agent_id IN (${placeholders})
      AND status = 'online'
  `).all(...agentIds) as Record<string, unknown>[];
  return rows.map(rowToSwarm);
}
