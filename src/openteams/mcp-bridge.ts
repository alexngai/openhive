/**
 * MCP ref/install resolution for openteams loadouts.
 *
 * Walks a ResolvedLoadout's mcpServers list and produces the consumer-facing
 * shape: { scope, providers, unresolvedRefs }.
 *
 * Three knowledge sources, consulted in order; missing layers degrade rather
 * than fail (see docs/LOADOUTS_DESIGN.md → MCP defaults):
 *
 *   1. Authored — what the loadout literally says (scope-only string,
 *      single-key scope object, inline install spec, or symbolic ref).
 *   2. Registry — bundled JSON map of `@openhive/<name>` → McpProviderSpec.
 *      Promote to a `mcp_provider` resource type later if external authoring
 *      becomes a need.
 *   3. Active set — runtime-side detection (claude-code-swarm reads
 *      plugin.json / .mcp.json / ~/.claude/mcp.json). Not the hub's job.
 *
 * Unresolved refs are surfaced, never thrown — the consumer reports them
 * as SessionStart warnings rather than blocking boot.
 */

import type {
  McpServerEntry,
  McpServerRef,
  McpProviderSpec,
  NormalizedMcpScope,
} from 'openteams';
import type { MaterializedMcpProvider, UnresolvedMcpRef } from './types.js';
import builtinRegistry from './refs/builtin.json' with { type: 'json' };

export interface ResolveMcpRefsResult {
  /** Already-normalized scope entries from openteams (passed through). */
  scope: NormalizedMcpScope[];
  /** Concrete install specs the consumer may honor. */
  providers: MaterializedMcpProvider[];
  /** Refs the hub couldn't resolve. */
  unresolvedRefs: UnresolvedMcpRef[];
}

interface BuiltinRegistry {
  [refKey: string]: McpProviderSpec | undefined;
}

const REGISTRY = builtinRegistry as unknown as BuiltinRegistry;

/**
 * Resolve a ResolvedLoadout's install/ref mcpServers + scope into the
 * consumer-facing shape.
 *
 *   scopeEntries — already-normalized scope rules from
 *                  ResolvedLoadout.mcpScope.
 *   serverEntries — install-bearing entries from
 *                   ResolvedLoadout.mcpServers (inline install specs and
 *                   symbolic refs only; pure-scope entries already live in
 *                   scopeEntries).
 */
export function resolveMcpRefs(
  scopeEntries: NormalizedMcpScope[],
  serverEntries: (McpServerEntry | McpServerRef)[],
): ResolveMcpRefsResult {
  const providers: MaterializedMcpProvider[] = [];
  const unresolvedRefs: UnresolvedMcpRef[] = [];

  for (const entry of serverEntries) {
    if ('ref' in entry) {
      const resolved = REGISTRY[entry.ref];
      if (resolved) {
        // Merge any caller-supplied config over the registry's defaults.
        providers.push({
          name: entry.ref,
          ...resolved,
          ...(entry.config && typeof entry.config === 'object' ? entry.config : {}),
        });
      } else {
        unresolvedRefs.push({ ref: entry.ref, reason: 'not-in-registry' });
      }
      continue;
    }

    // Inline install spec (McpServerEntry has its own `name`).
    providers.push({ ...(entry as McpServerEntry) });
  }

  return {
    scope: [...scopeEntries],
    providers,
    unresolvedRefs,
  };
}
