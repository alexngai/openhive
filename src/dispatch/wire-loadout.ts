/**
 * Wire-shape conversion for `MaterializedLoadout`.
 *
 * Both dispatch wire paths — the mail envelope's `body.loadout` and the
 * ACP `dispatch/spawn-agent` MAP request params — carry the same
 * structural subset of `MaterializedLoadout`. This module is the single
 * source of truth for that conversion so the two routes can't drift.
 *
 * What's included:
 *   - permissions (allow/deny/ask) when any rule is present
 *   - mcpProviders when non-empty
 *   - mcpScope when non-empty
 *   - capabilities when non-empty
 *
 * What's NOT included (rides in the prompt body, not the structured wire):
 *   - skills.rendered (skill catalog text)
 *   - promptAddendum
 *   - materializedAt timestamp
 */

import type { MaterializedLoadout } from '../openteams/types.js';

/** Wire-shape subset of MaterializedLoadout, used on both dispatch routes. */
export interface WireLoadoutShape {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  mcpProviders?: MaterializedLoadout['mcpProviders'];
  mcpScope?: MaterializedLoadout['mcpScope'];
  capabilities?: string[];
}

/**
 * Convert a MaterializedLoadout into the wire-shape subset shipped on
 * dispatch envelopes (mail) and dispatch/spawn-agent params (ACP).
 *
 * Runtime-agnostic — no macro-agent-specific fields. Each receiving
 * runtime is responsible for translating this into its native spawn
 * config (e.g., macro-agent's `loadoutToSpawnOptions`).
 *
 * Returns a fresh object literal each call (callers may mutate freely).
 */
export function materializedLoadoutToWire(
  loadout: MaterializedLoadout,
): WireLoadoutShape {
  const wire: WireLoadoutShape = {};

  const hasPermissions =
    (loadout.permissions.allow?.length ?? 0) +
      (loadout.permissions.deny?.length ?? 0) +
      (loadout.permissions.ask?.length ?? 0) >
    0;
  if (hasPermissions) {
    wire.permissions = {
      ...(loadout.permissions.allow?.length ? { allow: loadout.permissions.allow } : {}),
      ...(loadout.permissions.deny?.length ? { deny: loadout.permissions.deny } : {}),
      ...(loadout.permissions.ask?.length ? { ask: loadout.permissions.ask } : {}),
    };
  }

  if (loadout.mcpProviders?.length) wire.mcpProviders = loadout.mcpProviders;
  if (loadout.mcpScope?.length) wire.mcpScope = loadout.mcpScope;
  if (loadout.capabilities?.length) wire.capabilities = [...loadout.capabilities];

  return wire;
}
