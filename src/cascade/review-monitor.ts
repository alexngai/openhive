/**
 * Review monitor + gate helper (QC station Q2).
 *
 * Two responsibilities, one module (mirrors `task-binder.ts` in shape):
 *
 * 1. **Gate resolution** — `resolveStreamReviewGate(stream)` joins the
 *    three-scope review policy (task > swarm > hub) with the stream's
 *    current-head verdict. Route gates (hub-initiated merge, PR-stack
 *    opener) consult it; when the policy is `required` and there is no
 *    current-head HUMAN approval, the landing action is withheld.
 *
 * 2. **Unreviewed-merge detection** — subscribes to
 *    `mapHubEvents.cascade_stream_merged`. Agent-local merges can't be
 *    blocked from the hub ([D4]); instead a merge that lands without a
 *    qualifying approval under an `advisory`/`required` policy is recorded
 *    as a first-class quality-escape signal: `cascade_unreviewed_merge`
 *    hub event + `cascade:unreviewed_merge` WS broadcast. Durable counts
 *    are derivable by joining merge projections against verdicts — the
 *    event stream is the live surface, not the ledger.
 *
 * Zero-cost default: with `defaultReviewPolicy: 'none'` and no per-task /
 * per-swarm opt-in, the merge handler does one policy resolution per merge
 * and returns. Hub invariants preserved — this module never writes cascade
 * state or task state.
 */

import { mapHubEvents } from '../map/service.js';
import { resolveReviewPolicy, type ReviewPolicy } from './policy.js';
import { getAggregateCapabilities } from '../map/connection-registry.js';
import { findResourceById } from '../db/dal/syncable-resources.js';
import {
  getLatestCommitForStream,
  type CascadeStream,
} from '../db/dal/cascade-streams.js';
import {
  getCurrentVerdict,
  type CascadeReviewVerdict,
} from '../db/dal/cascade-review-verdicts.js';
import { broadcastToChannel } from '../realtime/index.js';

/** Payload shape emitted by `cascade-handler.handleStreamMerged`. */
interface CascadeStreamMergedEvent {
  source_swarm_id: string;
  merge_row_id?: string;
  source_stream_row_id?: string | null;
  source_stream_id?: string;
  target_stream_id?: string;
  merge_commit?: string;
  agent_id?: string | null;
  task_ref?: { resource_id: string; node_id: string };
}

export interface ReviewMonitorDeps {
  /** Hub-wide default policy. Read once at start; changes require restart. */
  defaultReviewPolicy: ReviewPolicy;
}

let activeHandler: ((event: CascadeStreamMergedEvent) => void) | null = null;
let activeDeps: ReviewMonitorDeps | null = null;

/** The hub default as configured at start; `'none'` when not started (tests). */
export function getDefaultReviewPolicy(): ReviewPolicy {
  return activeDeps?.defaultReviewPolicy ?? 'none';
}

/**
 * Begin listening for cascade merge events. Idempotent — calling twice is
 * safe; the second call replaces the first.
 */
export function startReviewMonitor(deps: ReviewMonitorDeps): void {
  stopReviewMonitor();
  activeDeps = deps;
  const handler = (eventData: unknown) => {
    try {
      handleStreamMergedForReview(eventData as CascadeStreamMergedEvent, deps);
    } catch {
      // Never throw into mapHubEvents.
    }
  };
  activeHandler = handler;
  mapHubEvents.on('cascade_stream_merged', handler);
}

/** Stop listening. Safe to call when not started. */
export function stopReviewMonitor(): void {
  if (activeHandler) {
    mapHubEvents.off('cascade_stream_merged', activeHandler);
    activeHandler = null;
  }
  activeDeps = null;
}

export interface StreamReviewGate {
  policy: ReviewPolicy;
  /** Head the gate evaluated (latest projected commit; null = no commits). */
  head_commit: string | null;
  /** Current verdict at that head, if any (human or agent). */
  current_verdict: CascadeReviewVerdict | null;
  /** [D3]: current-head HUMAN `approved`. */
  approved: boolean;
  /** True when policy is `required` and not approved — withhold landing. */
  blocked: boolean;
}

/**
 * Join policy + current-head verdict for a stream. Used by the route gates
 * and the merge monitor. Never throws — lookup failures degrade to the
 * hub-default policy with no verdict.
 */
export function resolveStreamReviewGate(
  stream: Pick<CascadeStream, 'id' | 'source_swarm_id' | 'task_resource_id'>,
  defaultReviewPolicy: ReviewPolicy = getDefaultReviewPolicy(),
): StreamReviewGate {
  let taskMetadata: Record<string, unknown> | null = null;
  try {
    if (stream.task_resource_id) {
      taskMetadata = findResourceById(stream.task_resource_id)?.metadata ?? null;
    }
  } catch {
    // Task scope unavailable — fall through to swarm/hub scopes.
  }

  const policy = resolveReviewPolicy({
    taskMetadata,
    swarmCapabilities: getAggregateCapabilities(stream.source_swarm_id) ?? null,
    hubConfig: { defaultReviewPolicy },
  });

  let head_commit: string | null = null;
  let current_verdict: CascadeReviewVerdict | null = null;
  try {
    head_commit = getLatestCommitForStream(stream.id)?.commit_hash ?? null;
    current_verdict = getCurrentVerdict(stream.id, head_commit);
  } catch {
    // No verdict data — treat as unreviewed.
  }

  const approved =
    current_verdict?.verdict === 'approved' &&
    current_verdict.reviewer_kind === 'human';

  return {
    policy,
    head_commit,
    current_verdict,
    approved,
    blocked: policy === 'required' && !approved,
  };
}

/** Exported for tests — runs the detection path synchronously. */
export function handleStreamMergedForReview(
  event: CascadeStreamMergedEvent,
  deps: ReviewMonitorDeps = activeDeps ?? { defaultReviewPolicy: 'none' },
): void {
  const streamRowId = event.source_stream_row_id;
  if (!streamRowId) return;

  const gate = resolveStreamReviewGate(
    {
      id: streamRowId,
      source_swarm_id: event.source_swarm_id,
      task_resource_id: event.task_ref?.resource_id ?? null,
    },
    deps.defaultReviewPolicy,
  );

  // `none` → not a QC-tracked stream; approved → a verified merge. Either
  // way nothing to flag.
  if (gate.policy === 'none' || gate.approved) return;

  const summary = {
    source_swarm_id: event.source_swarm_id,
    stream_row_id: streamRowId,
    source_stream_id: event.source_stream_id,
    merge_commit: event.merge_commit,
    merge_row_id: event.merge_row_id,
    agent_id: event.agent_id ?? null,
    policy: gate.policy,
    head_commit: gate.head_commit,
    /** What the head *did* have, if anything (agent-advisory, stale, etc.). */
    current_verdict: gate.current_verdict
      ? {
          verdict: gate.current_verdict.verdict,
          reviewer_kind: gate.current_verdict.reviewer_kind,
          reviewer_id: gate.current_verdict.reviewer_id,
        }
      : null,
  };

  try {
    mapHubEvents.emit('cascade_unreviewed_merge', summary);
  } catch {
    // Non-critical.
  }
  try {
    const wsMessage = { type: 'cascade:unreviewed_merge' as const, data: summary };
    broadcastToChannel(`cascade:stream:${streamRowId}`, wsMessage);
    broadcastToChannel(`cascade:swarm:${event.source_swarm_id}`, wsMessage);
    broadcastToChannel('global', wsMessage);
  } catch {
    // Non-critical.
  }
}
