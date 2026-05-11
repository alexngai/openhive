/**
 * OpenTeams MAP Resource Protocol handlers.
 *
 * Layer 2 of the openteams integration: exposes the `x-openteams/loadout`
 * and `x-openteams/team` resource kinds over the MAP Resource Protocol so a
 * connected agent (any runtime — Claude Code, Gemini, Codex) can fetch a
 * content-addressed bundle by `sha256:<hex>` via
 * `map/resources/get { type: "x-openteams/loadout", id }`.
 *
 * The store is an in-memory singleton this iteration; v2 promotes it to a
 * `team_bundles` table for persistence across restarts. Bundles are seeded
 * on boot from authored content in `syncable_resources` (see `seed.ts`) and
 * kept in sync on write via `sync-bridge.ts`.
 *
 * Cooperation with future openhive-owned MAP resource kinds: the openteams
 * `composeResourceHandlers` accepts a `fallback: { list, get }` option that
 * routes unknown `params.type` values to a host dispatcher. We don't pass
 * a fallback here today because openhive's MAP server doesn't register its
 * own `map/resources/list/get` yet — when it does, swap in the fallback
 * without rewiring callers.
 */

import {
  InMemoryBundleStore,
  composeResourceHandlers,
  createLoadoutKindHandler,
  createTeamKindHandler,
  LOADOUT_RESOURCE_TYPE,
  TEAM_RESOURCE_TYPE,
} from 'openteams';
import type { BundleEvent, BundleStore } from 'openteams';

// ── Singleton state (lazy) ──────────────────────────────────────────────────

let store: BundleStore | null = null;
let composed: ReturnType<typeof composeResourceHandlers> | null = null;
let emitListener: ((event: BundleEvent) => void) | null = null;

/**
 * Get the bundle store. Lazy — first call constructs the singleton, every
 * subsequent call returns it. Tests can reset via `_resetOpenteamsMapHandlers`.
 */
export function getOpenteamsBundleStore(): BundleStore {
  if (!store) {
    store = new InMemoryBundleStore();
  }
  return store;
}

/**
 * Compose the openteams kind handlers, lazily. Calling this fixes the store
 * and emit listener; callers that need to attach an event-bus listener
 * BEFORE handlers are composed should use `setOpenteamsBundleEmitter` first.
 */
export function getOpenteamsMapHandlers(): ReturnType<typeof composeResourceHandlers> {
  if (!composed) {
    const s = getOpenteamsBundleStore();
    const emit = (event: BundleEvent): void => {
      if (emitListener) emitListener(event);
    };
    composed = composeResourceHandlers([
      createLoadoutKindHandler({ store: s, emit }),
      createTeamKindHandler({ store: s, emit }),
    ]);
  }
  return composed;
}

/** The MAP `type` strings this module owns. Mirrors openteams's exports. */
export function getOpenteamsResourceKinds(): readonly string[] {
  return [LOADOUT_RESOURCE_TYPE, TEAM_RESOURCE_TYPE];
}

/**
 * Attach a listener for `resource.added`/`updated`/`removed` lifecycle
 * events from the kind handlers. Called from the MAP server bootstrap
 * to bridge to the SDK event bus.
 */
export function setOpenteamsBundleEmitter(listener: ((event: BundleEvent) => void) | null): void {
  emitListener = listener;
}

/**
 * Test-only: reset the singleton. Production code never calls this.
 */
export function _resetOpenteamsMapHandlers(): void {
  store = null;
  composed = null;
  emitListener = null;
}
