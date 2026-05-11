/**
 * Loadout API Schemas
 *
 * Authored standalone openteams loadouts stored as `syncable_resources` rows
 * of type `loadout`. The authored content lives in `metadata.content` and
 * matches the shape openteams' loader consumes from `loadouts/<name>.yaml`.
 *
 * Validation mirrors `team.ts` in spirit: enforce the small set of structural
 * invariants (name, optional extends), let the openteams loader's schema be
 * authoritative on the deeper shape. Loadouts carry extension namespaces
 * (`macro_agent`, `claude_code`, etc.) that openhive must store verbatim.
 */

import { z } from 'zod';

const SkillsConfigSchema = z
  .object({
    profile: z.string().optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    max_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/**
 * `permissions:` block — three optional lists. Inherits the
 * agent-system-agnostic shape from openteams (allow/deny/ask), with
 * deny-wins precedence applied at hydrate time.
 */
const PermissionsConfigSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * `mcp_servers:` entries — four accepted shapes. Validation is loose
 * because openteams' loader normalizes the four shapes into a single
 * canonical form at hydrate time.
 */
const McpServerEntrySchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
]);

/**
 * The shape stored in `syncable_resources.metadata.content` for a loadout.
 */
export const LoadoutContentSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    extends: z.string().optional(),
    description: z.string().optional(),
    skills: SkillsConfigSchema.optional(),
    capabilities: z.unknown().optional(),
    capabilities_add: z.array(z.string()).optional(),
    capabilities_remove: z.array(z.string()).optional(),
    mcp_servers: z.array(McpServerEntrySchema).optional(),
    permissions: PermissionsConfigSchema.optional(),
    prompt_addendum: z.string().optional(),
  })
  .passthrough();

export type LoadoutContent = z.infer<typeof LoadoutContentSchema>;

// ── request bodies ────────────────────────────────────────────────────────

const VisibilitySchema = z.enum(['private', 'shared', 'public']);

export const CreateLoadoutSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  description: z.string().optional(),
  content: LoadoutContentSchema,
  visibility: VisibilitySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateLoadoutSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
  description: z.string().optional(),
  content: LoadoutContentSchema.optional(),
  visibility: VisibilitySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type CreateLoadoutInput = z.infer<typeof CreateLoadoutSchema>;
export type UpdateLoadoutInput = z.infer<typeof UpdateLoadoutSchema>;
