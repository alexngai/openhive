/**
 * Spec Broadcast De-duplication
 *
 * Short-window TTL cache that prevents the same `spec.*` event from being
 * broadcast twice when multiple paths touch the same local daemon:
 *
 *   - REST handler writes a spec + broadcasts directly (`src/api/routes/specs.ts`)
 *   - MAP `map/specs/author` handler writes + broadcasts (`src/map/spec-handler.ts`)
 *   - Opentasks daemon watcher fires → cc-swarm sidecar bridge emits
 *     `context.created` → hub's `handleMapContextEvent` broadcasts (`src/coordination/listener.ts`)
 *
 * In deployments where openhive and a cc-swarm sidecar share an opentasks
 * daemon (typical local/dev setups), both the explicit broadcast and the
 * watcher-driven rebroadcast would fire for the same spec. The frontend's
 * realtime invalidation handles this gracefully, but the second broadcast
 * carries stale initiator info (`{type:'agent'}` instead of the first
 * broadcast's `{type:'user'}` or author-specific agent id), which shows up
 * in UI chips.
 *
 * Rule: first broadcast wins, subsequent matching broadcasts within
 * `DEDUP_WINDOW_MS` are suppressed. Keyed by `type + resource + spec.id` —
 * a `spec.created` and a later `spec.updated` on the same spec are
 * independent keys so genuine state changes still flow.
 *
 * Remote-swarm deployments (where only the sidecar bridge can reach the
 * hub) pay no cost — only one path fires, so the cache never matches.
 */

const DEDUP_WINDOW_MS = 2000;

const recent = new Map<string, number>();
let gcTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleGc(): void {
  if (gcTimer) return;
  gcTimer = setTimeout(() => {
    gcTimer = null;
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [k, t] of recent) {
      if (t < cutoff) recent.delete(k);
    }
    if (recent.size > 0) scheduleGc();
  }, DEDUP_WINDOW_MS);
  gcTimer.unref?.();
}

/**
 * Check whether this spec event should be broadcast now.
 *
 * Returns `true` the first time a given `(type, resource_id, spec_id)` is
 * seen within the dedup window, and atomically records the timestamp.
 * Returns `false` for subsequent matching calls until the window elapses.
 *
 * Call sites call this immediately before `broadcastToChannel`, skipping
 * the broadcast when this returns false.
 */
export function shouldBroadcastSpecEvent(
  type: 'spec.created' | 'spec.updated',
  resourceId: string,
  specId: string,
): boolean {
  const key = `${type}:${resourceId}:${specId}`;
  const now = Date.now();
  const prev = recent.get(key);
  if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) {
    return false;
  }
  recent.set(key, now);
  scheduleGc();
  return true;
}

/**
 * Test-only helper to clear the dedup cache and cancel any pending GC.
 * Not exported to consumers outside the test suite.
 */
export function _resetSpecBroadcastDedup(): void {
  recent.clear();
  if (gcTimer) {
    clearTimeout(gcTimer);
    gcTimer = null;
  }
}
