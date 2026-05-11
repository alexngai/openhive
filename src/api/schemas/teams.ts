/**
 * Team Template API Schemas
 *
 * Authored openteams team templates stored as `syncable_resources` rows of
 * type `team_template`. The whole template (manifest + roles + loadouts +
 * prompts) lives in `metadata.content` and is consumed by openteams'
 * TemplateLoader at resolve/bundle time.
 *
 * Validation is intentionally permissive: openteams' own schema is the
 * source of truth at hydrate time, and templates may carry extension
 * namespaces (`macro_agent`, `claude_code`, etc.) that openhive should
 * store verbatim. We enforce a small set of structural invariants here
 * (name, version, roles list) so that obviously-broken templates can't be
 * stored, but leave the deep validation to the openteams loader.
 */

import { z } from 'zod';

// ── manifest ──────────────────────────────────────────────────────────────

/**
 * `team.yaml` manifest. Mirror of openteams `schema/team.schema.json` —
 * required fields are strict, everything else passes through.
 */
const TeamManifestSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'invalid team name'),
    description: z.string().optional(),
    version: z.literal(1),
    roles: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)).min(1),
    topology: z.unknown(),
    communication: z.unknown().optional(),
    mcp_providers: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// ── role / loadout / prompt sidecars ──────────────────────────────────────

/**
 * Role definition keyed by role name (`roles/<name>.yaml` content). Stored
 * verbatim; the openteams loader resolves `extends` chains and capability
 * composition at hydrate time.
 */
const RoleDefinitionSchema = z
  .object({
    name: z.string(),
    extends: z.string().optional(),
    capabilities: z.unknown().optional(),
    capabilities_add: z.array(z.string()).optional(),
    capabilities_remove: z.array(z.string()).optional(),
    loadout: z.unknown().optional(),
  })
  .passthrough();

/**
 * Loadout definition embedded inside a team (under `loadouts/<name>.yaml`).
 * Standalone loadouts have their own resource type (`loadout`); this is the
 * team-embedded form.
 */
const EmbeddedLoadoutSchema = z
  .object({
    name: z.string(),
    extends: z.string().optional(),
  })
  .passthrough();

/**
 * Prompt files for a role. openteams accepts either a single `prompts/<role>.md`
 * file or a multi-file `prompts/<role>/` directory (SOUL.md, ROLE.md, RULES.md,
 * etc.). We collapse both shapes to a typed record indexed by filename.
 */
const RolePromptsSchema = z
  .object({
    primary: z.string().optional(),
    additional: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

// ── authored content ──────────────────────────────────────────────────────

/**
 * The shape stored in `syncable_resources.metadata.content` for a team
 * template. Manifest + sidecar files collapsed into one object so the whole
 * template round-trips through a single JSON column.
 */
export const TeamTemplateContentSchema = z
  .object({
    manifest: TeamManifestSchema,
    roles: z.record(z.string(), RoleDefinitionSchema).optional(),
    loadouts: z.record(z.string(), EmbeddedLoadoutSchema).optional(),
    prompts: z.record(z.string(), RolePromptsSchema).optional(),
  })
  .passthrough();

export type TeamTemplateContent = z.infer<typeof TeamTemplateContentSchema>;

// ── request bodies ────────────────────────────────────────────────────────

const VisibilitySchema = z.enum(['private', 'shared', 'public']);

export const CreateTeamTemplateSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  description: z.string().optional(),
  content: TeamTemplateContentSchema,
  visibility: VisibilitySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateTeamTemplateSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
  description: z.string().optional(),
  content: TeamTemplateContentSchema.optional(),
  visibility: VisibilitySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type CreateTeamTemplateInput = z.infer<typeof CreateTeamTemplateSchema>;
export type UpdateTeamTemplateInput = z.infer<typeof UpdateTeamTemplateSchema>;
