/**
 * Reviewer dispatch (QC station Q3).
 *
 * Turns "get this stream reviewed" into an ordinary dispatch: the review
 * request creates a prompt dispatch (`role: 'reviewer'`) whose prompt embeds
 * the stream's cumulative diff via the five-tier resolver, and the reviewing
 * agent's completion report is parsed back into an ADVISORY agent verdict
 * carrying `dispatch_id` ([D3] — agent verdicts inform the human's
 * acceptance, they never satisfy a `required` policy).
 *
 * No new execution machinery: routing, loadouts, retry, and transports are
 * the dispatch pipeline's. Correlation rides `initiator_id =
 * 'review:<stream_row_id>'`, the same overload the scheduler uses
 * (`'schedule:<id>'`) — no schema change.
 *
 * The write-back seam is `finalizeDispatch` (src/dispatch/finalize.ts), the
 * single writer for terminal transitions on BOTH completion paths (agent
 * `map/dispatches/report` and the orchestrator event bridge). On `complete`
 * it calls `maybeRecordVerdictFromDispatch`, which no-ops for everything
 * that isn't a review dispatch.
 */

import {
  createDispatch,
  type Dispatch,
  type DispatchInitiatorType,
  type DispatchOutcome,
} from '../db/dal/dispatches.js';
import {
  getStreamByRowId,
  getLatestCommitForStream,
} from '../db/dal/cascade-streams.js';
import {
  recordVerdict,
  getCurrentVerdict,
  REVIEW_VERDICT_VALUES,
  type ReviewVerdictValue,
} from '../db/dal/cascade-review-verdicts.js';
import { resolveStreamDiff } from './diff-resolver.js';
import { postVerdictThreadTurn } from './review-thread.js';
import { mapHubEvents } from '../map/service.js';
import { broadcastToChannel } from '../realtime/index.js';

export const REVIEW_INITIATOR_PREFIX = 'review:';

/** Keep the inlined diff well under transport/prompt limits. */
const MAX_INLINE_DIFF_CHARS = 48_000;

export interface RequestReviewInput {
  streamRowId: string;
  /** Defaults to the stream's own swarm (reviewer runs where the repo is). */
  targetSwarmId?: string;
  initiatorType: DispatchInitiatorType;
}

export interface RequestReviewResult {
  dispatch: Dispatch;
  /** Whether the prompt carries the diff inline or defers to local inspection. */
  diff_inlined: boolean;
}

/**
 * Create a reviewer dispatch for a stream. Returns null when the stream
 * doesn't exist (caller maps to 404). The dispatch is a plain prompt
 * dispatch — the orchestrator claims and routes it like any other.
 */
export async function requestReviewDispatch(
  input: RequestReviewInput,
): Promise<RequestReviewResult | null> {
  const stream = getStreamByRowId(input.streamRowId);
  if (!stream) return null;

  const head = getLatestCommitForStream(stream.id);

  // Best-effort inline diff. Any resolver error (offline swarm, no
  // capability, no commits) degrades to "inspect locally" — the reviewer
  // runs on the swarm that owns the repo, so the branch is at hand.
  let diffSection: string;
  let diffInlined = false;
  try {
    const diff = await resolveStreamDiff({ stream_row_id: stream.id });
    if (diff.ok && typeof diff.payload.diff === 'string' && diff.payload.diff.length > 0) {
      const raw = diff.payload.diff;
      const clipped = raw.length > MAX_INLINE_DIFF_CHARS;
      diffSection = [
        '```diff',
        clipped ? raw.slice(0, MAX_INLINE_DIFF_CHARS) : raw,
        '```',
        clipped
          ? `\n(Diff truncated at ${MAX_INLINE_DIFF_CHARS} characters — inspect the branch locally for the remainder.)`
          : '',
      ].join('\n');
      diffInlined = true;
    } else {
      const reason = diff.ok ? 'empty diff' : diff.error.code;
      diffSection = `(Diff unavailable from the hub: ${reason}. Check out the branch locally and review the changes there.)`;
    }
  } catch (err) {
    diffSection = `(Diff unavailable from the hub: ${(err as Error).message}. Check out the branch locally and review the changes there.)`;
  }

  const taskLine =
    stream.task_resource_id && stream.task_node_id
      ? `Task: ${stream.task_resource_id}/${stream.task_node_id}\n`
      : '';

  const prompt = `You are acting as a code reviewer for a cascade stream on this hub.

Stream: ${stream.name} (${stream.stream_id})
Branch: ${stream.publish_branch ?? stream.branch_name ?? `stream/${stream.stream_id}`}
Base commit: ${stream.base_commit ?? 'unknown'}
Head commit: ${head?.commit_hash ?? 'unknown'}
${taskLine}
Review the change for correctness, safety, and fit with the surrounding code.

${diffSection}

When you finish, report this dispatch complete and include EXACTLY ONE fenced
JSON block in your final summary, of the form:

\`\`\`json
{"verdict": "approved", "notes": "<short rationale>"}
\`\`\`

where "verdict" is one of: "approved", "changes_requested", "rejected".

Your verdict is recorded as an ADVISORY agent verdict on the stream — a human
reviews it before acceptance. Be specific in the notes: name files and the
concrete defect or the concrete reason it is sound.`;

  const dispatch = createDispatch({
    spec_resource_id: 'ad_hoc',
    spec_id: `${REVIEW_INITIATOR_PREFIX}${stream.id}`,
    target_swarm_id: input.targetSwarmId ?? stream.source_swarm_id,
    initiator_type: input.initiatorType,
    initiator_id: `${REVIEW_INITIATOR_PREFIX}${stream.id}`,
    prompt_override: prompt,
    role: 'reviewer',
  });

  return { dispatch, diff_inlined: diffInlined };
}

/**
 * Extract a verdict from an agent's completion outcome. Accepts either a
 * structured `outcome.review_verdict` object or the LAST fenced ```json
 * block in `outcome.summary` carrying a valid `verdict` key (last wins —
 * the prompt shows an example block earlier in some agents' echoes).
 */
export function extractVerdictFromOutcome(
  outcome: DispatchOutcome | null | undefined,
): { verdict: ReviewVerdictValue; notes: string | null } | null {
  if (!outcome) return null;

  const structured = outcome.review_verdict;
  const fromStructured = coerceVerdict(structured);
  if (fromStructured) return fromStructured;

  if (typeof outcome.summary !== 'string') return null;
  const fenced = [...outcome.summary.matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    try {
      const parsed = coerceVerdict(JSON.parse(fenced[i][1]));
      if (parsed) return parsed;
    } catch {
      // Malformed block — keep scanning earlier ones.
    }
  }
  return null;
}

function coerceVerdict(
  raw: unknown,
): { verdict: ReviewVerdictValue; notes: string | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!REVIEW_VERDICT_VALUES.includes(obj.verdict as ReviewVerdictValue)) return null;
  return {
    verdict: obj.verdict as ReviewVerdictValue,
    notes: typeof obj.notes === 'string' && obj.notes.trim() ? obj.notes.trim() : null,
  };
}

/**
 * Post-finalize hook: when a completed dispatch is a review dispatch, parse
 * its outcome into an agent verdict at the stream's current head. Idempotent
 * per (dispatch, head): a re-finalize that would duplicate the same
 * dispatch's verdict at the same head is skipped. Never throws.
 */
export function maybeRecordVerdictFromDispatch(dispatch: Dispatch): void {
  try {
    if (dispatch.status !== 'complete') return;
    if (!dispatch.initiator_id?.startsWith(REVIEW_INITIATOR_PREFIX)) return;

    const streamRowId = dispatch.initiator_id.slice(REVIEW_INITIATOR_PREFIX.length);
    const stream = getStreamByRowId(streamRowId);
    if (!stream) return;

    const parsed = extractVerdictFromOutcome(dispatch.outcome);
    if (!parsed) return;

    const head = getLatestCommitForStream(stream.id)?.commit_hash ?? null;

    // Idempotency: finalize can run more than once for a dispatch (agent
    // report + orchestrator bridge). If this dispatch already produced the
    // current verdict at this head, don't append a duplicate.
    const current = getCurrentVerdict(stream.id, head);
    if (current?.dispatch_id === dispatch.id) return;

    const lastAttempt = dispatch.attempts_history[dispatch.attempts_history.length - 1];

    const verdict = recordVerdict({
      stream_row_id: stream.id,
      source_swarm_id: stream.source_swarm_id,
      stream_id: stream.stream_id,
      head_commit: head,
      verdict: parsed.verdict,
      reviewer_kind: 'agent',
      reviewer_id: lastAttempt?.agent_id ?? null,
      notes: parsed.notes,
      dispatch_id: dispatch.id,
    });

    try {
      mapHubEvents.emit('cascade_review_verdict_recorded', verdict);
    } catch {
      // Non-critical.
    }
    try {
      const wsMessage = { type: 'cascade:review_verdict' as const, data: verdict };
      broadcastToChannel(`cascade:stream:${stream.id}`, wsMessage);
      broadcastToChannel(`cascade:swarm:${stream.source_swarm_id}`, wsMessage);
      broadcastToChannel('global', wsMessage);
    } catch {
      // Non-critical.
    }

    // Close the feedback loop: the verdict lands in the author's work
    // thread (fire-and-forget; never rejects).
    void postVerdictThreadTurn(verdict, stream);
  } catch {
    // Never propagate into the finalize path.
  }
}
