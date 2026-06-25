/**
 * Experiment lifecycle WS fan-out.
 *
 * Single helper for experiment-control-plane broadcasts, mirroring
 * `swarm-events.ts` / `workspace-events.ts`. Fans out to BOTH:
 *   - `map:experiments` — fleet overview (experiment list / dashboard)
 *   - `experiment:${experimentId}` — per-experiment detail (live run tail)
 *
 * Adding a new lifecycle type is a one-line change to the union here; every
 * emit site fans out correctly. The event types must also be present in the
 * `WSEventType` union in `src/types.ts` (closed union enforced by
 * `broadcastToChannel`).
 */

import { broadcastToChannel } from './index.js';

export type ExperimentLifecycleEventType =
  | 'experiment.updated'
  | 'experiment.run_started'
  | 'experiment.run_updated'
  | 'experiment.run_finished'
  | 'experiment.candidate';

export interface ExperimentLifecycleEvent {
  type: ExperimentLifecycleEventType;
  data: Record<string, unknown>;
}

export function broadcastExperimentLifecycleEvent(
  experimentId: string,
  event: ExperimentLifecycleEvent,
): void {
  broadcastToChannel('map:experiments', event);
  broadcastToChannel(`experiment:${experimentId}`, event);
}
