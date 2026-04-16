/**
 * DAL for cascade projections.
 *
 * Hub-local lightweight projections over events emitted by git-cascade-backed
 * runtimes via the `x-cascade/*` MAP vendor extension. The hub is NOT the
 * authority on cascade state — runtimes own their local `.git-cascade/tracker.db`.
 * These tables are read-only lenses for cross-swarm observability, REST
 * queries, and cross-reference with OpenTasks task resources.
 *
 * Idempotency:
 *   - streams unique on (source_swarm_id, stream_id)
 *   - changes unique on (stream_row_id, commit_hash)
 *   - merges unique on (source_swarm_id, merge_commit)
 *   - conflicts unique on (stream_row_id, conflict_id)
 *
 * All writes use INSERT OR IGNORE so replayed or duplicated events are safe.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';

// ============================================================================
// Row shapes
// ============================================================================

export interface CascadeStream {
  id: string;
  stream_id: string;
  source_swarm_id: string;
  source_agent_id: string;
  parent_stream_id: string | null;
  name: string;
  branch_name: string | null;
  base_commit: string | null;
  status: string;
  is_local_mode: boolean;
  task_resource_id: string | null;
  task_node_id: string | null;
  metadata: Record<string, unknown> | null;
  publish_branch: string | null;
  opened_at: string;
  last_event_at: string;
  closed_at: string | null;
}

export interface CascadeChange {
  id: string;
  stream_row_id: string;
  change_id: string | null;
  commit_hash: string;
  parent_commit: string | null;
  author_agent_id: string | null;
  message_summary: string | null;
  files_touched: string[];
  task_resource_id: string | null;
  task_node_id: string | null;
  metadata: Record<string, unknown> | null;
  synced_at: string;
}

export interface CascadeMerge {
  id: string;
  source_stream_row_id: string | null;
  target_stream_row_id: string | null;
  source_swarm_id: string;
  source_stream_id: string;
  target_stream_id: string;
  merge_commit: string;
  agent_id: string | null;
  strategy: string | null;
  source_commit: string | null;
  metadata: Record<string, unknown> | null;
  merged_at: string;
}

export interface CascadeConflict {
  id: string;
  stream_row_id: string;
  conflict_id: string | null;
  conflicted_files: string[];
  agent_id: string | null;
  conflicting_commit: string | null;
  target_commit: string | null;
  source: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  detected_at: string;
  resolved_at: string | null;
}

export interface MarkConflictResolvedInput {
  source_swarm_id: string;
  stream_id: string;
  conflict_id: string;
  resolution_method: string;
  resolved_by?: string;
  resolution_summary?: string;
}

export interface CascadeCommitRange {
  stream_row_id: string;
  stream_id: string;
  source_swarm_id: string;
  source_agent_id: string;
  first_commit: string | null;
  last_commit: string | null;
  change_ids: string[];
  commits: Array<{
    commit_hash: string;
    change_id: string | null;
    message_summary: string | null;
    author_agent_id: string | null;
    files_touched: string[];
    synced_at: string;
  }>;
  files_union: string[];
  merge_commit: string | null;
  merge_target: string | null;
}

// ============================================================================
// Upsert inputs
// ============================================================================

export interface UpsertStreamInput {
  stream_id: string;
  source_swarm_id: string;
  source_agent_id: string;
  name: string;
  branch_name?: string;
  base_commit?: string;
  parent_stream_id?: string;
  is_local_mode?: boolean;
  task_resource_id?: string;
  task_node_id?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordCommitInput {
  stream_row_id: string;
  commit_hash: string;
  change_id?: string;
  parent_commit?: string;
  author_agent_id?: string;
  message_summary?: string;
  files_touched?: string[];
  task_resource_id?: string;
  task_node_id?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordMergeInput {
  source_swarm_id: string;
  source_stream_id: string;
  target_stream_id: string;
  merge_commit: string;
  source_stream_row_id?: string;
  target_stream_row_id?: string;
  agent_id?: string;
  strategy?: string;
  source_commit?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordConflictInput {
  stream_row_id: string;
  conflicted_files: string[];
  conflict_id?: string;
  agent_id?: string;
  conflicting_commit?: string;
  target_commit?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordCascadeOperationInput {
  source_swarm_id: string;
  root_stream_id: string;
  root_stream_row_id?: string;
  agent_id?: string;
  strategy: string;
  updated_streams: string[];
  failed_streams: Array<{ stream_id: string; reason: string }>;
  skipped_streams: string[];
  deferred_streams?: string[];
  metadata?: Record<string, unknown>;
}

export interface CascadeOperation {
  id: string;
  source_swarm_id: string;
  root_stream_row_id: string | null;
  root_stream_id: string;
  agent_id: string | null;
  strategy: string;
  updated_streams: string[];
  failed_streams: Array<{ stream_id: string; reason: string }>;
  skipped_streams: string[];
  deferred_streams: string[] | null;
  metadata: Record<string, unknown> | null;
  completed_at: string;
}

// ============================================================================
// Row conversion
// ============================================================================

type Row = Record<string, unknown>;

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function rowToStream(row: Row): CascadeStream {
  return {
    id: row.id as string,
    stream_id: row.stream_id as string,
    source_swarm_id: row.source_swarm_id as string,
    source_agent_id: row.source_agent_id as string,
    parent_stream_id: (row.parent_stream_id as string | null) ?? null,
    name: row.name as string,
    branch_name: (row.branch_name as string | null) ?? null,
    base_commit: (row.base_commit as string | null) ?? null,
    status: row.status as string,
    is_local_mode: Boolean(row.is_local_mode),
    task_resource_id: (row.task_resource_id as string | null) ?? null,
    task_node_id: (row.task_node_id as string | null) ?? null,
    metadata: parseJsonObject(row.metadata),
    publish_branch: (row.publish_branch as string | null) ?? null,
    opened_at: row.opened_at as string,
    last_event_at: row.last_event_at as string,
    closed_at: (row.closed_at as string | null) ?? null,
  };
}

function rowToChange(row: Row): CascadeChange {
  return {
    id: row.id as string,
    stream_row_id: row.stream_row_id as string,
    change_id: (row.change_id as string | null) ?? null,
    commit_hash: row.commit_hash as string,
    parent_commit: (row.parent_commit as string | null) ?? null,
    author_agent_id: (row.author_agent_id as string | null) ?? null,
    message_summary: (row.message_summary as string | null) ?? null,
    files_touched: parseJsonArray(row.files_touched),
    task_resource_id: (row.task_resource_id as string | null) ?? null,
    task_node_id: (row.task_node_id as string | null) ?? null,
    metadata: parseJsonObject(row.metadata),
    synced_at: row.synced_at as string,
  };
}

function rowToMerge(row: Row): CascadeMerge {
  return {
    id: row.id as string,
    source_stream_row_id: (row.source_stream_row_id as string | null) ?? null,
    target_stream_row_id: (row.target_stream_row_id as string | null) ?? null,
    source_swarm_id: row.source_swarm_id as string,
    source_stream_id: row.source_stream_id as string,
    target_stream_id: row.target_stream_id as string,
    merge_commit: row.merge_commit as string,
    agent_id: (row.agent_id as string | null) ?? null,
    strategy: (row.strategy as string | null) ?? null,
    source_commit: (row.source_commit as string | null) ?? null,
    metadata: parseJsonObject(row.metadata),
    merged_at: row.merged_at as string,
  };
}

function rowToConflict(row: Row): CascadeConflict {
  return {
    id: row.id as string,
    stream_row_id: row.stream_row_id as string,
    conflict_id: (row.conflict_id as string | null) ?? null,
    conflicted_files: parseJsonArray(row.conflicted_files),
    agent_id: (row.agent_id as string | null) ?? null,
    conflicting_commit: (row.conflicting_commit as string | null) ?? null,
    target_commit: (row.target_commit as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    status: row.status as string,
    metadata: parseJsonObject(row.metadata),
    detected_at: row.detected_at as string,
    resolved_at: (row.resolved_at as string | null) ?? null,
  };
}

// ============================================================================
// Stream operations
// ============================================================================

/**
 * Upsert a cascade stream projection.
 *
 * Idempotent on (source_swarm_id, stream_id). If a row already exists,
 * updates the provided fields (name, branch_name, base_commit, parent_stream_id,
 * task_ref, metadata, last_event_at) rather than creating a duplicate. This
 * supports out-of-order events (e.g., stream.committed arriving before
 * stream.opened) and backfill of task_ref once it becomes known.
 *
 * Returns the row (existing or newly created) and whether it was created.
 */
export function upsertStream(input: UpsertStreamInput): {
  stream: CascadeStream;
  created: boolean;
} {
  const db = getDatabase();
  const existing = db
    .prepare(
      `SELECT * FROM cascade_streams WHERE source_swarm_id = ? AND stream_id = ?`
    )
    .get(input.source_swarm_id, input.stream_id) as Row | undefined;

  if (existing) {
    // Update mutable fields; preserve stream id + swarm id.
    db.prepare(
      `UPDATE cascade_streams
       SET name = COALESCE(?, name),
           branch_name = COALESCE(?, branch_name),
           base_commit = COALESCE(?, base_commit),
           parent_stream_id = COALESCE(?, parent_stream_id),
           is_local_mode = COALESCE(?, is_local_mode),
           task_resource_id = COALESCE(?, task_resource_id),
           task_node_id = COALESCE(?, task_node_id),
           metadata = COALESCE(?, metadata),
           last_event_at = datetime('now')
       WHERE id = ?`
    ).run(
      input.name,
      input.branch_name ?? null,
      input.base_commit ?? null,
      input.parent_stream_id ?? null,
      input.is_local_mode === undefined ? null : input.is_local_mode ? 1 : 0,
      input.task_resource_id ?? null,
      input.task_node_id ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      existing.id
    );
    const refreshed = db
      .prepare(`SELECT * FROM cascade_streams WHERE id = ?`)
      .get(existing.id) as Row;
    return { stream: rowToStream(refreshed), created: false };
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO cascade_streams (
      id, stream_id, source_swarm_id, source_agent_id, parent_stream_id,
      name, branch_name, base_commit, status, is_local_mode,
      task_resource_id, task_node_id, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
  ).run(
    id,
    input.stream_id,
    input.source_swarm_id,
    input.source_agent_id,
    input.parent_stream_id ?? null,
    input.name,
    input.branch_name ?? null,
    input.base_commit ?? null,
    input.is_local_mode ? 1 : 0,
    input.task_resource_id ?? null,
    input.task_node_id ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null
  );

  const row = db.prepare(`SELECT * FROM cascade_streams WHERE id = ?`).get(id) as Row;
  return { stream: rowToStream(row), created: true };
}

/**
 * Find an existing stream row by (source_swarm_id, stream_id), or create a
 * minimal placeholder row if none exists. Used when a commit/merge/conflict
 * event arrives before the stream.opened event.
 */
export function ensureStreamRow(
  source_swarm_id: string,
  stream_id: string,
  source_agent_id: string
): CascadeStream {
  const { stream } = upsertStream({
    stream_id,
    source_swarm_id,
    source_agent_id,
    name: stream_id,
  });
  return stream;
}

/** Mark a stream as closed (merged, abandoned, or conflicted). */
export function updateStreamStatus(
  stream_row_id: string,
  status: string,
  options?: { closed?: boolean }
): void {
  const db = getDatabase();
  const closedClause = options?.closed ? `, closed_at = datetime('now')` : '';
  db.prepare(
    `UPDATE cascade_streams
     SET status = ?, last_event_at = datetime('now')${closedClause}
     WHERE id = ?`
  ).run(status, stream_row_id);
}

export function getStreamByRowId(stream_row_id: string): CascadeStream | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM cascade_streams WHERE id = ?`)
    .get(stream_row_id) as Row | undefined;
  return row ? rowToStream(row) : null;
}

export function getStreamBySwarmAndId(
  source_swarm_id: string,
  stream_id: string
): CascadeStream | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM cascade_streams WHERE source_swarm_id = ? AND stream_id = ?`
    )
    .get(source_swarm_id, stream_id) as Row | undefined;
  return row ? rowToStream(row) : null;
}

export interface ListStreamsOptions {
  source_swarm_id?: string;
  source_agent_id?: string;
  status?: string;
  task_resource_id?: string;
  task_node_id?: string;
  limit?: number;
  offset?: number;
}

export function listStreams(options: ListStreamsOptions = {}): {
  streams: CascadeStream[];
  total: number;
} {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.source_swarm_id) {
    where.push('source_swarm_id = ?');
    params.push(options.source_swarm_id);
  }
  if (options.source_agent_id) {
    where.push('source_agent_id = ?');
    params.push(options.source_agent_id);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.task_resource_id) {
    where.push('task_resource_id = ?');
    params.push(options.task_resource_id);
  }
  if (options.task_node_id) {
    where.push('task_node_id = ?');
    params.push(options.task_node_id);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = db
    .prepare(`SELECT COUNT(*) as c FROM cascade_streams ${whereSql}`)
    .get(...params) as { c: number };

  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const rows = db
    .prepare(
      `SELECT * FROM cascade_streams ${whereSql}
       ORDER BY last_event_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Row[];

  return {
    streams: rows.map(rowToStream),
    total: totalRow.c,
  };
}

// ============================================================================
// Change operations
// ============================================================================

/**
 * Record a commit against a stream. Idempotent on (stream_row_id, commit_hash).
 * Returns the change row and whether it was newly inserted.
 */
export function recordCommit(input: RecordCommitInput): {
  change: CascadeChange;
  created: boolean;
} {
  const db = getDatabase();
  const existing = db
    .prepare(
      `SELECT * FROM cascade_changes WHERE stream_row_id = ? AND commit_hash = ?`
    )
    .get(input.stream_row_id, input.commit_hash) as Row | undefined;

  if (existing) {
    return { change: rowToChange(existing), created: false };
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO cascade_changes (
      id, stream_row_id, change_id, commit_hash, parent_commit,
      author_agent_id, message_summary, files_touched,
      task_resource_id, task_node_id, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.stream_row_id,
    input.change_id ?? null,
    input.commit_hash,
    input.parent_commit ?? null,
    input.author_agent_id ?? null,
    input.message_summary ?? null,
    JSON.stringify(input.files_touched ?? []),
    input.task_resource_id ?? null,
    input.task_node_id ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null
  );

  // Bump the stream's last_event_at so list queries surface active streams.
  db.prepare(
    `UPDATE cascade_streams SET last_event_at = datetime('now') WHERE id = ?`
  ).run(input.stream_row_id);

  const row = db.prepare(`SELECT * FROM cascade_changes WHERE id = ?`).get(id) as Row;
  return { change: rowToChange(row), created: true };
}

export function listChangesForStream(
  stream_row_id: string,
  options: { limit?: number; offset?: number } = {}
): CascadeChange[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM cascade_changes
       WHERE stream_row_id = ?
       ORDER BY synced_at ASC
       LIMIT ? OFFSET ?`
    )
    .all(stream_row_id, options.limit ?? 100, options.offset ?? 0) as Row[];
  return rows.map(rowToChange);
}

// ============================================================================
// Merge operations
// ============================================================================

/**
 * Record a merge. Idempotent on (source_swarm_id, merge_commit).
 */
export function recordMerge(input: RecordMergeInput): {
  merge: CascadeMerge;
  created: boolean;
} {
  const db = getDatabase();
  const existing = db
    .prepare(
      `SELECT * FROM cascade_merges WHERE source_swarm_id = ? AND merge_commit = ?`
    )
    .get(input.source_swarm_id, input.merge_commit) as Row | undefined;

  if (existing) {
    return { merge: rowToMerge(existing), created: false };
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO cascade_merges (
      id, source_stream_row_id, target_stream_row_id, source_swarm_id,
      source_stream_id, target_stream_id, merge_commit, agent_id,
      strategy, source_commit, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.source_stream_row_id ?? null,
    input.target_stream_row_id ?? null,
    input.source_swarm_id,
    input.source_stream_id,
    input.target_stream_id,
    input.merge_commit,
    input.agent_id ?? null,
    input.strategy ?? null,
    input.source_commit ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null
  );

  const row = db.prepare(`SELECT * FROM cascade_merges WHERE id = ?`).get(id) as Row;
  return { merge: rowToMerge(row), created: true };
}

// ============================================================================
// Conflict operations
// ============================================================================

/**
 * Record a conflict. When conflict_id is provided, idempotent on
 * (stream_row_id, conflict_id). When omitted, always inserts a new row
 * (anonymous conflicts cannot be deduped).
 */
export function recordConflict(input: RecordConflictInput): {
  conflict: CascadeConflict;
  created: boolean;
} {
  const db = getDatabase();

  if (input.conflict_id) {
    const existing = db
      .prepare(
        `SELECT * FROM cascade_conflicts WHERE stream_row_id = ? AND conflict_id = ?`
      )
      .get(input.stream_row_id, input.conflict_id) as Row | undefined;
    if (existing) {
      return { conflict: rowToConflict(existing), created: false };
    }
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO cascade_conflicts (
      id, stream_row_id, conflict_id, conflicted_files, agent_id,
      conflicting_commit, target_commit, source, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.stream_row_id,
    input.conflict_id ?? null,
    JSON.stringify(input.conflicted_files),
    input.agent_id ?? null,
    input.conflicting_commit ?? null,
    input.target_commit ?? null,
    input.source ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null
  );

  const row = db.prepare(`SELECT * FROM cascade_conflicts WHERE id = ?`).get(id) as Row;
  return { conflict: rowToConflict(row), created: true };
}

function rowToCascadeOperation(row: Row): CascadeOperation {
  return {
    id: row.id as string,
    source_swarm_id: row.source_swarm_id as string,
    root_stream_row_id: (row.root_stream_row_id as string | null) ?? null,
    root_stream_id: row.root_stream_id as string,
    agent_id: (row.agent_id as string | null) ?? null,
    strategy: row.strategy as string,
    updated_streams: parseJsonArray(row.updated_streams),
    failed_streams: (() => {
      const parsed = parseJsonObject(row.failed_streams as unknown);
      // failed_streams is stored as a JSON array; parseJsonObject returns
      // null for arrays (since the helper assumes object). Fall back to a
      // direct parse with array typing.
      try {
        const arr = JSON.parse((row.failed_streams as string) || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch {
        return parsed ? [] : [];
      }
    })(),
    skipped_streams: parseJsonArray(row.skipped_streams),
    deferred_streams: row.deferred_streams
      ? parseJsonArray(row.deferred_streams)
      : null,
    metadata: parseJsonObject(row.metadata),
    completed_at: row.completed_at as string,
  };
}

/**
 * Append a row to the cascade_operations audit log. Always inserts (no
 * idempotency key) — each cascade.completed event is a distinct walk.
 */
export function recordCascadeOperation(input: RecordCascadeOperationInput): CascadeOperation {
  const db = getDatabase();
  const id = nanoid();
  db.prepare(
    `INSERT INTO cascade_operations (
      id, source_swarm_id, root_stream_row_id, root_stream_id, agent_id,
      strategy, updated_streams, failed_streams, skipped_streams,
      deferred_streams, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.source_swarm_id,
    input.root_stream_row_id ?? null,
    input.root_stream_id,
    input.agent_id ?? null,
    input.strategy,
    JSON.stringify(input.updated_streams),
    JSON.stringify(input.failed_streams),
    JSON.stringify(input.skipped_streams),
    input.deferred_streams ? JSON.stringify(input.deferred_streams) : null,
    input.metadata ? JSON.stringify(input.metadata) : null
  );
  const row = db.prepare(`SELECT * FROM cascade_operations WHERE id = ?`).get(id) as Row;
  return rowToCascadeOperation(row);
}

export function listCascadeOperations(options: {
  source_swarm_id?: string;
  root_stream_row_id?: string;
  limit?: number;
  offset?: number;
} = {}): CascadeOperation[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.source_swarm_id) {
    where.push('source_swarm_id = ?');
    params.push(options.source_swarm_id);
  }
  if (options.root_stream_row_id) {
    where.push('root_stream_row_id = ?');
    params.push(options.root_stream_row_id);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const offset = Math.max(0, options.offset ?? 0);
  const rows = db
    .prepare(
      `SELECT * FROM cascade_operations ${whereSql}
       ORDER BY completed_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Row[];
  return rows.map(rowToCascadeOperation);
}

/**
 * Mark a conflict as resolved (via stream.conflict_resolved event). Updates
 * the existing row in-place; if the conflict isn't found (event arrived
 * before the conflict was projected, or stream.conflicted was missed),
 * silently returns false so callers can decide how to react.
 */
export function markConflictResolved(input: MarkConflictResolvedInput): boolean {
  const db = getDatabase();
  // Resolve via stream + conflict_id, scoped to the swarm.
  const row = db
    .prepare(
      `SELECT c.* FROM cascade_conflicts c
       JOIN cascade_streams s ON s.id = c.stream_row_id
       WHERE s.source_swarm_id = ?
         AND s.stream_id = ?
         AND c.conflict_id = ?`
    )
    .get(input.source_swarm_id, input.stream_id, input.conflict_id) as Row | undefined;
  if (!row) return false;

  // Stash resolution context in metadata so listings/UIs can show how it
  // was resolved without a separate column.
  const existingMeta = parseJsonObject(row.metadata) ?? {};
  const newMeta = {
    ...existingMeta,
    resolution_method: input.resolution_method,
    resolved_by: input.resolved_by,
    resolution_summary: input.resolution_summary,
  };

  db.prepare(
    `UPDATE cascade_conflicts
     SET status = 'resolved', resolved_at = datetime('now'), metadata = ?
     WHERE id = ?`
  ).run(JSON.stringify(newMeta), row.id);
  return true;
}

// ============================================================================
// Pushes (trunk-style remote pushes from direct-push / optimistic-push)
// ============================================================================

export interface CascadePush {
  id: string;
  source_swarm_id: string;
  stream_row_id: string | null;
  stream_id: string;
  agent_id: string | null;
  pushed_commit: string;
  remote: string;
  remote_ref: string;
  strategy: string | null;
  metadata: Record<string, unknown> | null;
  pushed_at: string;
}

export interface RecordPushInput {
  source_swarm_id: string;
  stream_row_id?: string;
  stream_id: string;
  agent_id?: string;
  pushed_commit: string;
  remote: string;
  remote_ref: string;
  strategy?: string;
  metadata?: Record<string, unknown>;
}

function rowToPush(row: Row): CascadePush {
  return {
    id: row.id as string,
    source_swarm_id: row.source_swarm_id as string,
    stream_row_id: (row.stream_row_id as string | null) ?? null,
    stream_id: row.stream_id as string,
    agent_id: (row.agent_id as string | null) ?? null,
    pushed_commit: row.pushed_commit as string,
    remote: row.remote as string,
    remote_ref: row.remote_ref as string,
    strategy: (row.strategy as string | null) ?? null,
    metadata: parseJsonObject(row.metadata),
    pushed_at: row.pushed_at as string,
  };
}

export function recordPush(input: RecordPushInput): CascadePush {
  const db = getDatabase();
  const id = nanoid();
  db.prepare(
    `INSERT INTO cascade_pushes (
      id, source_swarm_id, stream_row_id, stream_id, agent_id,
      pushed_commit, remote, remote_ref, strategy, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.source_swarm_id,
    input.stream_row_id ?? null,
    input.stream_id,
    input.agent_id ?? null,
    input.pushed_commit,
    input.remote,
    input.remote_ref,
    input.strategy ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null
  );
  const row = db.prepare(`SELECT * FROM cascade_pushes WHERE id = ?`).get(id) as Row;
  return rowToPush(row);
}

export function listPushes(options: {
  source_swarm_id?: string;
  stream_row_id?: string;
  limit?: number;
  offset?: number;
} = {}): CascadePush[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.source_swarm_id) {
    where.push('source_swarm_id = ?');
    params.push(options.source_swarm_id);
  }
  if (options.stream_row_id) {
    where.push('stream_row_id = ?');
    params.push(options.stream_row_id);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const offset = Math.max(0, options.offset ?? 0);
  const rows = db
    .prepare(
      `SELECT * FROM cascade_pushes ${whereSql}
       ORDER BY pushed_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Row[];
  return rows.map(rowToPush);
}

// ============================================================================
// Queue entries (merge queue projection: queue.added/ready/cancelled/removed)
// ============================================================================

export interface CascadeQueueEntry {
  id: string;
  source_swarm_id: string;
  entry_id: string;
  stream_row_id: string | null;
  stream_id: string;
  target_branch: string;
  status: string;
  reason: string | null;
  outcome: string | null;
  metadata: Record<string, unknown> | null;
  added_at: string;
  updated_at: string;
}

function rowToQueueEntry(row: Row): CascadeQueueEntry {
  return {
    id: row.id as string,
    source_swarm_id: row.source_swarm_id as string,
    entry_id: row.entry_id as string,
    stream_row_id: (row.stream_row_id as string | null) ?? null,
    stream_id: row.stream_id as string,
    target_branch: row.target_branch as string,
    status: row.status as string,
    reason: (row.reason as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    metadata: parseJsonObject(row.metadata),
    added_at: row.added_at as string,
    updated_at: row.updated_at as string,
  };
}

export interface UpsertQueueEntryInput {
  source_swarm_id: string;
  entry_id: string;
  stream_id: string;
  stream_row_id?: string;
  target_branch: string;
  status: 'queued' | 'ready' | 'cancelled' | 'removed';
  reason?: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Upsert a queue entry. Idempotent on (source_swarm_id, entry_id). Status
 * transitions follow the natural ordering queued → ready → removed; cancelled
 * is terminal. We trust the latest event over older state.
 */
export function upsertQueueEntry(input: UpsertQueueEntryInput): CascadeQueueEntry {
  const db = getDatabase();
  const existing = db
    .prepare(
      `SELECT * FROM cascade_queue_entries WHERE source_swarm_id = ? AND entry_id = ?`
    )
    .get(input.source_swarm_id, input.entry_id) as Row | undefined;

  if (existing) {
    db.prepare(
      `UPDATE cascade_queue_entries
       SET status = ?,
           reason = COALESCE(?, reason),
           outcome = COALESCE(?, outcome),
           metadata = COALESCE(?, metadata),
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      input.status,
      input.reason ?? null,
      input.outcome ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      existing.id
    );
    const row = db
      .prepare(`SELECT * FROM cascade_queue_entries WHERE id = ?`)
      .get(existing.id) as Row;
    return rowToQueueEntry(row);
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO cascade_queue_entries (
      id, source_swarm_id, entry_id, stream_row_id, stream_id, target_branch,
      status, reason, outcome, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.source_swarm_id,
    input.entry_id,
    input.stream_row_id ?? null,
    input.stream_id,
    input.target_branch,
    input.status,
    input.reason ?? null,
    input.outcome ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null
  );
  const row = db
    .prepare(`SELECT * FROM cascade_queue_entries WHERE id = ?`)
    .get(id) as Row;
  return rowToQueueEntry(row);
}

export function listQueueEntries(options: {
  source_swarm_id?: string;
  status?: string;
  target_branch?: string;
  limit?: number;
  offset?: number;
} = {}): CascadeQueueEntry[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.source_swarm_id) {
    where.push('source_swarm_id = ?');
    params.push(options.source_swarm_id);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.target_branch) {
    where.push('target_branch = ?');
    params.push(options.target_branch);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const offset = Math.max(0, options.offset ?? 0);
  const rows = db
    .prepare(
      `SELECT * FROM cascade_queue_entries ${whereSql}
       ORDER BY added_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Row[];
  return rows.map(rowToQueueEntry);
}

export function listConflictsForStream(stream_row_id: string): CascadeConflict[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM cascade_conflicts WHERE stream_row_id = ? ORDER BY detected_at DESC`
    )
    .all(stream_row_id) as Row[];
  return rows.map(rowToConflict);
}

export function listOpenConflicts(options: {
  source_swarm_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}): CascadeConflict[] {
  const db = getDatabase();
  const where: string[] = ['c.status = ?'];
  const params: unknown[] = [options.status ?? 'pending'];

  if (options.source_swarm_id) {
    where.push('s.source_swarm_id = ?');
    params.push(options.source_swarm_id);
  }

  const rows = db
    .prepare(
      `SELECT c.* FROM cascade_conflicts c
       JOIN cascade_streams s ON s.id = c.stream_row_id
       WHERE ${where.join(' AND ')}
       ORDER BY c.detected_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, options.limit ?? 100, options.offset ?? 0) as Row[];
  return rows.map(rowToConflict);
}

// ============================================================================
// Task ↔ stream join
// ============================================================================

/**
 * Return the commit range bound to a task (resource_id + node_id).
 *
 * Sums across all streams on all swarms whose changes carry the matching
 * task_ref. If multiple streams touch the same task, the result reflects the
 * union. If no stream has the task_ref, returns null.
 *
 * This is the primary query for the Phase 3 changelog artifact: close a task,
 * get a commit range for free.
 *
 * `commitsLimit` caps the per-stream `commits[]` array (default 500). Use
 * smaller values for paginated UI queries; the changelog generator reads
 * the unbounded result via the markdown rendering path.
 */
export function getCommitRangeForTask(
  task_resource_id: string,
  task_node_id: string,
  options: { commitsLimit?: number; commitsOffset?: number } = {}
): CascadeCommitRange[] {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(options.commitsLimit ?? 500, 5000));
  const offset = Math.max(0, options.commitsOffset ?? 0);

  // Find streams linked to this task. A change carries task_ref; streams may
  // also have a direct task_ref from stream.opened metadata.
  const streamRows = db
    .prepare(
      `SELECT DISTINCT s.* FROM cascade_streams s
       WHERE (s.task_resource_id = ? AND s.task_node_id = ?)
          OR EXISTS (
            SELECT 1 FROM cascade_changes c
            WHERE c.stream_row_id = s.id
              AND c.task_resource_id = ?
              AND c.task_node_id = ?
          )
       ORDER BY s.opened_at ASC`
    )
    .all(task_resource_id, task_node_id, task_resource_id, task_node_id) as Row[];

  const results: CascadeCommitRange[] = [];

  for (const streamRow of streamRows) {
    const stream = rowToStream(streamRow);

    // Only include changes that carry the task_ref (drops stream-scoped
    // noise when a stream was linked late). Apply pagination here so each
    // stream's commit list stays bounded.
    const changeRows = db
      .prepare(
        `SELECT * FROM cascade_changes
         WHERE stream_row_id = ?
           AND task_resource_id = ?
           AND task_node_id = ?
         ORDER BY synced_at ASC
         LIMIT ? OFFSET ?`
      )
      .all(stream.id, task_resource_id, task_node_id, limit, offset) as Row[];

    // Fall back to all commits on the stream if none carry the task_ref but
    // the stream itself is task-linked.
    const effectiveChangeRows =
      changeRows.length > 0
        ? changeRows
        : stream.task_resource_id === task_resource_id &&
          stream.task_node_id === task_node_id
        ? (db
            .prepare(
              `SELECT * FROM cascade_changes
               WHERE stream_row_id = ?
               ORDER BY synced_at ASC
               LIMIT ? OFFSET ?`
            )
            .all(stream.id, limit, offset) as Row[])
        : [];

    const changes = effectiveChangeRows.map(rowToChange);

    const filesUnion = new Set<string>();
    for (const ch of changes) {
      for (const f of ch.files_touched) filesUnion.add(f);
    }

    const mergeRow = db
      .prepare(
        `SELECT * FROM cascade_merges
         WHERE source_stream_row_id = ?
         ORDER BY merged_at DESC LIMIT 1`
      )
      .get(stream.id) as Row | undefined;
    const merge = mergeRow ? rowToMerge(mergeRow) : null;

    results.push({
      stream_row_id: stream.id,
      stream_id: stream.stream_id,
      source_swarm_id: stream.source_swarm_id,
      source_agent_id: stream.source_agent_id,
      first_commit: changes[0]?.commit_hash ?? null,
      last_commit: changes[changes.length - 1]?.commit_hash ?? null,
      change_ids: changes
        .map((c) => c.change_id)
        .filter((x): x is string => Boolean(x)),
      commits: changes.map((c) => ({
        commit_hash: c.commit_hash,
        change_id: c.change_id,
        message_summary: c.message_summary,
        author_agent_id: c.author_agent_id,
        files_touched: c.files_touched,
        synced_at: c.synced_at,
      })),
      files_union: Array.from(filesUnion).sort(),
      merge_commit: merge?.merge_commit ?? null,
      merge_target: merge?.target_stream_id ?? null,
    });
  }

  return results;
}

// ============================================================================
// Stats
// ============================================================================

export interface StreamStats {
  total_commits: number;
  total_merges: number;
  open_conflicts: number;
  total_files_touched: number;
  first_commit_at: string | null;
  last_commit_at: string | null;
}

// ============================================================================
// DAG + Timeline queries (Streams UI)
// ============================================================================

export interface StreamDAGNode {
  id: string;
  stream_id: string;
  source_swarm_id: string;
  source_agent_id: string;
  parent_stream_id: string | null;
  name: string;
  status: string;
  task_resource_id: string | null;
  task_node_id: string | null;
  publish_branch: string | null;
  opened_at: string;
  last_event_at: string;
  commit_count: number;
  open_conflict_count: number;
}

export interface StreamDAGEdge {
  source: string;
  target: string;
  type: 'parent' | 'merge';
}

export interface StreamDAG {
  nodes: StreamDAGNode[];
  edges: StreamDAGEdge[];
}

export function getStreamDAG(options: {
  source_swarm_id?: string;
  task_resource_id?: string;
} = {}): StreamDAG {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.source_swarm_id) {
    where.push('s.source_swarm_id = ?');
    params.push(options.source_swarm_id);
  }
  if (options.task_resource_id) {
    where.push('s.task_resource_id = ?');
    params.push(options.task_resource_id);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT
      s.id, s.stream_id, s.source_swarm_id, s.source_agent_id,
      s.parent_stream_id, s.name, s.status,
      s.task_resource_id, s.task_node_id, s.publish_branch,
      s.opened_at, s.last_event_at,
      (SELECT COUNT(*) FROM cascade_changes c WHERE c.stream_row_id = s.id) as commit_count,
      (SELECT COUNT(*) FROM cascade_conflicts cf WHERE cf.stream_row_id = s.id AND cf.status = 'pending') as open_conflict_count
    FROM cascade_streams s
    ${whereSql}
    ORDER BY s.opened_at ASC
  `).all(...params) as Array<Record<string, unknown>>;

  const nodes: StreamDAGNode[] = rows.map((r) => ({
    id: r.id as string,
    stream_id: r.stream_id as string,
    source_swarm_id: r.source_swarm_id as string,
    source_agent_id: r.source_agent_id as string,
    parent_stream_id: (r.parent_stream_id as string | null) ?? null,
    name: r.name as string,
    status: r.status as string,
    task_resource_id: (r.task_resource_id as string | null) ?? null,
    task_node_id: (r.task_node_id as string | null) ?? null,
    publish_branch: (r.publish_branch as string | null) ?? null,
    opened_at: r.opened_at as string,
    last_event_at: r.last_event_at as string,
    commit_count: r.commit_count as number,
    open_conflict_count: r.open_conflict_count as number,
  }));

  // Parent→child edges from parent_stream_id (these reference stream_id, not row id)
  const edges: StreamDAGEdge[] = [];
  const rowIdByStreamId = new Map<string, string>();
  for (const n of nodes) {
    rowIdByStreamId.set(`${n.source_swarm_id}:${n.stream_id}`, n.id);
  }

  for (const n of nodes) {
    if (n.parent_stream_id) {
      const parentRowId = rowIdByStreamId.get(`${n.source_swarm_id}:${n.parent_stream_id}`);
      if (parentRowId) {
        edges.push({ source: parentRowId, target: n.id, type: 'parent' });
      }
    }
  }

  // Merge edges from cascade_merges
  const mergeSwarmFilter = options.source_swarm_id
    ? `WHERE source_swarm_id = ?` : '';
  const mergeParams = options.source_swarm_id ? [options.source_swarm_id] : [];
  const mergeRows = db.prepare(`
    SELECT source_stream_row_id, target_stream_row_id
    FROM cascade_merges
    ${mergeSwarmFilter}
  `).all(...mergeParams) as Array<{ source_stream_row_id: string | null; target_stream_row_id: string | null }>;

  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const m of mergeRows) {
    if (m.source_stream_row_id && m.target_stream_row_id &&
        nodeIds.has(m.source_stream_row_id) && nodeIds.has(m.target_stream_row_id)) {
      edges.push({
        source: m.source_stream_row_id,
        target: m.target_stream_row_id,
        type: 'merge',
      });
    }
  }

  return { nodes, edges };
}

export type StreamTimelineEventType =
  | 'commit'
  | 'merge'
  | 'conflict_detected'
  | 'conflict_resolved'
  | 'status_change'
  | 'push'
  | 'rebase';

export interface StreamTimelineEvent {
  type: StreamTimelineEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export function getStreamTimeline(stream_row_id: string): StreamTimelineEvent[] {
  const db = getDatabase();
  const events: StreamTimelineEvent[] = [];

  // Commits
  const commits = db.prepare(
    `SELECT commit_hash, change_id, message_summary, author_agent_id, files_touched, synced_at
     FROM cascade_changes WHERE stream_row_id = ? ORDER BY synced_at ASC`,
  ).all(stream_row_id) as Array<Record<string, unknown>>;
  for (const c of commits) {
    events.push({
      type: 'commit',
      timestamp: c.synced_at as string,
      data: {
        commit_hash: c.commit_hash,
        change_id: c.change_id,
        message_summary: c.message_summary,
        author_agent_id: c.author_agent_id,
        files_touched: parseJsonArray(c.files_touched as string),
      },
    });
  }

  // Merges (as source or target)
  const merges = db.prepare(
    `SELECT source_stream_id, target_stream_id, merge_commit, agent_id, strategy, merged_at
     FROM cascade_merges WHERE source_stream_row_id = ? OR target_stream_row_id = ?`,
  ).all(stream_row_id, stream_row_id) as Array<Record<string, unknown>>;
  for (const m of merges) {
    events.push({
      type: 'merge',
      timestamp: m.merged_at as string,
      data: {
        source_stream_id: m.source_stream_id,
        target_stream_id: m.target_stream_id,
        merge_commit: m.merge_commit,
        agent_id: m.agent_id,
        strategy: m.strategy,
      },
    });
  }

  // Conflicts
  const conflicts = db.prepare(
    `SELECT conflict_id, conflicted_files, agent_id, source, status, detected_at, resolved_at
     FROM cascade_conflicts WHERE stream_row_id = ?`,
  ).all(stream_row_id) as Array<Record<string, unknown>>;
  for (const cf of conflicts) {
    events.push({
      type: 'conflict_detected',
      timestamp: cf.detected_at as string,
      data: {
        conflict_id: cf.conflict_id,
        conflicted_files: parseJsonArray(cf.conflicted_files as string),
        agent_id: cf.agent_id,
        source: cf.source,
        status: cf.status,
      },
    });
    if (cf.resolved_at) {
      events.push({
        type: 'conflict_resolved',
        timestamp: cf.resolved_at as string,
        data: {
          conflict_id: cf.conflict_id,
          status: cf.status,
        },
      });
    }
  }

  // Pushes
  const pushes = db.prepare(
    `SELECT pushed_commit, remote, remote_ref, strategy, agent_id, pushed_at
     FROM cascade_pushes WHERE stream_row_id = ?`,
  ).all(stream_row_id) as Array<Record<string, unknown>>;
  for (const p of pushes) {
    events.push({
      type: 'push',
      timestamp: p.pushed_at as string,
      data: {
        pushed_commit: p.pushed_commit,
        remote: p.remote,
        remote_ref: p.remote_ref,
        strategy: p.strategy,
        agent_id: p.agent_id,
      },
    });
  }

  // Sort all events by timestamp
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}

export function getStreamStats(stream_row_id: string): StreamStats {
  const db = getDatabase();

  const commitRow = db
    .prepare(
      `SELECT COUNT(*) as c, MIN(synced_at) as first_at, MAX(synced_at) as last_at
       FROM cascade_changes WHERE stream_row_id = ?`
    )
    .get(stream_row_id) as { c: number; first_at: string | null; last_at: string | null };

  const mergeRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM cascade_merges
       WHERE source_stream_row_id = ? OR target_stream_row_id = ?`
    )
    .get(stream_row_id, stream_row_id) as { c: number };

  const conflictRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM cascade_conflicts
       WHERE stream_row_id = ? AND status = 'pending'`
    )
    .get(stream_row_id) as { c: number };

  // Union of files_touched across all changes on this stream.
  const filesRows = db
    .prepare(`SELECT files_touched FROM cascade_changes WHERE stream_row_id = ?`)
    .all(stream_row_id) as Array<{ files_touched: string }>;
  const fileSet = new Set<string>();
  for (const r of filesRows) {
    for (const f of parseJsonArray(r.files_touched)) fileSet.add(f);
  }

  return {
    total_commits: commitRow.c,
    total_merges: mergeRow.c,
    open_conflicts: conflictRow.c,
    total_files_touched: fileSet.size,
    first_commit_at: commitRow.first_at,
    last_commit_at: commitRow.last_at,
  };
}

// ============================================================================
// Branch alias
// ============================================================================

/**
 * Update the publish_branch alias for a stream.
 * Used for mapping stream/<id> → human-readable branch name for push + PR.
 */
export function updatePublishBranch(
  stream_row_id: string,
  publish_branch: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE cascade_streams SET publish_branch = ?, last_event_at = datetime('now')
     WHERE id = ?`,
  ).run(publish_branch, stream_row_id);
}

/**
 * Auto-generate a publish branch name from the stream name.
 * Sanitizes to git-safe characters.
 */
export function defaultPublishBranch(streamName: string): string {
  return `cascade/${streamName.replace(/[^a-zA-Z0-9_/-]/g, '-').replace(/--+/g, '-')}`;
}

// ============================================================================
// Pull Requests
// ============================================================================

export interface CascadePullRequest {
  id: string;
  stream_row_id: string;
  provider: string;
  remote_pr_number: number | null;
  remote_pr_url: string | null;
  state: string;
  source_branch: string;
  target_branch: string;
  title: string | null;
  body_hash: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export function createPR(input: {
  stream_row_id: string;
  source_branch: string;
  target_branch: string;
  title: string;
  body_hash?: string;
  repo_owner: string;
  repo_name: string;
  remote_pr_number?: number;
  remote_pr_url?: string;
  state?: string;
}): CascadePullRequest {
  const db = getDatabase();
  const id = nanoid();
  db.prepare(`
    INSERT INTO cascade_pull_requests
      (id, stream_row_id, source_branch, target_branch, title, body_hash,
       repo_owner, repo_name, remote_pr_number, remote_pr_url, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.stream_row_id,
    input.source_branch,
    input.target_branch,
    input.title,
    input.body_hash ?? null,
    input.repo_owner,
    input.repo_name,
    input.remote_pr_number ?? null,
    input.remote_pr_url ?? null,
    input.state ?? 'draft',
  );
  return getPRById(id)!;
}

export function getPRById(id: string): CascadePullRequest | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM cascade_pull_requests WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToPR(row) : null;
}

export function getPRForStream(stream_row_id: string): CascadePullRequest | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT * FROM cascade_pull_requests
     WHERE stream_row_id = ? AND state != 'closed'
     ORDER BY created_at DESC LIMIT 1`,
  ).get(stream_row_id) as Row | undefined;
  return row ? rowToPR(row) : null;
}

export function updatePR(
  id: string,
  updates: Partial<{
    state: string;
    remote_pr_number: number;
    remote_pr_url: string;
    title: string;
    body_hash: string;
    synced_at: string;
  }>,
): CascadePullRequest | null {
  const db = getDatabase();
  const fields: string[] = ['updated_at = datetime(\'now\')'];
  const params: unknown[] = [];

  if (updates.state !== undefined) { fields.push('state = ?'); params.push(updates.state); }
  if (updates.remote_pr_number !== undefined) { fields.push('remote_pr_number = ?'); params.push(updates.remote_pr_number); }
  if (updates.remote_pr_url !== undefined) { fields.push('remote_pr_url = ?'); params.push(updates.remote_pr_url); }
  if (updates.title !== undefined) { fields.push('title = ?'); params.push(updates.title); }
  if (updates.body_hash !== undefined) { fields.push('body_hash = ?'); params.push(updates.body_hash); }
  if (updates.synced_at !== undefined) { fields.push('synced_at = ?'); params.push(updates.synced_at); }

  params.push(id);
  db.prepare(`UPDATE cascade_pull_requests SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getPRById(id);
}

function rowToPR(row: Row): CascadePullRequest {
  return {
    id: row.id as string,
    stream_row_id: row.stream_row_id as string,
    provider: row.provider as string,
    remote_pr_number: (row.remote_pr_number as number | null) ?? null,
    remote_pr_url: (row.remote_pr_url as string | null) ?? null,
    state: row.state as string,
    source_branch: row.source_branch as string,
    target_branch: row.target_branch as string,
    title: (row.title as string | null) ?? null,
    body_hash: (row.body_hash as string | null) ?? null,
    repo_owner: (row.repo_owner as string | null) ?? null,
    repo_name: (row.repo_name as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    synced_at: (row.synced_at as string | null) ?? null,
  };
}
