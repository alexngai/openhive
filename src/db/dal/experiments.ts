/**
 * Experiments DAL — OpenHive's autonomation experiment control plane.
 *
 * Four tables (see docs/design/autonomation-experiments.md):
 *   - experiments          — the optimization line (content-hash-keyed when locked)
 *   - experiment_runs      — one loop invocation, hosted as a hosted swarm
 *   - experiment_candidates — the candidate-lineage projection
 *   - experiment_events    — append-only live telemetry (source of truth)
 *
 * Follows the house DAL conventions (cf. src/db/dal/schedules.ts): prefixed
 * nanoid ids, ISO-8601 string timestamps, JSON `TEXT` columns stringified on
 * write and try/catch-parsed on read, all access through getDatabase().
 *
 * The hub never decides keep/discard — candidate rows are a projection of the
 * runner's reported events + finalization snapshot, never operator-authored.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';

// ============================================================================
// Types
// ============================================================================

export type ExperimentStatus = 'draft' | 'active' | 'paused' | 'archived';
export type ObjectiveDirection = 'increase' | 'decrease';
export type ExperimentInitiatorType = 'user' | 'agent';
export type RunStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export type RunInitiatorType = 'user' | 'agent' | 'schedule';
export type CandidateStatus =
  | 'baseline'
  | 'admitted'
  | 'keep'
  | 'discard'
  | 'crash'
  | 'no_candidate';

export interface Experiment {
  id: string;
  hive_id: string;
  name: string;
  description: string | null;
  content_hash: string | null;
  objective_metric: string;
  objective_direction: ObjectiveDirection;
  objective_min_delta: number;
  claims: unknown | null;
  config: unknown;
  repo_resource_id: string | null;
  status: ExperimentStatus;
  incumbent_candidate_id: string | null;
  initiator_type: ExperimentInitiatorType;
  initiator_id: string;
  created_at: string;
  updated_at: string;
}

export interface ExperimentRun {
  id: string;
  experiment_id: string;
  autonomation_run_id: string | null;
  hosted_swarm_id: string | null;
  worker_token_hash: string | null;
  content_hash: string | null;
  env_fingerprint: unknown | null;
  repo_root: string | null;
  experiment_branch: string | null;
  experiment_worktree: string | null;
  start_point: string | null;
  status: RunStatus;
  stop_reason: string | null;
  stop_message: string | null;
  claim_strength: unknown | null;
  cycles: number;
  total_proposed: number;
  total_admitted: number;
  total_promoted: number;
  candidate_failures: number;
  summary: unknown | null;
  initiator_type: RunInitiatorType;
  initiator_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface ExperimentCandidate {
  id: string;
  experiment_id: string;
  run_id: string;
  candidate_ref: string;
  parent_candidate_id: string | null;
  cycle_index: number | null;
  proposer: string | null;
  status: CandidateStatus;
  base_commit: string | null;
  head_commit: string | null;
  changed_paths: string[] | null;
  patch_ref: string | null;
  overlay: unknown | null;
  content_hash: string | null;
  score_train: number | null;
  score_held_out: number | null;
  scores: Record<string, number> | null;
  promoted: boolean;
  rationale: string | null;
  failure_reason: string | null;
  dispatch_id: string | null;
  cascade_stream_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExperimentEvent {
  id: string;
  experiment_id: string;
  run_id: string;
  autonomation_run_id: string | null;
  seq: number;
  type: string;
  cycle_index: number | null;
  candidate_ref: string | null;
  metric: string | null;
  score: number | null;
  message: string | null;
  payload: unknown;
  created_at: string;
  received_at: string;
}

// ============================================================================
// Helpers
// ============================================================================

function nowIso(): string {
  return new Date().toISOString();
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ============================================================================
// experiments
// ============================================================================

function rowToExperiment(row: Record<string, unknown>): Experiment {
  return {
    id: row.id as string,
    hive_id: row.hive_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    content_hash: (row.content_hash as string | null) ?? null,
    objective_metric: row.objective_metric as string,
    objective_direction: row.objective_direction as ObjectiveDirection,
    objective_min_delta: row.objective_min_delta as number,
    claims: row.claims == null ? null : parseJson<unknown>(row.claims, null),
    config: parseJson<unknown>(row.config, {}),
    repo_resource_id: (row.repo_resource_id as string | null) ?? null,
    status: row.status as ExperimentStatus,
    incumbent_candidate_id: (row.incumbent_candidate_id as string | null) ?? null,
    initiator_type: row.initiator_type as ExperimentInitiatorType,
    initiator_id: row.initiator_id as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export interface CreateExperimentInput {
  name: string;
  objective_metric: string;
  objective_direction: ObjectiveDirection;
  config: unknown;
  hive_id?: string;
  description?: string | null;
  content_hash?: string | null;
  objective_min_delta?: number;
  claims?: unknown | null;
  repo_resource_id?: string | null;
  status?: ExperimentStatus;
  initiator_type?: ExperimentInitiatorType;
  initiator_id?: string;
}

export function createExperiment(input: CreateExperimentInput): Experiment {
  const db = getDatabase();
  const id = `exp_${nanoid()}`;
  const now = nowIso();

  db.prepare(
    `INSERT INTO experiments (
       id, hive_id, name, description, content_hash,
       objective_metric, objective_direction, objective_min_delta,
       claims, config, repo_resource_id, status, incumbent_candidate_id,
       initiator_type, initiator_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.hive_id ?? 'default-general',
    input.name,
    input.description ?? null,
    input.content_hash ?? null,
    input.objective_metric,
    input.objective_direction,
    input.objective_min_delta ?? 0,
    toJson(input.claims ?? null),
    toJson(input.config) ?? '{}',
    input.repo_resource_id ?? null,
    input.status ?? 'draft',
    null,
    input.initiator_type ?? 'user',
    input.initiator_id ?? '',
    now,
    now,
  );

  return findExperimentById(id)!;
}

/**
 * Find-or-create by `content_hash` — encodes the D2 rule that re-running the
 * same locked config accumulates under one experiment. A null `content_hash`
 * (exploratory/fast-iteration) always creates a fresh experiment.
 */
export function upsertExperimentByContentHash(
  input: CreateExperimentInput,
): Experiment {
  if (input.content_hash) {
    const existing = findExperimentByContentHash(input.content_hash);
    if (existing) return existing;
  }
  return createExperiment(input);
}

export function findExperimentById(id: string): Experiment | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToExperiment(row) : null;
}

export function findExperimentByContentHash(contentHash: string): Experiment | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM experiments WHERE content_hash = ?')
    .get(contentHash) as Record<string, unknown> | undefined;
  return row ? rowToExperiment(row) : null;
}

export interface ListExperimentsOptions {
  hive_id?: string;
  status?: ExperimentStatus;
  limit?: number;
  offset?: number;
}

export function listExperiments(
  options: ListExperimentsOptions = {},
): { data: Experiment[]; total: number } {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.hive_id !== undefined) {
    where.push('hive_id = ?');
    params.push(options.hive_id);
  }
  if (options.status !== undefined) {
    where.push('status = ?');
    params.push(options.status);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  const total = (
    db.prepare(`SELECT COUNT(*) as n FROM experiments ${whereSql}`).get(...params) as {
      n: number;
    }
  ).n;

  const rows = db
    .prepare(
      `SELECT * FROM experiments ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return { data: rows.map(rowToExperiment), total };
}

export interface UpdateExperimentInput {
  name?: string;
  description?: string | null;
  content_hash?: string | null;
  objective_metric?: string;
  objective_direction?: ObjectiveDirection;
  objective_min_delta?: number;
  claims?: unknown | null;
  config?: unknown;
  repo_resource_id?: string | null;
  status?: ExperimentStatus;
  incumbent_candidate_id?: string | null;
}

export function updateExperiment(
  id: string,
  input: UpdateExperimentInput,
): Experiment | null {
  const db = getDatabase();
  const existing = findExperimentById(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown) => {
    sets.push(`${col} = ?`);
    params.push(value);
  };

  if (input.name !== undefined) set('name', input.name);
  if (input.description !== undefined) set('description', input.description);
  if (input.content_hash !== undefined) set('content_hash', input.content_hash);
  if (input.objective_metric !== undefined) set('objective_metric', input.objective_metric);
  if (input.objective_direction !== undefined)
    set('objective_direction', input.objective_direction);
  if (input.objective_min_delta !== undefined)
    set('objective_min_delta', input.objective_min_delta);
  if (input.claims !== undefined) set('claims', toJson(input.claims));
  if (input.config !== undefined) set('config', toJson(input.config) ?? '{}');
  if (input.repo_resource_id !== undefined) set('repo_resource_id', input.repo_resource_id);
  if (input.status !== undefined) set('status', input.status);
  if (input.incumbent_candidate_id !== undefined)
    set('incumbent_candidate_id', input.incumbent_candidate_id);

  if (sets.length === 0) return existing;

  set('updated_at', nowIso());
  params.push(id);
  db.prepare(`UPDATE experiments SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return findExperimentById(id);
}

export function deleteExperiment(id: string): boolean {
  const db = getDatabase();
  return db.prepare('DELETE FROM experiments WHERE id = ?').run(id).changes > 0;
}

// ============================================================================
// experiment_runs
// ============================================================================

function rowToRun(row: Record<string, unknown>): ExperimentRun {
  return {
    id: row.id as string,
    experiment_id: row.experiment_id as string,
    autonomation_run_id: (row.autonomation_run_id as string | null) ?? null,
    hosted_swarm_id: (row.hosted_swarm_id as string | null) ?? null,
    worker_token_hash: (row.worker_token_hash as string | null) ?? null,
    content_hash: (row.content_hash as string | null) ?? null,
    env_fingerprint:
      row.env_fingerprint == null ? null : parseJson<unknown>(row.env_fingerprint, null),
    repo_root: (row.repo_root as string | null) ?? null,
    experiment_branch: (row.experiment_branch as string | null) ?? null,
    experiment_worktree: (row.experiment_worktree as string | null) ?? null,
    start_point: (row.start_point as string | null) ?? null,
    status: row.status as RunStatus,
    stop_reason: (row.stop_reason as string | null) ?? null,
    stop_message: (row.stop_message as string | null) ?? null,
    claim_strength:
      row.claim_strength == null ? null : parseJson<unknown>(row.claim_strength, null),
    cycles: row.cycles as number,
    total_proposed: row.total_proposed as number,
    total_admitted: row.total_admitted as number,
    total_promoted: row.total_promoted as number,
    candidate_failures: row.candidate_failures as number,
    summary: row.summary == null ? null : parseJson<unknown>(row.summary, null),
    initiator_type: row.initiator_type as RunInitiatorType,
    initiator_id: row.initiator_id as string,
    created_at: row.created_at as string,
    started_at: (row.started_at as string | null) ?? null,
    finished_at: (row.finished_at as string | null) ?? null,
    updated_at: row.updated_at as string,
  };
}

export interface CreateRunInput {
  experiment_id: string;
  autonomation_run_id?: string | null;
  hosted_swarm_id?: string | null;
  worker_token_hash?: string | null;
  content_hash?: string | null;
  env_fingerprint?: unknown | null;
  repo_root?: string | null;
  experiment_branch?: string | null;
  experiment_worktree?: string | null;
  start_point?: string | null;
  status?: RunStatus;
  initiator_type?: RunInitiatorType;
  initiator_id?: string;
}

export function createRun(input: CreateRunInput): ExperimentRun {
  const db = getDatabase();
  const id = `exrun_${nanoid()}`;
  const now = nowIso();

  db.prepare(
    `INSERT INTO experiment_runs (
       id, experiment_id, autonomation_run_id, hosted_swarm_id, worker_token_hash,
       content_hash, env_fingerprint, repo_root, experiment_branch, experiment_worktree,
       start_point, status, initiator_type, initiator_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.experiment_id,
    input.autonomation_run_id ?? null,
    input.hosted_swarm_id ?? null,
    input.worker_token_hash ?? null,
    input.content_hash ?? null,
    toJson(input.env_fingerprint ?? null),
    input.repo_root ?? null,
    input.experiment_branch ?? null,
    input.experiment_worktree ?? null,
    input.start_point ?? null,
    input.status ?? 'queued',
    input.initiator_type ?? 'user',
    input.initiator_id ?? '',
    now,
    now,
  );

  return findRunById(id)!;
}

export function findRunById(id: string): ExperimentRun | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRun(row) : null;
}

export function findRunByAutonomationRunId(runId: string): ExperimentRun | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM experiment_runs WHERE autonomation_run_id = ?')
    .get(runId) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

export function listRunsForExperiment(
  experimentId: string,
  options: { limit?: number; offset?: number } = {},
): { data: ExperimentRun[]; total: number } {
  const db = getDatabase();
  const total = (
    db
      .prepare('SELECT COUNT(*) as n FROM experiment_runs WHERE experiment_id = ?')
      .get(experimentId) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT * FROM experiment_runs WHERE experiment_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(experimentId, options.limit ?? 100, options.offset ?? 0) as Record<
    string,
    unknown
  >[];
  return { data: rows.map(rowToRun), total };
}

export interface UpdateRunInput {
  autonomation_run_id?: string | null;
  hosted_swarm_id?: string | null;
  worker_token_hash?: string | null;
  content_hash?: string | null;
  env_fingerprint?: unknown | null;
  repo_root?: string | null;
  experiment_branch?: string | null;
  experiment_worktree?: string | null;
  start_point?: string | null;
  status?: RunStatus;
  stop_reason?: string | null;
  stop_message?: string | null;
  claim_strength?: unknown | null;
  cycles?: number;
  total_proposed?: number;
  total_admitted?: number;
  total_promoted?: number;
  candidate_failures?: number;
  summary?: unknown | null;
  started_at?: string | null;
  finished_at?: string | null;
}

const RUN_JSON_COLS = new Set(['env_fingerprint', 'claim_strength', 'summary']);

export function updateRun(id: string, input: UpdateRunInput): ExperimentRun | null {
  const db = getDatabase();
  const existing = findRunById(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [col, value] of Object.entries(input)) {
    if (value === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(RUN_JSON_COLS.has(col) ? toJson(value) : value);
  }

  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);
  db.prepare(`UPDATE experiment_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return findRunById(id);
}

/**
 * Atomically claim a queued run for launch — sets a `launching` marker only if
 * the run is still `queued` with no marker. A lost race changes 0 rows. Returns
 * true if this caller won the claim (prevents a double-launch TOCTOU).
 */
export function claimRunForLaunch(id: string): boolean {
  const db = getDatabase();
  const res = db
    .prepare(
      `UPDATE experiment_runs SET hosted_swarm_id = 'launching', updated_at = ?
         WHERE id = ? AND status = 'queued' AND hosted_swarm_id IS NULL`,
    )
    .run(nowIso(), id);
  return res.changes > 0;
}

/** Release a launch claim (e.g. when the spawn fails before the real marker is set). */
export function releaseRunLaunchClaim(id: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE experiment_runs SET hosted_swarm_id = NULL, updated_at = ?
       WHERE id = ? AND hosted_swarm_id = 'launching'`,
  ).run(nowIso(), id);
}

// ============================================================================
// experiment_candidates (projection)
// ============================================================================

function rowToCandidate(row: Record<string, unknown>): ExperimentCandidate {
  return {
    id: row.id as string,
    experiment_id: row.experiment_id as string,
    run_id: row.run_id as string,
    candidate_ref: row.candidate_ref as string,
    parent_candidate_id: (row.parent_candidate_id as string | null) ?? null,
    cycle_index: (row.cycle_index as number | null) ?? null,
    proposer: (row.proposer as string | null) ?? null,
    status: row.status as CandidateStatus,
    base_commit: (row.base_commit as string | null) ?? null,
    head_commit: (row.head_commit as string | null) ?? null,
    changed_paths:
      row.changed_paths == null ? null : parseJson<string[]>(row.changed_paths, []),
    patch_ref: (row.patch_ref as string | null) ?? null,
    overlay: row.overlay == null ? null : parseJson<unknown>(row.overlay, null),
    content_hash: (row.content_hash as string | null) ?? null,
    score_train: (row.score_train as number | null) ?? null,
    score_held_out: (row.score_held_out as number | null) ?? null,
    scores:
      row.scores == null ? null : parseJson<Record<string, number>>(row.scores, {}),
    promoted: Boolean(row.promoted),
    rationale: (row.rationale as string | null) ?? null,
    failure_reason: (row.failure_reason as string | null) ?? null,
    dispatch_id: (row.dispatch_id as string | null) ?? null,
    cascade_stream_id: (row.cascade_stream_id as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export interface UpsertCandidateInput {
  experiment_id: string;
  run_id: string;
  candidate_ref: string;
  /**
   * Required when creating a candidate; optional on update so the finalization
   * pass (scores only) never clobbers an event-projected terminal keep/discard.
   */
  status?: CandidateStatus;
  parent_candidate_id?: string | null;
  cycle_index?: number | null;
  proposer?: string | null;
  base_commit?: string | null;
  head_commit?: string | null;
  changed_paths?: string[] | null;
  patch_ref?: string | null;
  overlay?: unknown | null;
  content_hash?: string | null;
  score_train?: number | null;
  score_held_out?: number | null;
  scores?: Record<string, number> | null;
  promoted?: boolean;
  rationale?: string | null;
  failure_reason?: string | null;
  dispatch_id?: string | null;
  cascade_stream_id?: string | null;
}

/**
 * Insert-or-update a candidate row keyed by (run_id, candidate_ref). The ingest
 * handler calls this as it projects events and the finalization snapshot, so a
 * candidate seen first as `admitted` and later `keep` (with scores) converges to
 * one row. Only provided fields overwrite; omitted fields are preserved on update.
 */
export function upsertCandidate(input: UpsertCandidateInput): ExperimentCandidate {
  const db = getDatabase();
  const now = nowIso();
  const existing = findCandidate(input.run_id, input.candidate_ref);

  if (existing) {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (input.parent_candidate_id !== undefined) set('parent_candidate_id', input.parent_candidate_id);
    if (input.cycle_index !== undefined) set('cycle_index', input.cycle_index);
    if (input.proposer !== undefined) set('proposer', input.proposer);
    if (input.status !== undefined) set('status', input.status);
    if (input.base_commit !== undefined) set('base_commit', input.base_commit);
    if (input.head_commit !== undefined) set('head_commit', input.head_commit);
    if (input.changed_paths !== undefined) set('changed_paths', toJson(input.changed_paths));
    if (input.patch_ref !== undefined) set('patch_ref', input.patch_ref);
    if (input.overlay !== undefined) set('overlay', toJson(input.overlay));
    if (input.content_hash !== undefined) set('content_hash', input.content_hash);
    if (input.score_train !== undefined) set('score_train', input.score_train);
    if (input.score_held_out !== undefined) set('score_held_out', input.score_held_out);
    if (input.scores !== undefined) set('scores', toJson(input.scores));
    if (input.promoted !== undefined) set('promoted', input.promoted ? 1 : 0);
    if (input.rationale !== undefined) set('rationale', input.rationale);
    if (input.failure_reason !== undefined) set('failure_reason', input.failure_reason);
    if (input.dispatch_id !== undefined) set('dispatch_id', input.dispatch_id);
    if (input.cascade_stream_id !== undefined) set('cascade_stream_id', input.cascade_stream_id);
    set('updated_at', now);
    params.push(existing.id);
    db.prepare(`UPDATE experiment_candidates SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return findCandidateById(existing.id)!;
  }

  if (input.status === undefined) {
    throw new Error('upsertCandidate: status is required when creating a candidate');
  }
  const insertStatus: CandidateStatus = input.status;
  const id = `excand_${nanoid()}`;
  db.prepare(
    `INSERT INTO experiment_candidates (
       id, experiment_id, run_id, candidate_ref, parent_candidate_id, cycle_index,
       proposer, status, base_commit, head_commit, changed_paths, patch_ref, overlay,
       content_hash, score_train, score_held_out, scores, promoted, rationale,
       failure_reason, dispatch_id, cascade_stream_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.experiment_id,
    input.run_id,
    input.candidate_ref,
    input.parent_candidate_id ?? null,
    input.cycle_index ?? null,
    input.proposer ?? null,
    insertStatus,
    input.base_commit ?? null,
    input.head_commit ?? null,
    toJson(input.changed_paths ?? null),
    input.patch_ref ?? null,
    toJson(input.overlay ?? null),
    input.content_hash ?? null,
    input.score_train ?? null,
    input.score_held_out ?? null,
    toJson(input.scores ?? null),
    input.promoted ? 1 : 0,
    input.rationale ?? null,
    input.failure_reason ?? null,
    input.dispatch_id ?? null,
    input.cascade_stream_id ?? null,
    now,
    now,
  );
  return findCandidateById(id)!;
}

export function findCandidateById(id: string): ExperimentCandidate | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM experiment_candidates WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToCandidate(row) : null;
}

export function findCandidate(
  runId: string,
  candidateRef: string,
): ExperimentCandidate | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM experiment_candidates WHERE run_id = ? AND candidate_ref = ?')
    .get(runId, candidateRef) as Record<string, unknown> | undefined;
  return row ? rowToCandidate(row) : null;
}

export function listCandidatesForRun(runId: string): ExperimentCandidate[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM experiment_candidates WHERE run_id = ?
         ORDER BY cycle_index ASC, created_at ASC`,
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map(rowToCandidate);
}

export function listCandidatesForExperiment(
  experimentId: string,
  options: { promotedOnly?: boolean } = {},
): ExperimentCandidate[] {
  const db = getDatabase();
  const promotedSql = options.promotedOnly ? ' AND promoted = 1' : '';
  const rows = db
    .prepare(
      `SELECT * FROM experiment_candidates WHERE experiment_id = ?${promotedSql}
         ORDER BY created_at ASC`,
    )
    .all(experimentId) as Record<string, unknown>[];
  return rows.map(rowToCandidate);
}

// ============================================================================
// experiment_events (append-only)
// ============================================================================

function rowToEvent(row: Record<string, unknown>): ExperimentEvent {
  return {
    id: row.id as string,
    experiment_id: row.experiment_id as string,
    run_id: row.run_id as string,
    autonomation_run_id: (row.autonomation_run_id as string | null) ?? null,
    seq: row.seq as number,
    type: row.type as string,
    cycle_index: (row.cycle_index as number | null) ?? null,
    candidate_ref: (row.candidate_ref as string | null) ?? null,
    metric: (row.metric as string | null) ?? null,
    score: (row.score as number | null) ?? null,
    message: (row.message as string | null) ?? null,
    payload: parseJson<unknown>(row.payload, {}),
    created_at: row.created_at as string,
    received_at: row.received_at as string,
  };
}

export interface AppendEventInput {
  experiment_id: string;
  run_id: string;
  seq: number;
  type: string;
  payload: unknown;
  autonomation_run_id?: string | null;
  cycle_index?: number | null;
  candidate_ref?: string | null;
  metric?: string | null;
  score?: number | null;
  message?: string | null;
  created_at?: string;
}

export interface AppendEventResult {
  event: ExperimentEvent;
  inserted: boolean;
}

/**
 * Append a live event. (run_id, seq) is unique; a duplicate seq (at-least-once
 * delivery from the worker) is ignored idempotently and the existing row
 * returned, so a retried POST never double-writes the firehose.
 */
export function appendEventWithResult(input: AppendEventInput): AppendEventResult {
  const db = getDatabase();
  const existing = db
    .prepare('SELECT * FROM experiment_events WHERE run_id = ? AND seq = ?')
    .get(input.run_id, input.seq) as Record<string, unknown> | undefined;
  if (existing) return { event: rowToEvent(existing), inserted: false };

  const id = `exev_${nanoid()}`;
  db.prepare(
    `INSERT INTO experiment_events (
       id, experiment_id, run_id, autonomation_run_id, seq, type, cycle_index,
       candidate_ref, metric, score, message, payload, created_at, received_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.experiment_id,
    input.run_id,
    input.autonomation_run_id ?? null,
    input.seq,
    input.type,
    input.cycle_index ?? null,
    input.candidate_ref ?? null,
    input.metric ?? null,
    input.score ?? null,
    input.message ?? null,
    toJson(input.payload) ?? '{}',
    input.created_at ?? nowIso(),
    nowIso(),
  );
  return {
    event: rowToEvent(
      db.prepare('SELECT * FROM experiment_events WHERE id = ?').get(id) as Record<
        string,
        unknown
      >,
    ),
    inserted: true,
  };
}

export function appendEvent(input: AppendEventInput): ExperimentEvent {
  return appendEventWithResult(input).event;
}

export function listEventsForRun(
  runId: string,
  options: { afterSeq?: number; limit?: number } = {},
): ExperimentEvent[] {
  const db = getDatabase();
  const afterSeq = options.afterSeq ?? -1;
  const rows = db
    .prepare(
      `SELECT * FROM experiment_events WHERE run_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
    )
    .all(runId, afterSeq, options.limit ?? 1000) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

/** Highest `seq` recorded for a run, or -1 if none (worker seq starts at 0). */
export function maxSeqForRun(runId: string): number {
  const db = getDatabase();
  const row = db
    .prepare('SELECT MAX(seq) as m FROM experiment_events WHERE run_id = ?')
    .get(runId) as { m: number | null };
  return row.m ?? -1;
}
