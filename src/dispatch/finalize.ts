/**
 * Dispatch finalization — single writer for terminal-status transitions.
 *
 * Both callers (the orchestrator event bridge in setup.ts and the agent-report
 * MAP handler in dispatch-handler.ts) funnel terminal writes through this
 * helper. It unconditionally recomputes `DispatchOutcome.artifacts` from the
 * cascade_streams rows that share task_refs with the dispatch's linked tasks,
 * merges with any agent-supplied artifacts, and writes the outcome atomically.
 *
 * This sidesteps the replace-vs-merge question on `dispatches.outcome`
 * (which is a wholesale-replace column): whichever path writes last, the
 * artifact set is correct by construction. The only field the two writers
 * compete over is `summary`/`error`, which is cosmetic.
 */

import * as dispatchesDAL from '../db/dal/dispatches.js';
import type { Dispatch, DispatchOutcome, DispatchStatus } from '../db/dal/dispatches.js';
import { findCascadeStreamsByTaskRefs } from '../db/dal/cascade-streams.js';
import { maybeRecordVerdictFromDispatch } from '../cascade/review-dispatch.js';

type TerminalStatus = Extract<DispatchStatus, 'complete' | 'failed' | 'cancelled'>;

type Artifact = { kind: string; ref: string };

export function finalizeDispatch(
  id: string,
  status: TerminalStatus,
  agentOutcome?: DispatchOutcome | null,
): Dispatch | null {
  const cascadeArtifacts = computeCascadeArtifacts(id);
  const agentArtifacts = agentOutcome?.artifacts ?? [];
  const artifacts = dedupByKindRef([...agentArtifacts, ...cascadeArtifacts]);

  const merged: DispatchOutcome = {
    ...(agentOutcome ?? {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };

  // If neither the agent nor the cascade join has anything to say, don't
  // persist an empty shell — write null so the UI can skip the section and
  // nobody's tempted to read meaning into {}.
  const outcome = Object.keys(merged).length > 0 ? merged : null;

  const updated = dispatchesDAL.updateDispatchStatus(id, status, outcome);

  // QC station Q3: a completed review dispatch writes its parsed verdict
  // back as an advisory agent verdict. No-op for every other dispatch;
  // idempotent across the two finalize callers; never throws.
  if (updated && status === 'complete') {
    maybeRecordVerdictFromDispatch(updated);
  }

  return updated;
}

function computeCascadeArtifacts(dispatchId: string): Artifact[] {
  const refs = dispatchesDAL.getDispatchLinkedTasks(dispatchId);
  if (refs.length === 0) return [];
  try {
    const streams = findCascadeStreamsByTaskRefs(
      refs.map((r) => ({ resource_id: r.resource_id, node_id: r.node_id })),
    );
    return streams.map((s) => ({
      kind: 'cascade_stream',
      ref: `${s.source_swarm_id}/${s.stream_id}`,
    }));
  } catch {
    return [];
  }
}

function dedupByKindRef(artifacts: Artifact[]): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const a of artifacts) {
    const key = `${a.kind}:${a.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
