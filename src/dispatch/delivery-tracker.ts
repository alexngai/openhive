/**
 * Delivery tracker — bridges OpenHive transport adapters with the
 * `dispatched` event in setup.ts so per-attempt rows in `attempts_history`
 * carry the actual transport (acp | mail) used.
 *
 * Why a side-channel instead of direct DB writes from each adapter:
 *   - The orchestrator's `dispatched` event is the authoritative source of
 *     `attempt` and `agentId`. Adapters running ahead of the event don't
 *     yet know which attempt number their delivery will be recorded against
 *     (the orchestrator may bump attempt between claim and delivery).
 *   - A single write site (the event bridge in setup.ts) keeps the
 *     attempts_history merge logic centralized.
 *
 * Lifecycle: adapter calls `markDelivery(taskId, ...)` at the moment of
 * delivery; setup.ts calls `claimDelivery(taskId)` on the `dispatched`
 * event, reads + clears in one pass, and persists via DAL. Stale entries
 * (delivery succeeded but no `dispatched` event followed — shouldn't happen,
 * but cheap to defend) clear themselves on the next mark for the same task.
 */

export interface DeliveryHint {
  transport: 'acp' | 'mail';
  agent_id?: string;
}

const hints = new Map<string, DeliveryHint>();

export function markDelivery(taskId: string, hint: DeliveryHint): void {
  hints.set(taskId, hint);
}

export function claimDelivery(taskId: string): DeliveryHint | undefined {
  const hint = hints.get(taskId);
  if (hint) hints.delete(taskId);
  return hint;
}

// =============================================================================
// Thread-driven continuation tracking
// =============================================================================
//
// Tracks how many extra turns have been granted to a dispatch because of
// pending thread messages. The continuationPolicy in setup.ts uses this to
// cap thread-driven continuations (maxThreadTurns) independently of the
// overall turn budget (maxTurns). Without a cap, a chatty thread could
// keep the agent alive indefinitely.

const threadDrivenCounts = new Map<string, number>();

export function incrementThreadDrivenCount(taskId: string): number {
  const current = threadDrivenCounts.get(taskId) ?? 0;
  const next = current + 1;
  threadDrivenCounts.set(taskId, next);
  return next;
}

export function getThreadDrivenCount(taskId: string): number {
  return threadDrivenCounts.get(taskId) ?? 0;
}

export function clearThreadDrivenCount(taskId: string): void {
  threadDrivenCounts.delete(taskId);
}

/** Test helper — reset all in-memory state. */
export function _resetDeliveryTrackerForTest(): void {
  hints.clear();
  threadDrivenCounts.clear();
}
