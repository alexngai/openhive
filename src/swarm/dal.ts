/**
 * Hosted Swarms Data Access Layer
 *
 * CRUD operations for hosted swarm records.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../db/index.js';
import type {
  HostedSwarm,
  HostedSwarmKind,
  HostedSwarmState,
  HostingProviderType,
  SwarmProvisionConfig,
} from './types.js';

// ============================================================================
// Helpers
// ============================================================================

export function generateHostedSwarmId(): string {
  return `hswarm_${nanoid(16)}`;
}

function parseRow(row: Record<string, unknown>): HostedSwarm {
  return {
    ...row,
    config: row.config ? JSON.parse(row.config as string) : null,
  } as HostedSwarm;
}

/** Strip resolved_credentials from config before DB persistence (secrets never hit disk) */
function serializeConfig(config: SwarmProvisionConfig): string {
  const { resolved_credentials, ...safe } = config;
  return JSON.stringify(safe);
}

// ============================================================================
// Create
// ============================================================================

export interface CreateHostedSwarmInput {
  provider: HostingProviderType;
  spawned_by: string;
  /** Defaults to 'openswarm' so existing callers keep working unchanged. */
  kind?: HostedSwarmKind;
  assigned_port?: number;
  bootstrap_token_hash?: string;
  config?: SwarmProvisionConfig;
  /**
   * Pre-generated ID. Callers that need the id before persisting (e.g. to
   * bake it into the swarm's data_dir path) generate it via
   * `generateHostedSwarmId()` and pass it in. Omit to let the DAL assign.
   */
  id?: string;
}

export function createHostedSwarm(input: CreateHostedSwarmInput): HostedSwarm {
  const db = getDatabase();
  const id = input.id ?? generateHostedSwarmId();
  const kind: HostedSwarmKind = input.kind ?? 'openswarm';

  db.prepare(`
    INSERT INTO hosted_swarms (id, kind, provider, state, assigned_port, bootstrap_token_hash, config, spawned_by)
    VALUES (?, ?, ?, 'provisioning', ?, ?, ?, ?)
  `).run(
    id,
    kind,
    input.provider,
    input.assigned_port ?? null,
    input.bootstrap_token_hash ?? null,
    input.config ? serializeConfig(input.config) : null,
    input.spawned_by,
  );

  return findHostedSwarmById(id)!;
}

// ============================================================================
// Read
// ============================================================================

export function findHostedSwarmById(id: string): HostedSwarm | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hosted_swarms WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? parseRow(row) : null;
}

export function findHostedSwarmBySwarmId(swarmId: string): HostedSwarm | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hosted_swarms WHERE swarm_id = ?').get(swarmId) as Record<string, unknown> | undefined;
  return row ? parseRow(row) : null;
}

export function findHostedSwarmByBootstrapHash(hash: string): HostedSwarm | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hosted_swarms WHERE bootstrap_token_hash = ?').get(hash) as Record<string, unknown> | undefined;
  return row ? parseRow(row) : null;
}

export interface ListHostedSwarmsOptions {
  state?: HostedSwarmState;
  provider?: HostingProviderType;
  spawned_by?: string;
  limit?: number;
  offset?: number;
}

export function listHostedSwarms(opts: ListHostedSwarmsOptions = {}): { data: HostedSwarm[]; total: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.state) {
    conditions.push('state = ?');
    params.push(opts.state);
  }
  if (opts.provider) {
    conditions.push('provider = ?');
    params.push(opts.provider);
  }
  if (opts.spawned_by) {
    conditions.push('spawned_by = ?');
    params.push(opts.spawned_by);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const total = (db.prepare(`SELECT COUNT(*) as count FROM hosted_swarms ${where}`).get(...params) as { count: number }).count;
  const rows = db.prepare(`SELECT * FROM hosted_swarms ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Record<string, unknown>[];

  return { data: rows.map(parseRow), total };
}

/** Count active (non-stopped, non-failed) hosted swarms */
export function countActiveHostedSwarms(): number {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM hosted_swarms WHERE state NOT IN ('stopped', 'failed')`
  ).get() as { count: number };
  return row.count;
}

// ============================================================================
// Update
// ============================================================================

export interface UpdateHostedSwarmInput {
  swarm_id?: string | null;
  state?: HostedSwarmState;
  pid?: number | null;
  assigned_port?: number | null;
  container_id?: string | null;
  deployment_id?: string | null;
  endpoint?: string | null;
  error?: string | null;
}

export function updateHostedSwarm(id: string, input: UpdateHostedSwarmInput): HostedSwarm | null {
  const db = getDatabase();
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (input.swarm_id !== undefined) {
    sets.push('swarm_id = ?');
    params.push(input.swarm_id);
  }
  if (input.state !== undefined) {
    sets.push('state = ?');
    params.push(input.state);
  }
  if (input.pid !== undefined) {
    sets.push('pid = ?');
    params.push(input.pid);
  }
  if (input.assigned_port !== undefined) {
    sets.push('assigned_port = ?');
    params.push(input.assigned_port);
  }
  if (input.container_id !== undefined) {
    sets.push('container_id = ?');
    params.push(input.container_id);
  }
  if (input.deployment_id !== undefined) {
    sets.push('deployment_id = ?');
    params.push(input.deployment_id);
  }
  if (input.endpoint !== undefined) {
    sets.push('endpoint = ?');
    params.push(input.endpoint);
  }
  if (input.error !== undefined) {
    sets.push('error = ?');
    params.push(input.error);
  }

  params.push(id);
  db.prepare(`UPDATE hosted_swarms SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  return findHostedSwarmById(id);
}

// ============================================================================
// Delete
// ============================================================================

export function deleteHostedSwarm(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM hosted_swarms WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Distinct bootstrap.cwd values across all hosted swarms (any state — even
 * stopped/failed entries are useful for "spawn another swarm with the same
 * project setup"). Ordered most-recently-created first.
 */
export function listKnownBootstrapCwds(limit: number = 50): string[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT json_extract(config, '$.bootstrap.cwd') AS cwd, MAX(created_at) AS created
    FROM hosted_swarms
    WHERE json_extract(config, '$.bootstrap.cwd') IS NOT NULL
    GROUP BY cwd
    ORDER BY created DESC
    LIMIT ?
  `).all(limit) as Array<{ cwd: string | null }>;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const c = (row.cwd ?? '').trim();
    if (!c || c === '.' || c === '..') continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Distinct top-level `config.cwd` values across hosted swarms (TUI kinds
 * and codex-rpc). Counterpart to `listKnownBootstrapCwds` for the newer
 * free-form working-directory field. Same ordering rules (most recent
 * row wins, drop empties / `.` / `..`).
 */
export function listKnownTuiCwds(limit: number = 50): string[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT json_extract(config, '$.cwd') AS cwd, MAX(created_at) AS created
    FROM hosted_swarms
    WHERE json_extract(config, '$.cwd') IS NOT NULL
    GROUP BY cwd
    ORDER BY created DESC
    LIMIT ?
  `).all(limit) as Array<{ cwd: string | null }>;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const c = (row.cwd ?? '').trim();
    if (!c || c === '.' || c === '..') continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/** Get all hosted swarms in active states (for recovery on startup) */
export function getActiveHostedSwarms(): HostedSwarm[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT * FROM hosted_swarms WHERE state IN ('provisioning', 'starting', 'running', 'unhealthy') ORDER BY created_at ASC`
  ).all() as Record<string, unknown>[];
  return rows.map(parseRow);
}
