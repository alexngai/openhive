/**
 * Task status broadcast helper.
 *
 * Consolidates the previously scattered `task.status` broadcast emissions in
 * `coordination/listener.ts`, `map/task-handler.ts`, and
 * `api/routes/resource-content.ts` into a single code path. Three goals:
 *
 *   1. One shape for downstream consumers regardless of initiator (agent,
 *      user, CLI). Before this helper, payload keys drifted between sites.
 *   2. One site responsible for cascade enrichment — on transitions into a
 *      terminal status, when the task's owning resource is known, the helper
 *      queries `getCommitRangeForTask` and attaches a `cascade` block to the
 *      broadcast. Absent cascade data, the block is omitted.
 *   3. One subscription surface — `mapHubEvents.task_status_changed` fires
 *      uniformly whether the status change originated inbound (MAP scope)
 *      or via hub-driven update handlers.
 */

import { mapHubEvents } from './service.js';
import { broadcastToChannel } from '../realtime/index.js';
import { getCommitRangeForTask } from '../db/dal/cascade-streams.js';
import type { CascadeCommitRange } from '../db/dal/cascade-streams.js';

/**
 * Status values treated as "closed/done" for cascade enrichment purposes.
 * Covers both the opentasks daemon's direct terminal set (`completed`,
 * `failed`, `cancelled`) and the native-provider mapping that lands as
 * `closed`, plus an informal `done` alias used by some callers.
 */
const TERMINAL_STATUSES = new Set([
  'completed',
  'closed',
  'done',
  'failed',
  'cancelled',
]);

export interface TaskStatusCascadeBlock {
  commit_ranges: CascadeCommitRange[];
  total_commits: number;
  total_streams: number;
}

export interface BroadcastTaskStatusInput {
  /** Opentasks node id. */
  taskId: string;
  /** New status value (e.g. `completed`, `in_progress`). */
  status: string;
  /** Previous status, if known. */
  previous?: string;
  /**
   * Owning task-graph resource id (syncable_resources.id). When provided,
   * enables per-task channel broadcast and cascade enrichment on terminal
   * transitions. When absent, only the fleet-wide `map:tasks` channel is
   * broadcast — matches the pre-consolidation behavior for inbound MAP
   * scope task events that don't carry resource scope.
   */
  resourceId?: string;
  /**
   * Task node id used for the cascade join. Defaults to `taskId` — explicit
   * only when the caller knows the opentasks node id differs from the
   * bridge-level task id.
   */
  nodeId?: string;
}

/**
 * Emit the hub-level task_status_changed event and broadcast the
 * `task.status` message to all relevant WS channels. Attaches a `cascade`
 * block when the transition is terminal and cascade data exists.
 *
 * Safe to call with or without `resourceId`. Never throws.
 */
export function broadcastTaskStatus(input: BroadcastTaskStatusInput): void {
  const cascade = resolveCascadeEnrichment(input);

  try {
    mapHubEvents.emit('task_status_changed', {
      task_id: input.taskId,
      status: input.status,
      previous: input.previous,
      resource_id: input.resourceId,
      node_id: input.nodeId ?? input.taskId,
      cascade,
    });
  } catch {
    // Listener exceptions must not break the broadcast path.
  }

  const wsData: Record<string, unknown> = {
    taskId: input.taskId,
    current: input.status,
  };
  if (input.previous !== undefined) wsData.previous = input.previous;
  if (cascade) wsData.cascade = cascade;

  try {
    broadcastToChannel('map:tasks', { type: 'task.status', data: wsData });
  } catch {
    // WS transport failure is non-fatal.
  }

  if (input.resourceId) {
    try {
      broadcastToChannel(`resource:task:${input.resourceId}`, {
        type: 'task.status',
        data: wsData,
      });
    } catch {
      // Non-critical.
    }
  }
}

function resolveCascadeEnrichment(
  input: BroadcastTaskStatusInput,
): TaskStatusCascadeBlock | undefined {
  if (!input.resourceId) return undefined;
  if (!TERMINAL_STATUSES.has(input.status)) return undefined;

  const nodeId = input.nodeId ?? input.taskId;
  let ranges: CascadeCommitRange[];
  try {
    ranges = getCommitRangeForTask(input.resourceId, nodeId);
  } catch {
    return undefined;
  }
  if (!ranges || ranges.length === 0) return undefined;

  let totalCommits = 0;
  for (const r of ranges) totalCommits += r.commits.length;

  return {
    commit_ranges: ranges,
    total_commits: totalCommits,
    total_streams: ranges.length,
  };
}
