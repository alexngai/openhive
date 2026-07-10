/**
 * DAL for cascade_review_verdicts (V66) — hub-owned QC records over cascade
 * streams. The "verified" fact of the factory's spec→verified-merge unit of
 * production: who accepted which code, at which head.
 *
 * Semantics (docs/design/cascade-review-verdicts.md):
 *   - Append-only. A verdict is never updated; superseding means writing a
 *     new row. The latest row per (stream_row_id, head_commit) is current.
 *   - head_commit is resolved server-side at verdict time from the stream's
 *     latest projected commit — a new push changes the join key, so prior
 *     approvals stop being "current" by construction.
 *   - These rows are NOT cascade state (runtimes own that); they join to the
 *     hub's read-only projections. Never cleaned by cache sweeps — they are
 *     the audit trail.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';

export type ReviewVerdictValue = 'approved' | 'changes_requested' | 'rejected';
export type ReviewerKind = 'human' | 'agent';

export const REVIEW_VERDICT_VALUES: readonly ReviewVerdictValue[] = [
  'approved',
  'changes_requested',
  'rejected',
];

export interface CascadeReviewVerdict {
  id: string;
  stream_row_id: string;
  source_swarm_id: string;
  stream_id: string;
  /** Head commit the reviewer looked at; null when the stream had no projected commits. */
  head_commit: string | null;
  verdict: ReviewVerdictValue;
  reviewer_kind: ReviewerKind;
  reviewer_id: string | null;
  notes: string | null;
  /** Set when the verdict was produced by a reviewer dispatch (Q3). */
  dispatch_id: string | null;
  created_at: string;
}

export interface RecordVerdictInput {
  stream_row_id: string;
  source_swarm_id: string;
  stream_id: string;
  head_commit: string | null;
  verdict: ReviewVerdictValue;
  reviewer_kind: ReviewerKind;
  reviewer_id?: string | null;
  notes?: string | null;
  dispatch_id?: string | null;
}

type Row = Record<string, unknown>;

function rowToVerdict(row: Row): CascadeReviewVerdict {
  return {
    id: row.id as string,
    stream_row_id: row.stream_row_id as string,
    source_swarm_id: row.source_swarm_id as string,
    stream_id: row.stream_id as string,
    head_commit: (row.head_commit as string | null) ?? null,
    verdict: row.verdict as ReviewVerdictValue,
    reviewer_kind: row.reviewer_kind as ReviewerKind,
    reviewer_id: (row.reviewer_id as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    dispatch_id: (row.dispatch_id as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

/** Append a verdict row. Never updates — supersede by inserting again. */
export function recordVerdict(input: RecordVerdictInput): CascadeReviewVerdict {
  const db = getDatabase();
  const id = `rv_${nanoid()}`;
  // "Latest wins" needs a total order. ISO timestamps have millisecond
  // precision, so two verdicts written in the same ms would tie and fall
  // back to random-id ordering. Keep created_at strictly monotonic per
  // stream: if the clock hasn't advanced past the stream's newest row,
  // step 1ms beyond it.
  let created_at = new Date().toISOString();
  const newest = db
    .prepare(
      `SELECT MAX(created_at) AS m FROM cascade_review_verdicts WHERE stream_row_id = ?`
    )
    .get(input.stream_row_id) as { m: string | null };
  if (newest.m && created_at <= newest.m) {
    created_at = new Date(new Date(newest.m).getTime() + 1).toISOString();
  }
  db.prepare(
    `INSERT INTO cascade_review_verdicts (
      id, stream_row_id, source_swarm_id, stream_id, head_commit,
      verdict, reviewer_kind, reviewer_id, notes, dispatch_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.stream_row_id,
    input.source_swarm_id,
    input.stream_id,
    input.head_commit,
    input.verdict,
    input.reviewer_kind,
    input.reviewer_id ?? null,
    input.notes ?? null,
    input.dispatch_id ?? null,
    created_at
  );
  return {
    id,
    stream_row_id: input.stream_row_id,
    source_swarm_id: input.source_swarm_id,
    stream_id: input.stream_id,
    head_commit: input.head_commit,
    verdict: input.verdict,
    reviewer_kind: input.reviewer_kind,
    reviewer_id: input.reviewer_id ?? null,
    notes: input.notes ?? null,
    dispatch_id: input.dispatch_id ?? null,
    created_at,
  };
}

/** Full verdict history for a stream, newest first. */
export function listVerdictsForStream(
  stream_row_id: string,
  options: { limit?: number; offset?: number } = {}
): { verdicts: CascadeReviewVerdict[]; total: number } {
  const db = getDatabase();
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM cascade_review_verdicts WHERE stream_row_id = ?`
      )
      .get(stream_row_id) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT * FROM cascade_review_verdicts
       WHERE stream_row_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(stream_row_id, options.limit ?? 50, options.offset ?? 0) as Row[];
  return { verdicts: rows.map(rowToVerdict), total };
}

/**
 * The current verdict at a given head: the newest row whose head_commit
 * matches (`IS` so a null head matches null). Returns null when the head has
 * never been reviewed — including the "approved at an older head" case,
 * which is exactly the invalidation-on-push semantics we want.
 */
export function getCurrentVerdict(
  stream_row_id: string,
  head_commit: string | null
): CascadeReviewVerdict | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM cascade_review_verdicts
       WHERE stream_row_id = ? AND head_commit IS ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(stream_row_id, head_commit) as Row | undefined;
  return row ? rowToVerdict(row) : null;
}

/**
 * The gate predicate ([D3]): a stream is approved at a head only when the
 * current verdict there is a HUMAN `approved`. Agent approvals are advisory
 * and never satisfy this. Not consulted by any gate yet (Q2 wires it).
 */
export function isApprovedAtHead(
  stream_row_id: string,
  head_commit: string | null
): boolean {
  const current = getCurrentVerdict(stream_row_id, head_commit);
  return (
    current !== null &&
    current.verdict === 'approved' &&
    current.reviewer_kind === 'human'
  );
}
