/**
 * Zod schemas for openteams team_template resources.
 *
 * Mirrors references/openteams/schema/team.schema.json — structural validation
 * only. Topology cycle detection, role-name reference checks, and similar
 * semantic validation happen at resolution time via openteams' TemplateLoader.
 *
 * Use .passthrough() throughout so openteams extension namespaces survive
 * round-trips.
 */

import { z } from 'zod';
import { LoadoutContentSchema } from './loadouts.js';

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const TeamManifestSchema = z
  .object({
    name: z.string().regex(NAME_PATTERN),
    version: z.literal(1),
    roles: z.array(z.string().regex(NAME_PATTERN)).min(1),
    topology: z.unknown(), // shape validated by openteams loader on resolve
    communication: z.unknown().optional(),
    mcp_providers: z.record(z.unknown()).optional(),
  })
  .passthrough();

// Role definitions are loosely typed because they may carry inline loadouts,
// inheritance via `extends:`, prompts, and arbitrary extension namespaces.
// openteams owns the deep validation; we just preserve the shape.
const RoleDefinitionSchema = z.record(z.unknown());

export const TeamTemplateContentSchema = z
  .object({
    manifest: TeamManifestSchema,
    roles: z.record(RoleDefinitionSchema).default({}),
    loadouts: z.record(LoadoutContentSchema).default({}),
    prompts: z.record(z.string()).default({}),
  })
  .passthrough();

export type TeamTemplateContent = z.infer<typeof TeamTemplateContentSchema>;

// ============================================================================
// REST request bodies
// ============================================================================

export const CreateTeamTemplateSchema = z.object({
  name: z.string().regex(NAME_PATTERN),
  description: z.string().optional(),
  content: TeamTemplateContentSchema,
  visibility: z.enum(['private', 'shared', 'public']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateTeamTemplateInput = z.infer<typeof CreateTeamTemplateSchema>;

export const UpdateTeamTemplateSchema = z
  .object({
    name: z.string().regex(NAME_PATTERN).optional(),
    description: z.string().optional(),
    content: TeamTemplateContentSchema.optional(),
    visibility: z.enum(['private', 'shared', 'public']).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateTeamTemplateInput = z.infer<typeof UpdateTeamTemplateSchema>;
