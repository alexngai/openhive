/**
 * Dispatch Policy — runtime toggles for the dispatch primitive.
 *
 * Per D9 there is no per-agent capability gating for dispatch. The hub does,
 * however, expose a global "kill switch" for autonomous dispatch — when
 * enabled, agent-initiated dispatches via `map/specs/dispatch` are rejected
 * while user-initiated dispatches via REST continue to work. This is the
 * emergency brake for runaway autonomous chains.
 *
 * Runtime in-memory state: this is intentionally not persisted. Admins flip
 * it via the admin API; restarts default back to "not paused." If a project
 * grows real safety policies these become candidates to migrate to durable
 * config or per-agent capability flags (the deferred D9 retrofit path).
 */

let autonomousDispatchPaused = false;

export function isAutonomousDispatchPaused(): boolean {
  return autonomousDispatchPaused;
}

export function setAutonomousDispatchPaused(paused: boolean): void {
  autonomousDispatchPaused = paused;
}

/** Test helper — restores the default. */
export function resetDispatchPolicy(): void {
  autonomousDispatchPaused = false;
}
