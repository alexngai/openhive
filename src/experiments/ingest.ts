/**
 * Experiment ingest projection.
 *
 * Projects the runner's reported telemetry into hub state — the hub records,
 * it never decides. Two inputs (design §4.4):
 *   - the live event firehose → `experiment_events` (append-only) + a derived
 *     candidate row + the incumbent pointer on promotions;
 *   - the finalization POST → `content_hash`/`claim_strength`/score cards (the
 *     train-vs-held-out seesaw the event stream can't carry).
 *
 * autonomation events are camelCase (`candidateId`, `baseCommit`); the columns
 * are snake_case. The mapping lives here.
 */

import * as dal from '../db/dal/experiments.js';
import { broadcastExperimentLifecycleEvent } from '../realtime/experiment-events.js';
import type { IngestEvent, FinalizeRunBody } from '../api/schemas/experiments.js';

// Event type → projected candidate status. Events not listed are pure
// telemetry (stored, no candidate projection).
const EVENT_STATUS: Record<string, dal.CandidateStatus> = {
  baseline_complete: 'baseline',
  candidate_admitted: 'admitted',
  candidate_rejected: 'discard',
  promotion_keep: 'keep',
  promotion_discard: 'discard',
};

// Events that advance the incumbent (and mark the candidate promoted). The
// incumbent advances monotonically — only a keep/baseline moves it; a discard
// never targets the current incumbent in autonomation's gate model.
const PROMOTING = new Set(['baseline_complete', 'promotion_keep']);

export interface IngestResult {
  applied: number;
  candidatesTouched: number;
}

/**
 * Append + project a batch of live events. `appendEvent` is idempotent on
 * `(run_id, seq)`, so a retried POST is safe.
 */
export function ingestEvents(run: dal.ExperimentRun, events: IngestEvent[]): IngestResult {
  let applied = 0;
  let candidatesTouched = 0;

  for (const ev of events) {
    dal.appendEvent({
      experiment_id: run.experiment_id,
      run_id: run.id,
      autonomation_run_id: run.autonomation_run_id,
      seq: ev.seq,
      type: ev.type,
      cycle_index: ev.cycleIndex ?? null,
      candidate_ref: ev.candidateId ?? null,
      metric: ev.metric ?? null,
      score: ev.score ?? null,
      message: ev.message ?? null,
      payload: ev,
      created_at: ev.timestamp,
    });
    applied++;

    const status = EVENT_STATUS[ev.type];
    if (!status || !ev.candidateId) continue;

    const promoting = PROMOTING.has(ev.type);
    const cand = dal.upsertCandidate({
      experiment_id: run.experiment_id,
      run_id: run.id,
      candidate_ref: ev.candidateId,
      status,
      cycle_index: ev.cycleIndex,
      proposer: ev.proposer,
      base_commit: ev.baseCommit,
      head_commit: ev.headCommit,
      changed_paths: ev.changedPaths,
      failure_reason:
        ev.type === 'candidate_rejected' || ev.type === 'promotion_discard'
          ? ev.reason
          : undefined,
      promoted: promoting ? true : ev.type === 'promotion_discard' ? false : undefined,
    });
    candidatesTouched++;

    if (promoting) {
      dal.updateExperiment(run.experiment_id, { incumbent_candidate_id: cand.id });
    }

    broadcastExperimentLifecycleEvent(run.experiment_id, {
      type: 'experiment.candidate',
      data: {
        experiment_id: run.experiment_id,
        run_id: run.id,
        candidate_id: cand.id,
        candidate_ref: cand.candidate_ref,
        status: cand.status,
        promoted: cand.promoted,
      },
    });
  }

  return { applied, candidatesTouched };
}

/**
 * Apply the finalization payload: the run's lock + claim + counts, and the
 * per-candidate score cards (train + held-out) read from `runner.lineage`.
 * Candidates are matched by `(run_id, candidate_ref)` — if a candidate was
 * already projected from events, this updates it (status preserved when the
 * payload omits one); otherwise it is created with a derived status.
 */
export function finalizeRun(
  run: dal.ExperimentRun,
  payload: FinalizeRunBody,
): dal.ExperimentRun {
  const updated = dal.updateRun(run.id, {
    status: payload.status ?? 'complete',
    worker_token_hash: null, // §4.2: the per-run token dies with the run
    content_hash: payload.content_hash ?? undefined,
    claim_strength: payload.claim_strength ?? undefined,
    env_fingerprint: payload.env_fingerprint ?? undefined,
    stop_reason: payload.stop_reason ?? undefined,
    stop_message: payload.stop_message ?? undefined,
    summary: payload.summary ?? undefined,
    cycles: payload.cycles,
    total_proposed: payload.total_proposed,
    total_admitted: payload.total_admitted,
    total_promoted: payload.total_promoted,
    candidate_failures: payload.candidate_failures,
    finished_at: new Date().toISOString(),
  })!;

  // Back-fill the experiment's content_hash (its natural key) from the run's
  // lock if the experiment was created exploratory (null hash). Best-effort:
  // a unique collision means another experiment already owns that lock.
  if (payload.content_hash) {
    const exp = dal.findExperimentById(run.experiment_id);
    if (exp && !exp.content_hash) {
      try {
        dal.updateExperiment(exp.id, { content_hash: payload.content_hash });
      } catch {
        /* uq_experiments_chash collision — leave the experiment unkeyed */
      }
    }
  }

  let promotedHubId: string | undefined;
  for (const c of payload.candidates ?? []) {
    let parentHubId: string | null | undefined;
    if (c.parent_candidate_ref) {
      const parent = dal.findCandidate(run.id, c.parent_candidate_ref);
      parentHubId = parent ? parent.id : null;
    }

    // Derive a status only when inserting a never-before-seen candidate; on an
    // existing (event-projected) row, omit status to preserve its terminal state.
    const exists = dal.findCandidate(run.id, c.candidate_ref) !== null;
    const status = c.status ?? (exists ? undefined : c.promoted ? 'keep' : 'admitted');

    const cand = dal.upsertCandidate({
      experiment_id: run.experiment_id,
      run_id: run.id,
      candidate_ref: c.candidate_ref,
      status,
      parent_candidate_id: parentHubId,
      cycle_index: c.cycle_index,
      proposer: c.proposer,
      base_commit: c.base_commit,
      head_commit: c.head_commit,
      changed_paths: c.changed_paths,
      overlay: c.overlay,
      content_hash: c.content_hash,
      score_train: c.score_train,
      score_held_out: c.score_held_out,
      scores: c.scores,
      promoted: c.promoted,
      rationale: c.rationale,
      failure_reason: c.failure_reason,
    });
    if (c.promoted) promotedHubId = cand.id;
  }

  if (promotedHubId) {
    dal.updateExperiment(run.experiment_id, { incumbent_candidate_id: promotedHubId });
  }

  broadcastExperimentLifecycleEvent(run.experiment_id, {
    type: 'experiment.run_finished',
    data: {
      experiment_id: run.experiment_id,
      run_id: run.id,
      status: updated.status,
      stop_reason: updated.stop_reason,
    },
  });

  return updated;
}
