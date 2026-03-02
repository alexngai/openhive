/**
 * DAL for trajectory checkpoints.
 *
 * Stores checkpoint metadata received via trajectory/checkpoint sync notifications.
 * Each checkpoint is tied to a session syncable_resource.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';

// ============================================================================
// Types
// ============================================================================

export interface CreateTrajectoryCheckpointInput {
  session_resource_id: string;
  checkpoint_id: string;
  commit_hash: string;
  agent: string;
  branch?: string;
  files_touched?: string[];
  checkpoints_count?: number;
  token_usage?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  attribution?: Record<string, unknown>;
  source_swarm_id?: string;
  source_agent_id?: string;
}

export interface TrajectoryCheckpoint {
  id: string;
  session_resource_id: string;
  checkpoint_id: string;
  commit_hash: string;
  agent: string;
  branch: string | null;
  files_touched: string[];
  checkpoints_count: number;
  token_usage: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  attribution: Record<string, unknown> | null;
  source_swarm_id: string | null;
  source_agent_id: string | null;
  synced_at: string;
}

export interface SessionStats {
  total_checkpoints: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_files_touched: number;
  latest_agent: string | null;
  first_synced_at: string | null;
  last_synced_at: string | null;
}

export interface SessionListItem {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  owner_agent_id: string;
  last_commit_hash: string | null;
  last_push_at: string | null;
  total_checkpoints: number;
  total_input_tokens: number;
  total_output_tokens: number;
  latest_agent: string | null;
  last_synced_at: string | null;
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Insert a trajectory checkpoint. Uses INSERT OR IGNORE to dedup on
 * (session_resource_id, checkpoint_id).
 */
export function createTrajectoryCheckpoint(input: CreateTrajectoryCheckpointInput): TrajectoryCheckpoint | null {
  const db = getDatabase();
  const id = nanoid();

  const result = db.prepare(`
    INSERT OR IGNORE INTO trajectory_checkpoints
      (id, session_resource_id, checkpoint_id, commit_hash, agent, branch,
       files_touched, checkpoints_count, token_usage, summary, attribution,
       source_swarm_id, source_agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.session_resource_id,
    input.checkpoint_id,
    input.commit_hash,
    input.agent,
    input.branch ?? null,
    JSON.stringify(input.files_touched ?? []),
    input.checkpoints_count ?? 0,
    input.token_usage ? JSON.stringify(input.token_usage) : null,
    input.summary ? JSON.stringify(input.summary) : null,
    input.attribution ? JSON.stringify(input.attribution) : null,
    input.source_swarm_id ?? null,
    input.source_agent_id ?? null,
  );

  if (result.changes === 0) return null; // Duplicate, ignored

  return getTrajectoryCheckpoint(id);
}

/**
 * Get a single trajectory checkpoint by ID.
 */
export function getTrajectoryCheckpoint(id: string): TrajectoryCheckpoint | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM trajectory_checkpoints WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return parseRow(row);
}

/**
 * List checkpoints for a session resource, ordered by synced_at desc.
 */
export function listCheckpointsForSession(
  sessionResourceId: string,
  limit = 50,
  offset = 0,
): { data: TrajectoryCheckpoint[]; total: number } {
  const db = getDatabase();

  const total = (db.prepare(
    'SELECT COUNT(*) as count FROM trajectory_checkpoints WHERE session_resource_id = ?'
  ).get(sessionResourceId) as { count: number }).count;

  const rows = db.prepare(
    'SELECT * FROM trajectory_checkpoints WHERE session_resource_id = ? ORDER BY synced_at DESC LIMIT ? OFFSET ?'
  ).all(sessionResourceId, limit, offset) as Record<string, unknown>[];

  return { data: rows.map(parseRow), total };
}

/**
 * Aggregate stats for a session resource.
 */
export function getSessionStats(sessionResourceId: string): SessionStats {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT
      COUNT(*) as total_checkpoints,
      MIN(synced_at) as first_synced_at,
      MAX(synced_at) as last_synced_at
    FROM trajectory_checkpoints
    WHERE session_resource_id = ?
  `).get(sessionResourceId) as Record<string, unknown>;

  // Get latest agent
  const latest = db.prepare(
    'SELECT agent FROM trajectory_checkpoints WHERE session_resource_id = ? ORDER BY synced_at DESC LIMIT 1'
  ).get(sessionResourceId) as { agent: string } | undefined;

  // Aggregate tokens and files from all checkpoints
  const allRows = db.prepare(
    'SELECT token_usage, files_touched FROM trajectory_checkpoints WHERE session_resource_id = ?'
  ).all(sessionResourceId) as Array<{ token_usage: string | null; files_touched: string }>;

  let totalInput = 0;
  let totalOutput = 0;
  const allFiles = new Set<string>();

  for (const r of allRows) {
    if (r.token_usage) {
      try {
        const tu = JSON.parse(r.token_usage);
        totalInput += tu.input_tokens || 0;
        totalOutput += tu.output_tokens || 0;
      } catch { /* ignore */ }
    }
    try {
      const files = JSON.parse(r.files_touched) as string[];
      for (const f of files) allFiles.add(f);
    } catch { /* ignore */ }
  }

  return {
    total_checkpoints: (row.total_checkpoints as number) || 0,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_files_touched: allFiles.size,
    latest_agent: latest?.agent ?? null,
    first_synced_at: (row.first_synced_at as string) ?? null,
    last_synced_at: (row.last_synced_at as string) ?? null,
  };
}

/**
 * List all session resources with checkpoint stats, for the sessions list page.
 */
export function listAllSessions(limit = 50, offset = 0): { data: SessionListItem[]; total: number } {
  const db = getDatabase();

  const total = (db.prepare(
    "SELECT COUNT(*) as count FROM syncable_resources WHERE resource_type = 'session'"
  ).get() as { count: number }).count;

  const rows = db.prepare(`
    SELECT
      r.id, r.name, r.description, r.visibility, r.owner_agent_id,
      r.last_commit_hash, r.last_push_at,
      COUNT(tc.id) as total_checkpoints,
      MAX(tc.synced_at) as last_synced_at
    FROM syncable_resources r
    LEFT JOIN trajectory_checkpoints tc ON tc.session_resource_id = r.id
    WHERE r.resource_type = 'session'
    GROUP BY r.id
    ORDER BY COALESCE(tc.synced_at, r.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as Record<string, unknown>[];

  const data: SessionListItem[] = rows.map((row) => {
    // Get latest agent and token totals for each session
    const latestAgent = db.prepare(
      'SELECT agent FROM trajectory_checkpoints WHERE session_resource_id = ? ORDER BY synced_at DESC LIMIT 1'
    ).get(row.id as string) as { agent: string } | undefined;

    const tokenRows = db.prepare(
      'SELECT token_usage FROM trajectory_checkpoints WHERE session_resource_id = ?'
    ).all(row.id as string) as Array<{ token_usage: string | null }>;

    let totalInput = 0;
    let totalOutput = 0;
    for (const r of tokenRows) {
      if (r.token_usage) {
        try {
          const tu = JSON.parse(r.token_usage);
          totalInput += tu.input_tokens || 0;
          totalOutput += tu.output_tokens || 0;
        } catch { /* ignore */ }
      }
    }

    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | null,
      visibility: row.visibility as string,
      owner_agent_id: row.owner_agent_id as string,
      last_commit_hash: row.last_commit_hash as string | null,
      last_push_at: row.last_push_at as string | null,
      total_checkpoints: (row.total_checkpoints as number) || 0,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      latest_agent: latestAgent?.agent ?? null,
      last_synced_at: (row.last_synced_at as string) ?? null,
    };
  });

  return { data, total };
}

// ============================================================================
// Helpers
// ============================================================================

function parseRow(row: Record<string, unknown>): TrajectoryCheckpoint {
  return {
    id: row.id as string,
    session_resource_id: row.session_resource_id as string,
    checkpoint_id: row.checkpoint_id as string,
    commit_hash: row.commit_hash as string,
    agent: row.agent as string,
    branch: row.branch as string | null,
    files_touched: safeParseJSON(row.files_touched as string, []),
    checkpoints_count: row.checkpoints_count as number,
    token_usage: safeParseJSON(row.token_usage as string | null, null),
    summary: safeParseJSON(row.summary as string | null, null),
    attribution: safeParseJSON(row.attribution as string | null, null),
    source_swarm_id: row.source_swarm_id as string | null,
    source_agent_id: row.source_agent_id as string | null,
    synced_at: row.synced_at as string,
  };
}

function safeParseJSON<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
