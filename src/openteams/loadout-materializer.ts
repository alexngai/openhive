/**
 * Loadout Materializer — Layer 3.
 *
 * Given a `sha256:<hex>` loadout bundle id captured on a dispatch row, the
 * materializer:
 *
 *   1. Fetches the bundle from the openteams `InMemoryBundleStore` (lazy
 *      singleton in `map-handlers.ts`).
 *   2. Hydrates it via `openteams.hydrateLoadout`, verifying the hash en
 *      route (mismatch throws).
 *   3. Translates the `ResolvedLoadout` into a runtime-agnostic
 *      `MaterializedLoadout` for the dispatch runtime to consume.
 *
 * `MaterializedLoadout` is the *contract* between Layer 3 and the dispatch
 * runtime (`src/dispatch/openhive-runtime.ts`). Today the runtime cares
 * about two pieces — `mcpServers` for the ACP session and `promptAddendum`
 * for the system prompt — but the materializer also surfaces `permissions`
 * and `capabilities` so future runtime-side enforcement has a place to
 * land without churning the call sites.
 *
 * Cross-instance bundle fetch (when the loadout was authored on a peer
 * hub and only the row was mesh-replicated) is handled transparently
 * by the `CrossInstanceFallbackStore` wrapper in `map-handlers.ts`:
 * on a local-store miss it scans replicated rows from trusted peers,
 * rebundles + hash-verifies, and caches the result. Callers here
 * don't need to know.
 */

import { hydrateLoadout, LOADOUT_RESOURCE_TYPE } from 'openteams';
import type { LoadoutResource } from 'openteams';
import { getOpenteamsBundleStore } from './map-handlers.js';
import { resolveMcpRef } from './mcp-registry.js';

/**
 * Minimal ACP-compatible MCP server entry. Mirrors the Claude Code
 * `mcpServers` shape (the de-facto MCP ecosystem standard), keyed by
 * `name` so the runtime can disambiguate.
 *
 * The dispatch runtime forwards this list verbatim into the ACP
 * `newSession` `mcpServers` argument; the agent client decides whether
 * to actually install / connect.
 */
export interface AcpMcpServerEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  type?: 'stdio' | 'sse' | 'http';
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Permission rule lists. Inherits the agent-system-agnostic shape from
 * openteams. The dispatch runtime doesn't enforce these yet; future
 * runtime-side gating reads from this surface.
 */
export interface MaterializedPermissions {
  allow: string[];
  deny: string[];
  ask: string[];
}

export interface MaterializedLoadout {
  /** The bundle id this came from. Useful for logging / debugging. */
  bundleId: string;
  /** Loadout name as authored. */
  name: string;
  /**
   * Install-bearing MCP server entries translated to the ACP shape.
   * Symbolic refs (`{ ref: '@org/x' }`) are dropped here because the
   * runtime has no way to resolve them yet; they appear in
   * `unresolvedRefs` so the caller can log a structured warning.
   */
  mcpServers: AcpMcpServerEntry[];
  /** Symbolic refs that were skipped (need consumer-side registry). */
  unresolvedRefs: string[];
  /** Optional system-prompt addendum appended ahead of the spec body. */
  promptAddendum: string;
  /** Capabilities granted (informational; not enforced today). */
  capabilities: string[];
  /** Permission rules (informational; not enforced today). */
  permissions: MaterializedPermissions;
}

export class LoadoutBundleNotFoundError extends Error {
  constructor(public readonly bundleId: string) {
    super(`Loadout bundle not found in store: ${bundleId}`);
    this.name = 'LoadoutBundleNotFoundError';
  }
}

/**
 * Resolve a loadout bundle id to a runtime-ready artifact.
 *
 * Throws `LoadoutBundleNotFoundError` when the bundle isn't present.
 * `hydrateLoadout` throws on hash mismatch.
 */
export async function materializeLoadoutById(
  bundleId: string,
): Promise<MaterializedLoadout> {
  const store = getOpenteamsBundleStore();
  const resource = (await store.get(LOADOUT_RESOURCE_TYPE, bundleId)) as
    | LoadoutResource
    | null;
  if (!resource) {
    throw new LoadoutBundleNotFoundError(bundleId);
  }

  const resolved = hydrateLoadout(resource);
  return resolvedToMaterialized(bundleId, resolved);
}

/**
 * Exported separately to support tests + future call sites that already
 * hold a hydrated `ResolvedLoadout` and want the translation step only.
 */
export function resolvedToMaterialized(
  bundleId: string,
  resolved: ReturnType<typeof hydrateLoadout>,
): MaterializedLoadout {
  const mcpServers: AcpMcpServerEntry[] = [];
  const unresolvedRefs: string[] = [];

  for (const entry of resolved.mcpServers) {
    if ('ref' in entry && typeof entry.ref === 'string') {
      // Symbolic ref — consult the openhive MCP registry. Resolved entries
      // land in mcpServers; unresolved refs surface to the caller so they
      // can be logged or surfaced in admin UIs.
      const resolvedRef = resolveMcpRef(entry.ref);
      if (resolvedRef) {
        mcpServers.push(resolvedRef);
      } else {
        unresolvedRefs.push(entry.ref);
      }
      continue;
    }
    if ('name' in entry && typeof entry.name === 'string') {
      const translated: AcpMcpServerEntry = { name: entry.name };
      if ('command' in entry && typeof entry.command === 'string') {
        translated.command = entry.command;
      }
      if ('args' in entry && Array.isArray(entry.args)) {
        translated.args = entry.args as string[];
      }
      if ('env' in entry && entry.env && typeof entry.env === 'object') {
        translated.env = entry.env as Record<string, string>;
      }
      if ('cwd' in entry && typeof entry.cwd === 'string') {
        translated.cwd = entry.cwd;
      }
      if ('type' in entry && typeof entry.type === 'string') {
        translated.type = entry.type as AcpMcpServerEntry['type'];
      }
      if ('url' in entry && typeof entry.url === 'string') {
        translated.url = entry.url;
      }
      if ('headers' in entry && entry.headers && typeof entry.headers === 'object') {
        translated.headers = entry.headers as Record<string, string>;
      }
      mcpServers.push(translated);
    }
  }

  return {
    bundleId,
    name: resolved.name,
    mcpServers,
    unresolvedRefs,
    promptAddendum: resolved.promptAddendum ?? '',
    capabilities: resolved.capabilities,
    permissions: {
      allow: resolved.permissions.allow ?? [],
      deny: resolved.permissions.deny ?? [],
      ask: resolved.permissions.ask ?? [],
    },
  };
}
