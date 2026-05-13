/**
 * Spawn tracker for the scheduler's `fallback_spawn` feature.
 *
 * When a fire triggers an auto-spawn (because all configured target swarms
 * were offline), the spawned swarm's lifetime is tied to the dispatch
 * we're about to fire at it. This module records that binding in an
 * in-memory map (`dispatch_id → spawned hosted-swarm id`) so the dispatch
 * event bridge can stop the swarm when the dispatch reaches a terminal
 * state.
 *
 * In-memory only — orphan swarms on hub restart are accepted for v1.
 * A future iteration can persist this binding (e.g., new column on
 * dispatches or a separate `schedule_spawned_swarms` table) for crash
 * resilience.
 */

interface Binding {
  hostedSwarmId: string;
  cleanupOnTerminal: boolean;
}

const bindings = new Map<string, Binding>();

export function trackSpawnedFallback(
  dispatchId: string,
  hostedSwarmId: string,
  cleanupOnTerminal: boolean,
): void {
  bindings.set(dispatchId, { hostedSwarmId, cleanupOnTerminal });
}

export function takeSpawnedFallback(
  dispatchId: string,
): { hostedSwarmId: string; cleanupOnTerminal: boolean } | undefined {
  const b = bindings.get(dispatchId);
  if (!b) return undefined;
  bindings.delete(dispatchId);
  return b;
}

/** Test/debug — current in-flight bindings count. */
export function _bindingCount(): number {
  return bindings.size;
}

/** Test reset. */
export function _resetSpawnTracker(): void {
  bindings.clear();
}
