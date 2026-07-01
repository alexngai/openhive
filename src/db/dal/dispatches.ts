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
  /**
   * Transport that delivered this attempt's prompt. Written by the
   * adapter that actually performed the delivery — `openhive-runtime.ts`
   * for ACP, `openhive-mail-port.ts` for mail. Absent on attempts that
   * never reached delivery (claim races, immediate failures).
   */
  transport?: 'acp' | 'mail' | 'codex';
  /**
   * Resolved target agent id at delivery time. For ACP fresh: the
   * spawned coordinator's id; for ACP reuse: the picked existing agent.
   * For mail: the recipient agent id (sidecar id when mail_lifecycle='fresh').
   */
  agent_id?: string;
  /**
   * Routing decision from swarm-dispatch's `dispatched` event. `'spawn'`
   * means a new agent was started for this attempt; `'route'` means an
   * existing one was selected. Diagnostic — derived from the orchestrator
   * event, not the OpenHive transport.
   */
  via?: 'spawn' | 'route';
}

export interface Dispatch {
  id: string;
  /**
   * Opentasks spec reference. Nullable since V47 — spec-less dispatches
   * (Layer 4 `openteams.spawn` flow) carry a `loadout_bundle_id` instead.
   */
  spec_resource_id: string | null;
  spec_id: string | null;
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
  /**
   * Content-addressed openteams resource refs pinned at dispatch creation
   * (V57). Hash-stickiness: subsequent edits to the authored
   * loadout / team_template don't retroactively change in-flight dispatches.
   * Null when the dispatch was created without an openteams binding.
   */
  loadout_bundle_id: string | null;
  team_bundle_id: string | null;
  role: string | null;
  /**
   * ACP lifecycle hint (V47). When the orchestrator routes this dispatch
   * via ACP, controls whether to spawn a fresh coordinator (`'fresh'`)
   * or reuse an existing ACP-capable agent (`'reuse'`). `null` → fall
   * through to `config.dispatch.acp_lifecycle_default` and ultimately
   * the hardcoded `'reuse'` default.
   */
  acp_lifecycle: 'fresh' | 'reuse' | null;
  /**
   * Mail lifecycle hint (V48). When the orchestrator routes this dispatch
   * via mail, controls whether the hub mail port forces routing to the
   * connection's sidecar (`'fresh'` — sidecar's mail-inbound-consumer
   * spawns a new ephemeral worker) or lets prefer-route pick a non-busy
   * long-lived worker (`'reuse'`). `null` → fall through to
   * `config.dispatch.mail_lifecycle_default` and ultimately `'reuse'`.
   */
  mail_lifecycle: 'fresh' | 'reuse' | null;
  /**
   * Loadout binding (V49): the spec_metadata.loadout_ref or team_role_ref
   * string captured at enrichment time. NULL if the spec had no binding.
   * Persisted so the detail UI shows what was attached after the
   * side-channel TTL expires; also an audit trail.
   */
  loadout_ref: string | null;
  /**
   * Materialization status (V49). `'materialized'` on success;
   * `'failed'` when resolution errored (loadout not found, ACL forbidden,
   * etc.); `null` when no binding existed. Powers the post-refresh
   * sticky failure banner on DispatchDetail.
   */
  loadout_status: 'materialized' | 'failed' | null;
  /** Materialization error message when status='failed'. */
  loadout_error: string | null;
  /**
   * Agent-inbox conversation ID for the dispatch coordination thread (V55).
   * Written lazily on first coordination message via
   * `ensureDispatchConversation`. Null for silent dispatches.
   */
  conversation_id: string | null;
  /** Repo targeting (V54). Primary source for repo-scoped dispatches. */
  repo_id: string | null;
  /** Canonical URL resolved at enrichment time (V54). */
  canonical_url: string | null;
  /** Optional branch pin (V54). */
  branch: string | null;
  /** Optional commit SHA pin (V54). */
  commit_sha: string | null;
  /** Clone policy (V54). 'none' = never clone; 'allowed' = sidecar may clone. */
  clone_policy: 'none' | 'allowed';
  /** Explicit clone target path when clone_policy='allowed' (V54). */
  clone_path: string | null;
  created_at: string;
  updated_at: string;
}

interface DispatchRow {
  id: string;
  spec_resource_id: string | null;
  spec_id: string | null;
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
  loadout_bundle_id: string | null;
  team_bundle_id: string | null;
  role: string | null;
  acp_lifecycle: string | null;
  mail_lifecycle: string | null;
  loadout_ref: string | null;
  loadout_status: string | null;
  loadout_error: string | null;
  conversation_id: string | null;
  repo_id: string | null;
  canonical_url: string | null;
  branch: string | null;
  commit_sha: string | null;
  clone_policy: string | null;
  clone_path: string | null;
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
    loadout_bundle_id: row.loadout_bundle_id ?? null,
    team_bundle_id: row.team_bundle_id ?? null,
    role: row.role ?? null,
    acp_lifecycle:
      row.acp_lifecycle === 'fresh' || row.acp_lifecycle === 'reuse'
        ? row.acp_lifecycle
        : null,
    mail_lifecycle:
      row.mail_lifecycle === 'fresh' || row.mail_lifecycle === 'reuse'
        ? row.mail_lifecycle
        : null,
    loadout_ref: row.loadout_ref ?? null,
    loadout_status:
      row.loadout_status === 'materialized' || row.loadout_status === 'failed'
        ? row.loadout_status
        : null,
    loadout_error: row.loadout_error ?? null,
    conversation_id: row.conversation_id ?? null,
    repo_id: row.repo_id ?? null,
    canonical_url: row.canonical_url ?? null,
    branch: row.branch ?? null,
    commit_sha: row.commit_sha ?? null,
    clone_policy:
      row.clone_policy === 'allowed' ? 'allowed' : 'none',
    clone_path: row.clone_path ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ============================================================================
// Create
// ============================================================================

export interface CreateDispatchInput {
  /** Nullable for Layer 4 spec-less spawns. */
  spec_resource_id: string | null;
  spec_id: string | null;
  spec_captured_at?: string | null;
  target_swarm_id: string;
  initiator_type: DispatchInitiatorType;
  initiator_id: string;
  prompt_override?: string | null;
  // Status defaults to 'queued'; tests may pre-seed.
  status?: DispatchStatus;
  session_ids?: string[];
  // openteams binding (V57) — nullable. When present these are
  // content-addressed `sha256:<hex>` ids resolved at create time and held
  // for the dispatch's lifetime.
  loadout_bundle_id?: string | null;
  team_bundle_id?: string | null;
  role?: string | null;
  /**
   * Optional per-dispatch ACP lifecycle override. When omitted, the
   * orchestrator falls back to `config.dispatch.acp_lifecycle_default`
   * and finally to `'reuse'`. Transport-level concern — set by the
   * caller of POST /specs/.../dispatch, NOT authored on spec or loadout.
   */
  acp_lifecycle?: 'fresh' | 'reuse';
  /**
   * Optional per-dispatch mail lifecycle override. When omitted, falls
   * back to `config.dispatch.mail_lifecycle_default` and finally to
   * `'reuse'`. Same transport-level concern semantics as `acp_lifecycle`.
   */
  mail_lifecycle?: 'fresh' | 'reuse';
  /** Repo targeting (V54). Links this dispatch to a specific repo. */
  repo_id?: string;
  /** Optional branch pin (V54). */
  branch?: string;
  /** Optional commit SHA pin (V54). */
  commit_sha?: string;
  /** Clone policy (V54). Default 'none'. */
  clone_policy?: 'none' | 'allowed';
  /** Explicit clone target path when clone_policy='allowed' (V54). */
  clone_path?: string;
}

export function createDispatch(input: CreateDispatchInput): Dispatch {
  const db = getDatabase();
  const id = `disp_${nanoid()}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO dispatches (
       id, spec_resource_id, spec_id, spec_captured_at, target_swarm_id,
       status, initiator_type, initiator_id, session_ids, prompt_override,
       loadout_bundle_id, team_bundle_id, role,
       acp_lifecycle, mail_lifecycle,
       repo_id, branch, commit_sha, clone_policy, clone_path,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.spec_resource_id ?? null,
    input.spec_id ?? null,
    input.spec_captured_at ?? null,
    input.target_swarm_id,
    input.status ?? 'queued',
    input.initiator_type,
    input.initiator_id,
    JSON.stringify(input.session_ids ?? []),
    input.prompt_override ?? null,
    input.loadout_bundle_id ?? null,
    input.team_bundle_id ?? null,
    input.role ?? null,
    input.acp_lifecycle ?? null,
    input.mail_lifecycle ?? null,
    input.repo_id ?? null,
    input.branch ?? null,
    input.commit_sha ?? null,
    input.clone_policy ?? 'none',
    input.clone_path ?? null,
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
  task_resource_id?: string;
  task_node_id?: string;
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
  if (options.task_resource_id) {
    where.push(
      `EXISTS (
        SELECT 1 FROM dispatch_linked_tasks dlt
        WHERE dlt.dispatch_id = dispatches.id
          AND dlt.resource_id = ?
          ${options.task_node_id ? 'AND dlt.node_id = ?' : ''}
      )`,
    );
    params.push(options.task_resource_id);
    if (options.task_node_id) params.push(options.task_node_id);
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

/**
 * Persist the result of resolving a dispatch's loadout binding. Called from
 * `enrichWithLoadout` in the source adapter — both on success and failure
 * — so the detail UI can render a sticky "Loadout: materialized" or
 * "Loadout: failed (<reason>)" banner that survives refresh, complementing
 * the live `dispatch.materialization_failed` WS event.
 *
 * Idempotent. No-op when the dispatch row no longer exists.
 */
/**
 * Persist the resolved canonical_url onto the dispatch row (V54).
 * Called from enrichWithRepo when the dispatch was created with repo_id
 * but without canonical_url (the common case — callers pass repo_id,
 * enrichment resolves the URL). Idempotent; no-ops if the row is gone.
 */
export function recordRepoResolution(
  id: string,
  canonicalUrl: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE dispatches
       SET canonical_url = ?, updated_at = datetime('now')
     WHERE id = ? AND canonical_url IS NULL`,
  ).run(canonicalUrl, id);
}

export function recordLoadoutResolution(
  id: string,
  result:
    | { ref: string; status: 'materialized'; error?: never }
    | { ref: string; status: 'failed'; error: string },
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE dispatches
       SET loadout_ref = ?, loadout_status = ?, loadout_error = ?,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    result.ref,
    result.status,
    result.status === 'failed' ? result.error : null,
    id,
  );
}

/**
 * Record the actually-used transport + resolved target on a specific
 * `attempts_history` entry. Called from the OpenHive adapter that performed
 * the delivery (`openhive-runtime.ts` for ACP, `openhive-mail-port.ts` for
 * mail). Merges into the existing attempt row created by `upsertDispatchAttempt`,
 * preserving `started_at` and any prior fields.
 *
 * Idempotent. If the attempt row doesn't yet exist (delivery raced ahead of
 * the orchestrator's `dispatched` event), creates a stub with `status='running'`
 * and `started_at=now` so the data isn't lost.
 */
export function recordAttemptDelivery(
  id: string,
  attempt: number,
  delivery: { transport?: 'acp' | 'mail' | 'codex'; agent_id?: string; via?: 'spawn' | 'route' },
): void {
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

  const idx = history.findIndex((a) => a.attempt === attempt);
  if (idx >= 0) {
    history[idx] = { ...history[idx], ...delivery };
  } else {
    history.push({
      attempt,
      started_at: new Date().toISOString(),
      status: 'running',
      ...delivery,
    });
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

/**
 * Find the most recently-updated non-terminal dispatch tied to a given
 * coordination conversation. Used by the mail-completion observer to map
 * an inbound reply turn back to its in-flight dispatch.
 *
 * Returns `null` if no running/queued dispatch matches.
 */
export function findRunningDispatchByConversation(
  conversationId: string,
): Dispatch | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM dispatches
         WHERE conversation_id = ?
           AND status IN ('queued', 'running')
         ORDER BY updated_at DESC
         LIMIT 1`,
    )
    .get(conversationId) as DispatchRow | undefined;
  return row ? rowToDispatch(row) : null;
}

// ============================================================================
// Dispatch conversation (dispatch inbox threads)
// ============================================================================

/**
 * Set the conversation_id on a dispatch row. Called by
 * `ensureDispatchConversation` after lazily creating the coordination
 * thread. Idempotent — no-ops if already set (first-writer wins).
 */
export function setDispatchConversationId(
  id: string,
  conversationId: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE dispatches
       SET conversation_id = ?, updated_at = datetime('now')
     WHERE id = ? AND conversation_id IS NULL`,
  ).run(conversationId, id);
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
