/**
 * Symbolic MCP server reference registry (v1, inline).
 *
 * openteams loadouts can declare `mcp_servers: [{ ref: '@org/name' }]` —
 * symbolic references resolved by the *consumer*'s registry. Each
 * consumer (openhive, claude-code-swarm, etc.) ships its own table so
 * the same loadout YAML can bind to runtime-specific install specs.
 *
 * This module is openhive's registry. v1 is a hand-curated inline map.
 * v2 (deferred) promotes it to a DB-backed table federated via the sync
 * mesh, so peer hubs can publish their own MCP install specs.
 *
 * Consumed by `src/openteams/loadout-materializer.ts` — refs that
 * resolve here land in `MaterializedLoadout.mcpServers`; refs that
 * don't resolve stay in `unresolvedRefs` so the runtime can log them.
 */

import type { AcpMcpServerEntry } from './loadout-materializer.js';

/**
 * Default registry shipped with openhive. Keep entries minimal and only
 * include refs we own (`@openhive/...`) or that we vendor as core MCP
 * servers. Loadout authors writing refs outside this set get a warning
 * surface (`unresolvedRefs`); they can either inline the install spec
 * or contribute the ref upstream.
 */
const DEFAULT_REGISTRY: Record<string, AcpMcpServerEntry> = {
  // Placeholder entry — replace with real install specs as openhive
  // ships its own MCP servers. Keeping at least one entry here lets the
  // tests verify the resolution path end-to-end.
  '@openhive/example-mcp': {
    name: 'example-mcp',
    command: 'npx',
    args: ['--yes', '@openhive/example-mcp'],
  },
};

let activeRegistry: Record<string, AcpMcpServerEntry> = { ...DEFAULT_REGISTRY };

/**
 * Resolve a symbolic ref to an ACP-shaped install spec, or null when the
 * registry has no entry for it.
 */
export function resolveMcpRef(ref: string): AcpMcpServerEntry | null {
  const entry = activeRegistry[ref];
  if (!entry) return null;
  // Defensive copy so consumers can't mutate the registry state.
  return { ...entry };
}

/**
 * Add or replace a registry entry. Production callers should rarely need
 * this — wire DB-backed entries into a single startup pass instead. Test
 * harnesses use it to set up deterministic fixtures.
 */
export function registerMcpRef(ref: string, entry: AcpMcpServerEntry): void {
  activeRegistry[ref] = entry;
}

/** Snapshot the registry (for /admin/openteams/mcp-registry surfaces). */
export function listMcpRefs(): ReadonlyArray<{ ref: string; entry: AcpMcpServerEntry }> {
  return Object.entries(activeRegistry).map(([ref, entry]) => ({ ref, entry: { ...entry } }));
}

/** Test-only: reset to the default registry. */
export function _resetMcpRegistry(): void {
  activeRegistry = { ...DEFAULT_REGISTRY };
}
