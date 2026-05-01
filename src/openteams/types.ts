/**
 * Shared types for the OpenHive ↔ openteams resolver layer.
 *
 * Re-exports key openteams types so consumers in src/ can import from one
 * place. Adds OpenHive-specific composite types (MaterializedLoadout) that
 * bundle openteams resolution output with skill-tree compilation + MCP ref
 * resolution.
 */

import type {
  ResolvedTemplate,
  ResolvedRole,
  ResolvedLoadout,
  LoadoutDefinition,
  TeamManifest,
  RoleDefinition,
  SkillsConfig,
  PermissionsConfig,
  NormalizedMcpScope,
  McpServerEntry,
  McpServerRef,
  McpProviderSpec,
} from 'openteams';

// Re-exports — single import point for the rest of src/.
export type {
  ResolvedTemplate,
  ResolvedRole,
  ResolvedLoadout,
  LoadoutDefinition,
  TeamManifest,
  RoleDefinition,
  SkillsConfig,
  PermissionsConfig,
  NormalizedMcpScope,
  McpServerEntry,
  McpServerRef,
  McpProviderSpec,
};

// ============================================================================
// MaterializedLoadout — fully baked artifact for a single role
// ============================================================================

export interface MaterializedSkills {
  /** Rendered system-prompt fragment (from skill-tree's SkillGraphServer). */
  rendered: string;
  /** Estimated tokens of the rendered fragment. */
  estimatedTokens: number;
  /** Skill bank resource id this compilation drew from. Null when no skill
   *  bank was bound (loadout has no skills field, no team-level fallback). */
  skillBankResourceId: string | null;
  /** Skill bank version/commit if known — for drift detection. */
  skillBankVersion?: string;
  /** Structured side-channel: which skills ended up in the loadout. */
  items: Array<{ id: string; name: string; version?: string }>;
}

export interface UnresolvedMcpRef {
  /** The literal ref as it appeared in the loadout (e.g. `@openhive/secrets-scanner`). */
  ref: string;
  /** Why it didn't resolve. */
  reason: 'not-in-registry' | 'no-resolver';
}

/**
 * A materialized MCP provider — install spec the consumer may honor.
 *
 * Carries the server name alongside the install spec because openteams'
 * McpServerEntry already does, and consumers (claude-code-swarm health
 * check, the materializer, the UI) need a stable lookup key.
 *
 * For symbolic refs (`{ ref: '@openhive/secrets-scanner' }`), the ref
 * string is used as the name; the consumer can rename when emitting
 * `.mcp.json`.
 */
export interface MaterializedMcpProvider extends McpProviderSpec {
  name: string;
}

export interface MaterializedLoadout {
  /** Capabilities granted to the role. */
  capabilities: string[];
  /** Per-server scope rules (allowlist / denylist). */
  mcpScope: NormalizedMcpScope[];
  /** Install specs the consumer may want to honor (advisory). */
  mcpProviders: MaterializedMcpProvider[];
  /** Permission lists (allow / deny / ask). */
  permissions: { allow: string[]; deny: string[]; ask: string[] };
  /** Markdown appended after the role's primary prompt. Empty string when
   *  the loadout has no addendum. */
  promptAddendum: string;
  /** Skill compilation result, or null when no skill bank is bound. */
  skills: MaterializedSkills | null;
  /** MCP refs that the hub couldn't resolve. Empty array means everything
   *  resolved cleanly; consumer treats unresolved entries as warnings. */
  unresolvedRefs: UnresolvedMcpRef[];
  /** ISO timestamp — when this materialization was produced. */
  materializedAt: string;
}

/** Empty materialization for roles that have no loadout binding. */
export function emptyMaterialization(): MaterializedLoadout {
  return {
    capabilities: [],
    mcpScope: [],
    mcpProviders: [],
    permissions: { allow: [], deny: [], ask: [] },
    promptAddendum: '',
    skills: null,
    unresolvedRefs: [],
    materializedAt: new Date().toISOString(),
  };
}
