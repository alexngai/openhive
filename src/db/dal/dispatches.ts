/**
 * Dispatches DAL — hub-native record of one (spec, swarm) handoff.
 *
 * Per D4 / D8: one row per (spec, swarm) pair, no spec-level aggregation in
 * v1. Per D11 / D15 the hub writes `queued`, `running`, and `cancelled`;
 * agent-side completion comes through `map/dispatches/report` and writes
 * `complete` / `failed`.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';

export type DispatchStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export type DispatchInitiatorType = 'user' | 'agent';

/** Result payload an agent reports back via `map/dispatches/report`. */
export interface DispatchOutcome {
  summary?: string;
  artifacts?: Array<{ kind: string; ref: string }>;
  error?: string;
  // Loose JSON shape — refine when real callers settle.
  [key: string]: unknown;
}

/**
 * One entry per orchestrator attempt. Written by the event bridge in
 * src/dispatch/setup.ts so the UI can render a retry timeline without
 * reconstructing state from the WS event stream.
 */
export interface DispatchAttempt {
  /** 1-indexed attempt number (matches orchestrator `attempt` field). */
  attempt: number;
  started_at: string;
  ended_at?: string;
  status: 'running' | 'completed' | 'failed' | 'retrying';
  error?: string;
  session_id?: string;
  /** ISO timestamp of the next retry (set when status === 'retrying'). */
  next_retry_at?: string;
}

export interface Dispatch {
  id: string;
  spec_resource_id: string;
  spec_id: string;
  spec_captured_at: string | null;
  target_swarm_id: string;
  status: DispatchStatus;
  initiator_type: DispatchInitiatorType;
  initiator_id: string;
  session_ids: string[];
  outcome: DispatchOutcome | null;
  prompt_override: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  attempt: number;
  turn_count: number;
  attempts_history: DispatchAttempt[];
  created_at: string;
  updated_at: string;
}

interface DispatchRow {
  id: string;
  spec_resource_id: string;
  spec_id: string;
  spec_captured_at: string | null;
  target_swarm_id: string;
  status: DispatchStatus;
  initiator_type: DispatchInitiatorType;
  initiator_id: string;
  session_ids: string;
  outcome: string | null;
  prompt_override: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  attempt: number | null;
  turn_count: number | null;
  attempts_history: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDispatch(row: DispatchRow): Dispatch {
  let parsedSessions: string[] = [];
  try {
    parsedSessions = JSON.parse(row.session_ids) as string[];
  } catch {
    /* malformed json — surface as empty rather than crash a list query */
  }

  let parsedOutcome: DispatchOutcome | null = null;
  if (row.outcome) {
    try {
      parsedOutcome = JSON.parse(row.outcome) as DispatchOutcome;
    } catch {
      parsedOutcome = null;
    }
  }

  let parsedAttempts: DispatchAttempt[] = [];
  if (row.attempts_history) {
    try {
      const raw = JSON.parse(row.attempts_history);
      if (Array.isArray(raw)) parsedAttempts = raw as DispatchAttempt[];
    } catch {
      /* keep default empty */
    }
  }

  return {
    id: row.id,
    spec_resource_id: row.spec_resource_id,
    spec_id: row.spec_id,
    spec_captured_at: row.spec_captured_at,
    target_swarm_id: row.target_swarm_id,
    status: row.status,
    initiator_type: row.initiator_type,
    initiator_id: row.initiator_id,
    session_ids: parsedSessions,
    outcome: parsedOutcome,
    prompt_override: row.prompt_override,
    lease_token: row.lease_token ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    attempt: row.attempt ?? 0,
    turn_count: row.turn_count ?? 0,
    attempts_history: parsedAttempts,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ============================================================================
// Create
// ============================================================================

export interface CreateDispatchInput {
  spec_resource_id: string;
  spec_id: string;
  spec_captured_at?: string | null;
  target_swarm_id: string;
  initiator_type: DispatchInitiatorType;
  initiator_id: string;
  prompt_override?: string | null;
  // Status defaults to 'queued'; tests may pre-seed.
  status?: DispatchStatus;
  session_ids?: string[];
}

export function createDispatch(input: CreateDispatchInput): Dispatch {
  const db = getDatabase();
  const id = `disp_${nanoid()}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO dispatches (
       id, spec_resource_id, spec_id, spec_captured_at, target_swarm_id,
       status, initiator_type, initiator_id, session_ids, prompt_override,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.spec_resource_id,
    input.spec_id,
    input.spec_captured_at ?? null,
    input.target_swarm_id,
    input.status ?? 'queued',
    input.initiator_type,
    input.initiator_id,
    JSON.stringify(input.session_ids ?? []),
    input.prompt_override ?? null,
    now,
    now,
  );

  const row = db
    .prepare('SELECT * FROM dispatches WHERE id = ?')
    .get(id) as DispatchRow;
  return rowToDispatch(row);
}

// ============================================================================
// Read
// ============================================================================

export function findDispatchById(id: string): Dispatch | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM dispatches WHERE id = ?')
    .get(id) as DispatchRow | undefined;
  return row ? rowToDispatch(row) : null;
}

export interface ListDispatchesOptions {
  status?: DispatchStatus | DispatchStatus[];
  target_swarm_id?: string;
  spec_resource_id?: string;
  spec_id?: string;
  initiator_id?: string;
  initiator_type?: DispatchInitiatorType;
  limit?: number;
  offset?: number;
}

export function listDispatches(
  options: ListDispatchesOptions = {},
): { data: Dispatch[]; total: number } {
  const db = getDatabase();

  const where: string[] = [];
  const params: unknown[] = [];

  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (options.target_swarm_id) {
    where.push('target_swarm_id = ?');
    params.push(options.target_swarm_id);
  }
  if (options.spec_resource_id) {
    where.push('spec_resource_id = ?');
    params.push(options.spec_resource_id);
  }
  if (options.spec_id) {
    where.push('spec_id = ?');
    params.push(options.spec_id);
  }
  if (options.initiator_id) {
    where.push('initiator_id = ?');
    params.push(options.initiator_id);
  }
  if (options.initiator_type) {
    where.push('initiator_type = ?');
    params.push(options.initiator_type);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM dispatches ${whereClause}`).get(...params) as {
      count: number;
    }
  ).count;

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const rows = db
    .prepare(
      `SELECT * FROM dispatches ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as DispatchRow[];

  return { data: rows.map(rowToDispatch), total };
}

// ============================================================================
// Mutate
// ============================================================================

export function updateDispatchStatus(
  id: string,
  status: DispatchStatus,
  outcome?: DispatchOutcome | null,
): Dispatch | null {
  const db = getDatabase();
  const now = new Date().toISOString();

  if (outcome !== undefined) {
    db.prepare(
      'UPDATE dispatches SET status = ?, outcome = ?, updated_at = ? WHERE id = ?',
    ).run(status, outcome === null ? null : JSON.stringify(outcome), now, id);
  } else {
    db.prepare('UPDATE dispatches SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      now,
      id,
    );
  }

  return findDispatchById(id);
}

export function setDispatchSessionIds(id: string, sessionIds: string[]): Dispatch | null {
  const db = getDatabase();
  db.prepare('UPDATE dispatches SET session_ids = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(sessionIds),
    new Date().toISOString(),
    id,
  );
  return findDispatchById(id);
}

/** Convenience for the cancel endpoint. */
export function cancelDispatch(id: string): Dispatch | null {
  return updateDispatchStatus(id, 'cancelled');
}

// ============================================================================
// Orchestrator helpers (swarm-dispatch integration)
// ============================================================================

export function claimDispatch(
  id: string,
  claimantId: string,
): { success: boolean; fence?: string; claimedBy?: string } {
  const db = getDatabase();
  const fence = `${claimantId}:${Date.now()}`;
  const leaseExpires = new Date(Date.now() + 60_000).toISOString();
  const result = db
    .prepare(
      `UPDATE dispatches SET status = 'running', lease_token = ?, lease_expires_at = ?,
       updated_at = datetime('now') WHERE id = ? AND status = 'queued'`,
    )
    .run(fence, leaseExpires, id);
  if (result.changes === 0) {
    const existing = findDispatchById(id);
    return { success: false, claimedBy: existing?.initiator_id };
  }
  return { success: true, fence };
}

export function releaseDispatch(id: string, fence?: string): void {
  const db = getDatabase();
  if (fence) {
    db.prepare(
      `UPDATE dispatches SET status = 'queued', lease_token = NULL, lease_expires_at = NULL,
       updated_at = datetime('now') WHERE id = ? AND lease_token = ?`,
    ).run(id, fence);
  } else {
    db.prepare(
      `UPDATE dispatches SET status = 'queued', lease_token = NULL, lease_expires_at = NULL,
       updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
  }
}

export function transitionDispatch(
  id: string,
  action: 'start' | 'complete' | 'fail',
  fence?: string,
  outcome?: DispatchOutcome | null,
): void {
  const db = getDatabase();
  const statusMap = { start: 'running', complete: 'complete', fail: 'failed' } as const;
  const status = statusMap[action];
  const now = new Date().toISOString();

  if (fence) {
    if (outcome !== undefined) {
      db.prepare(
        `UPDATE dispatches SET status = ?, outcome = ?, updated_at = ?
         WHERE id = ? AND lease_token = ?`,
      ).run(status, outcome ? JSON.stringify(outcome) : null, now, id, fence);
    } else {
      db.prepare(
        `UPDATE dispatches SET status = ?, updated_at = ? WHERE id = ? AND lease_token = ?`,
      ).run(status, now, id, fence);
    }
  } else {
    if (outcome !== undefined) {
      db.prepare(
        `UPDATE dispatches SET status = ?, outcome = ?, updated_at = ? WHERE id = ?`,
      ).run(status, outcome ? JSON.stringify(outcome) : null, now, id);
    } else {
      db.prepare(
        `UPDATE dispatches SET status = ?, updated_at = ? WHERE id = ?`,
      ).run(status, now, id);
    }
  }
}

export function renewDispatchClaim(
  id: string,
  fence: string,
): { ok: boolean; reason?: string } {
  const db = getDatabase();
  const leaseExpires = new Date(Date.now() + 60_000).toISOString();
  const result = db
    .prepare(
      `UPDATE dispatches SET lease_expires_at = ?, updated_at = datetime('now')
       WHERE id = ? AND lease_token = ?`,
    )
    .run(leaseExpires, id, fence);
  if (result.changes === 0) {
    return { ok: false, reason: 'claim lost or dispatch not found' };
  }
  return { ok: true };
}

export function updateDispatchAttemptTurn(
  id: string,
  attempt: number,
  turnCount: number,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE dispatches SET attempt = ?, turn_count = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(attempt, turnCount, id);
}

/**
 * Append or update the most recent entry in `attempts_history`. The upsert
 * key is `attempt` (number): if an entry with the same attempt exists, it's
 * merged in place (so `dispatched` → `retrying`/`completed` lands on one
 * record instead of growing duplicates). Otherwise a new record is pushed.
 *
 * Designed to be idempotent — event bridges may fire similar events twice
 * during retries, and we want stable history.
 */
export function upsertDispatchAttempt(id: string, entry: DispatchAttempt): void {
  const db = getDatabase();
  const row = db
    .prepare('SELECT attempts_history FROM dispatches WHERE id = ?')
    .get(id) as { attempts_history: string | null } | undefined;
  if (!row) return;

  let history: DispatchAttempt[] = [];
  if (row.attempts_history) {
    try {
      const parsed = JSON.parse(row.attempts_history);
      if (Array.isArray(parsed)) history = parsed as DispatchAttempt[];
    } catch {
      /* ignore */
    }
  }

  const idx = history.findIndex((a) => a.attempt === entry.attempt);
  if (idx >= 0) {
    history[idx] = { ...history[idx], ...entry };
  } else {
    history.push(entry);
  }
  history.sort((a, b) => a.attempt - b.attempt);

  db.prepare(
    `UPDATE dispatches SET attempts_history = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(JSON.stringify(history), id);
}

export function listQueuedDispatches(limit: number = 50): Dispatch[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM dispatches WHERE status = ? ORDER BY created_at ASC LIMIT ?')
    .all('queued', limit) as DispatchRow[];
  return rows.map(rowToDispatch);
}

export function listInProgressDispatches(): Dispatch[] {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT * FROM dispatches WHERE status IN ('running') ORDER BY created_at ASC")
    .all() as DispatchRow[];
  return rows.map(rowToDispatch);
}

// ============================================================================
// Linked tasks (dispatch → opentasks task refs captured at creation)
// ============================================================================

export interface DispatchLinkedTaskRef {
  resource_id: string;
  node_id: string;
  advanced_on_start?: boolean;
}

interface LinkedTaskRow {
  resource_id: string;
  node_id: string;
  advanced_on_start: number;
}

export function addDispatchLinkedTasks(
  dispatchId: string,
  refs: Array<{ resource_id: string; node_id: string }>,
): void {
  if (refs.length === 0) return;
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO dispatch_linked_tasks (dispatch_id, resource_id, node_id)
     VALUES (?, ?, ?)`,
  );
  const insertAll = db.transaction((items: Array<{ resource_id: string; node_id: string }>) => {
    for (const ref of items) {
      stmt.run(dispatchId, ref.resource_id, ref.node_id);
    }
  });
  insertAll(refs);
}

export function getDispatchLinkedTasks(dispatchId: string): DispatchLinkedTaskRef[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT resource_id, node_id, advanced_on_start
       FROM dispatch_linked_tasks WHERE dispatch_id = ?`,
    )
    .all(dispatchId) as LinkedTaskRow[];
  return rows.map((r) => ({
    resource_id: r.resource_id,
    node_id: r.node_id,
    advanced_on_start: Boolean(r.advanced_on_start),
  }));
}

export function markTaskAdvanced(
  dispatchId: string,
  ref: { resource_id: string; node_id: string },
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE dispatch_linked_tasks SET advanced_on_start = 1
     WHERE dispatch_id = ? AND resource_id = ? AND node_id = ?`,
  ).run(dispatchId, ref.resource_id, ref.node_id);
}
