/**
 * Zod schemas for repo REST routes (slice 4).
 *
 * Repos are syncable resources with a federation tier separate from the
 * column-level visibility — see docs/design/repos-as-syncable-resources.md.
 */

import { z } from 'zod';

const RepoVisibilitySchema = z.enum(['private', 'hub_local', 'federated']);
const RepoStatusSchema = z.enum(['active', 'redacted_remote', 'archived', 'merged_into']);
const RepoOriginSchema = z.enum(['user_defined', 'agent_declared', 'trajectory_inferred']);

export const ListReposQuerySchema = z.object({
  origin: RepoOriginSchema.optional(),
  visibility: RepoVisibilitySchema.optional(),
  status: RepoStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const CreateRepoSchema = z.object({
  /** Raw remote URL — will be canonicalized via the package's canonicalizeRepoUrl. */
  remote_url: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  default_branch: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  visibility: RepoVisibilitySchema.default('hub_local'),
  binding_policy: z.enum(['open', 'closed']).optional(),
});

export const UpdateRepoSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  default_branch: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  visibility: RepoVisibilitySchema.optional(),
  binding_policy: z.enum(['open', 'closed']).optional(),
}).refine((v) => Object.keys(v).length > 0, {
  message: 'At least one field must be provided',
});

export const MergeRepoSchema = z.object({
  /** Target repo id — the source repo will be marked merged_into target. */
  into: z.string().min(1),
});

export type CreateRepoInput = z.infer<typeof CreateRepoSchema>;
export type UpdateRepoInput = z.infer<typeof UpdateRepoSchema>;
