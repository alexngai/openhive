/**
 * MAP Hub Data Access Layer
 *
 * CRUD operations for MAP swarms, agent nodes, pre-auth keys,
 * swarm-hive memberships, and federation connection logging.
 */

import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import { getDatabase } from '../index.js';
import type {
  MapSwarm,
  MapNode,
  MapSwarmHive,
  MapPreauthKey,
  MapFederationLogEntry,
  RegisterSwarmInput,
  UpdateSwarmInput,
  RegisterNodeInput,
  UpdateNodeInput,
  DiscoverNodesOptions,
  CreatePreauthKeyInput,
  SwarmPeer,
  MapSwarmPublic,
  MapNodePublic,
  FederationConnectionStatus,
} from '../../map/types.js';

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
    metadata: parseJsonField(row.metadata),
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
  input: RegisterSwarmInput
): MapSwarm {
  const db = getDatabase();
  const id = `swarm_${nanoid()}`;

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
  status?: string;
  owner_agent_id?: string;
  limit?: number;
  offset?: number;
} = {}): { data: MapSwarm[]; total: number } {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.status) {
    where.push('s.status = ?');
    params.push(options.status);
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
      state, capabilities, scopes, visibility, metadata, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.swarm_id,
    input.map_agent_id,
    input.name || null,
    input.description || null,
    input.role || null,
    input.state || 'registered',
    input.capabilities ? JSON.stringify(input.capabilities) : null,
    input.scopes ? JSON.stringify(input.scopes) : null,
    input.visibility || 'public',
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.tags ? JSON.stringify(input.tags) : null
  );

  return findNodeById(id)!;
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
  if (input.capabilities !== undefined) { sets.push('capabilities = ?'); values.push(JSON.stringify(input.capabilities)); }
  if (input.scopes !== undefined) { sets.push('scopes = ?'); values.push(JSON.stringify(input.scopes)); }
  if (input.visibility !== undefined) { sets.push('visibility = ?'); values.push(input.visibility); }
  if (input.metadata !== undefined) { sets.push('metadata = ?'); values.push(JSON.stringify(input.metadata)); }
  if (input.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(input.tags)); }

  values.push(id);
  db.prepare(`UPDATE map_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return findNodeById(id);
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
  if (options.tags && options.tags.length > 0) {
    const tagConditions = options.tags.map(() => "n.tags LIKE ?");
    where.push(`(${tagConditions.join(' OR ')})`);
    for (const tag of options.tags) {
      params.push(`%"${tag}"%`);
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
    };
  });
}

// ============================================================================
// Pre-auth Keys
// ============================================================================

export function createPreauthKey(
  createdBy: string,
  input: CreatePreauthKeyInput
): { key: MapPreauthKey; plaintext_key: string } {
  const db = getDatabase();
  const id = `pak_${nanoid()}`;
  const plaintextKey = `ohpak_${nanoid(32)}`;
  const keyHash = hashToken(plaintextKey);

  let expiresAt: string | null = null;
  if (input.expires_in_hours) {
    const date = new Date();
    date.setHours(date.getHours() + input.expires_in_hours);
    expiresAt = date.toISOString();
  }

  db.prepare(`
    INSERT INTO map_preauth_keys (id, key_hash, hive_id, uses_left, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, keyHash, input.hive_id || null, input.uses ?? 1, expiresAt, createdBy);

  const key = findPreauthKeyById(id)!;
  return { key, plaintext_key: plaintextKey };
}

export function findPreauthKeyById(id: string): MapPreauthKey | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM map_preauth_keys WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    id: row.id as string,
    key_hash: row.key_hash as string,
    hive_id: row.hive_id as string | null,
    uses_left: row.uses_left as number,
    expires_at: row.expires_at as string | null,
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    last_used_at: row.last_used_at as string | null,
  };
}

/**
 * Validate and consume a pre-auth key. Returns the key if valid, null otherwise.
 */
export function consumePreauthKey(plaintextKey: string): MapPreauthKey | null {
  const db = getDatabase();
  const keyHash = hashToken(plaintextKey);

  const row = db.prepare(
    'SELECT * FROM map_preauth_keys WHERE key_hash = ?'
  ).get(keyHash) as Record<string, unknown> | undefined;

  if (!row) return null;

  // Check expiry
  if (row.expires_at && new Date(row.expires_at as string) < new Date()) {
    return null;
  }

  // Check uses
  if ((row.uses_left as number) <= 0) {
    return null;
  }

  // Consume one use
  db.prepare(`
    UPDATE map_preauth_keys
    SET uses_left = uses_left - 1, last_used_at = datetime('now')
    WHERE id = ?
  `).run(row.id);

  return {
    id: row.id as string,
    key_hash: row.key_hash as string,
    hive_id: row.hive_id as string | null,
    uses_left: (row.uses_left as number) - 1,
    expires_at: row.expires_at as string | null,
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    last_used_at: new Date().toISOString(),
  };
}

export function listPreauthKeys(options: {
  hive_id?: string;
  limit?: number;
  offset?: number;
} = {}): MapPreauthKey[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.hive_id) {
    where.push('hive_id = ?');
    params.push(options.hive_id);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  const rows = db.prepare(`
    SELECT * FROM map_preauth_keys ${whereClause}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    key_hash: row.key_hash as string,
    hive_id: row.hive_id as string | null,
    uses_left: row.uses_left as number,
    expires_at: row.expires_at as string | null,
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    last_used_at: row.last_used_at as string | null,
  }));
}

export function deletePreauthKey(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM map_preauth_keys WHERE id = ?').run(id);
  return result.changes > 0;
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
  preauth_keys: { total: number; active: number };
} {
  const db = getDatabase();

  const swarmsTotal = (db.prepare('SELECT COUNT(*) as count FROM map_swarms').get() as { count: number }).count;
  const swarmsOnline = (db.prepare("SELECT COUNT(*) as count FROM map_swarms WHERE status = 'online'").get() as { count: number }).count;
  const swarmsOffline = (db.prepare("SELECT COUNT(*) as count FROM map_swarms WHERE status != 'online'").get() as { count: number }).count;

  const nodesTotal = (db.prepare('SELECT COUNT(*) as count FROM map_nodes').get() as { count: number }).count;
  const nodesActive = (db.prepare("SELECT COUNT(*) as count FROM map_nodes WHERE state IN ('active', 'busy', 'idle')").get() as { count: number }).count;

  const hiveMemberships = (db.prepare('SELECT COUNT(*) as count FROM map_swarm_hives').get() as { count: number }).count;

  const keysTotal = (db.prepare('SELECT COUNT(*) as count FROM map_preauth_keys').get() as { count: number }).count;
  const keysActive = (db.prepare("SELECT COUNT(*) as count FROM map_preauth_keys WHERE uses_left > 0 AND (expires_at IS NULL OR expires_at > datetime('now'))").get() as { count: number }).count;

  return {
    swarms: { total: swarmsTotal, online: swarmsOnline, offline: swarmsOffline },
    nodes: { total: nodesTotal, active: nodesActive },
    hive_memberships: hiveMemberships,
    preauth_keys: { total: keysTotal, active: keysActive },
  };
}

// ============================================================================
// Ownership Checks
// ============================================================================

export function isSwarmOwner(swarmId: string, agentId: string): boolean {
  const swarm = findSwarmById(swarmId);
  return swarm !== null && swarm.owner_agent_id === agentId;
}
