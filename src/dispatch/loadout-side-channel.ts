/**
 * Loadout side-channel — bridges `enrichWithLoadout` (source) to the
 * mail-port's `deliver` call so structured loadout fields (permissions,
 * mcpProviders) can ride along in the envelope's `body.metadata`.
 *
 * Why this exists:
 *
 *   `swarm-dispatch.MessagePort.deliver(to, payload)` is typed with a
 *   fixed payload shape — `{ prompt, taskId, role }` — and the
 *   library's `createMailPort` only forwards those three fields into
 *   the envelope body. There's no slot for structured metadata in the
 *   public surface.
 *
 *   Loadout permissions can't ride in the prompt body (the worker's
 *   Claude SDK consumes them as JSON, not text). So we need a
 *   side-channel keyed by taskId: the source registers the materialized
 *   loadout when it enriches a task; the mail port reads it when
 *   delivering and injects into `body.metadata`.
 *
 * Lifetime: registrations are bounded by TTL so a never-delivered task
 * can't pin memory. Successful deliveries call `consume()` which deletes
 * eagerly.
 */

import type { MaterializedLoadout } from '../openteams/types.js';

/**
 * Per-dispatch hints that don't ride in MaterializedLoadout but are
 * needed by the runtime adapter at resolveTarget time. Step 6 of the
 * ACP+lifecycle plan: lifecycle override (fresh|reuse) sourced from
 * spec metadata (most specific) or loadout's `openhive.acp_lifecycle`
 * consumer extension namespace.
 */
export interface DispatchHints {
  acpLifecycle?: 'fresh' | 'reuse';
}

interface CacheEntry {
  loadout: MaterializedLoadout;
  hints?: DispatchHints;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [taskId, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(taskId);
  }
}

/** Register a materialized loadout (and optional hints) for a dispatch taskId. */
export function registerLoadoutForDispatch(
  taskId: string,
  loadout: MaterializedLoadout,
  hints?: DispatchHints,
): void {
  cache.set(taskId, {
    loadout,
    ...(hints ? { hints } : {}),
    expiresAt: Date.now() + TTL_MS,
  });
  // Opportunistic prune so the map stays bounded even if never consumed.
  if (cache.size % 32 === 0) pruneExpired();
}

/**
 * Read the dispatch hints for a taskId without removing them. Used by
 * the runtime adapter to make the lifecycle decision at resolveTarget
 * time. Hints survive `consumeLoadoutForDispatch` only via the cache
 * entry that's still present until consume; the mail-port consumes the
 * loadout entry, after which hints are also gone.
 */
export function peekHintsForDispatch(taskId: string): DispatchHints | null {
  pruneExpired();
  return cache.get(taskId)?.hints ?? null;
}

/** Read the materialized loadout for a taskId without removing it. */
export function peekLoadoutForDispatch(
  taskId: string,
): MaterializedLoadout | null {
  pruneExpired();
  return cache.get(taskId)?.loadout ?? null;
}

/** Read and delete the materialized loadout for a taskId. */
export function consumeLoadoutForDispatch(
  taskId: string,
): MaterializedLoadout | null {
  pruneExpired();
  const entry = cache.get(taskId);
  if (!entry) return null;
  cache.delete(taskId);
  return entry.loadout;
}

/** Test-only: clear all entries. */
export function _resetLoadoutSideChannelForTest(): void {
  cache.clear();
}

/** Test-only: report current size. */
export function _loadoutSideChannelSizeForTest(): number {
  return cache.size;
}
