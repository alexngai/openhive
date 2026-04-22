/**
 * Dispatch start-time hook — advance opentasks tasks linked to the dispatch's
 * spec from `open` → `in_progress` when the orchestrator claims the row.
 *
 * Fired fire-and-forget after a successful `transitionDispatch('start')` in
 * the openhive source adapter. Best-effort: a daemon hiccup or offline swarm
 * never blocks the dispatch itself. Only tasks currently in `open` are
 * advanced, so retries are idempotent and completed tasks are never
 * regressed.
 */

import * as dispatchesDAL from '../db/dal/dispatches.js';
import { getTaskInternal, updateTaskInternal } from '../map/task-handler.js';

export async function advanceLinkedTasksOnStart(dispatchId: string): Promise<void> {
  const refs = dispatchesDAL.getDispatchLinkedTasks(dispatchId);
  if (refs.length === 0) return;

  for (const ref of refs) {
    if (ref.advanced_on_start) continue;
    try {
      const node = await getTaskInternal({ resource_id: ref.resource_id }, ref.node_id);
      // Remote-only resources return null from getTaskInternal today; skip
      // rather than risk bouncing a completed task back to in_progress.
      if (!node) continue;
      if (node.status !== 'open') continue;

      await updateTaskInternal(
        { resource_id: ref.resource_id },
        ref.node_id,
        { status: 'in_progress' },
      );
      dispatchesDAL.markTaskAdvanced(dispatchId, {
        resource_id: ref.resource_id,
        node_id: ref.node_id,
      });
    } catch {
      // Best-effort: keep advancing the rest.
    }
  }
}
