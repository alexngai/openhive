/**
 * Coordination Compatibility Shim — DEPRECATED
 *
 * This module previously translated MAP task events into direct graph.jsonl
 * mutations on the hub. It was removed because:
 *
 * 1. The hub is a relay, not a task store — agents own their graphs via
 *    local OpenTasks daemons.
 * 2. The shim wrote to graph.jsonl directly, but the daemon reads from
 *    SQLite — so shim writes were invisible to all daemon-based queries.
 * 3. Agent-side sync (pushSyncEvent) handles cross-agent task propagation.
 * 4. Hub events (mapHubEvents) + WebSocket broadcasts provide real-time
 *    observability without persistence.
 *
 * The functions below are retained as no-ops for any external consumers
 * that may still reference them. They will be fully removed in a future release.
 */

import type { TaskAssignParams, TaskStatusParams } from './types.js';

/** @deprecated No-op. Hub no longer persists task state. */
export function shimTaskAssign(
  _params: TaskAssignParams,
  _agentId: string,
): string | null {
  return null;
}

/** @deprecated No-op. Hub no longer persists task state. */
export function shimTaskStatus(
  _params: TaskStatusParams,
  _agentId: string,
): boolean {
  return false;
}
