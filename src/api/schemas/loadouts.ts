/**
 * Zod schemas for openteams loadout resources.
 *
 * Mirrors references/openteams/schema/loadout.schema.json — structural validation
 * only. Deep semantic validation (extends-chain integrity, mcp ref resolution,
 * skill bank wiring) happens at resolution time via openteams' TemplateLoader.
 *
 * Use .passthrough() so openteams extension namespaces (e.g. `openhive:`,
 * `claude_code:`) survive the round-trip through OpenHive.
 */

import { z } from 'zod';

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)*$/;

const SkillsConfigSchema = z
  .object({
    profile: z.string().optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

const PermissionsConfigSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
  })
  .passthrough();

const McpServerEntrySchema = z.union([
  z.string().regex(NAME_PATTERN),
  z.object({ ref: z.string() }).passthrough(),
  z.object({ name: z.string(), command: z.string() }).passthrough(),
  z.record(z.unknown()), // single-key scope object — too permissive to enumerate
]);

export const LoadoutContentSchema = z
  .object({
    name: z.string().regex(NAME_PATTERN),
    extends: z.string().optional(),
    description: z.string().optional(),
    skills: SkillsConfigSchema.optional(),
    capabilities: z.unknown().optional(), // array | composition | map; pass through
    capabilities_add: z.array(z.string().regex(CAPABILITY_PATTERN)).optional(),
    capabilities_remove: z.array(z.string().regex(CAPABILITY_PATTERN)).optional(),
    mcp_servers: z.array(McpServerEntrySchema).optional(),
    permissions: PermissionsConfigSchema.optional(),
    prompt_addendum: z.string().optional(),
  })
  .passthrough();

export type LoadoutContent = z.infer<typeof LoadoutContentSchema>;

// ============================================================================
// REST request bodies
// ============================================================================

export const CreateLoadoutSchema = z.object({
  name: z.string().regex(NAME_PATTERN),
  description: z.string().optional(),
  content: LoadoutContentSchema,
  visibility: z.enum(['private', 'shared', 'public']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateLoadoutInput = z.infer<typeof CreateLoadoutSchema>;

export const UpdateLoadoutSchema = z
  .object({
    name: z.string().regex(NAME_PATTERN).optional(),
    description: z.string().optional(),
    content: LoadoutContentSchema.optional(),
    visibility: z.enum(['private', 'shared', 'public']).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateLoadoutInput = z.infer<typeof UpdateLoadoutSchema>;
