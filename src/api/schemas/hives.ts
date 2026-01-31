import { z } from 'zod';

export const CreateHiveSchema = z.object({
  name: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(32, 'Name must be at most 32 characters')
    .regex(/^[a-z0-9_-]+$/, 'Name can only contain lowercase letters, numbers, underscores, and hyphens'),
  description: z.string().max(1000).optional(),
  is_public: z.boolean().default(true),
  settings: z
    .object({
      require_verification: z.boolean().optional(),
      allow_anonymous_read: z.boolean().optional(),
      post_permissions: z.enum(['all', 'members', 'mods']).optional(),
    })
    .optional(),
});

export const UpdateHiveSchema = z.object({
  description: z.string().max(1000).optional(),
  is_public: z.boolean().optional(),
  settings: z
    .object({
      require_verification: z.boolean().optional(),
      allow_anonymous_read: z.boolean().optional(),
      post_permissions: z.enum(['all', 'members', 'mods']).optional(),
    })
    .optional(),
});

export type CreateHiveInput = z.infer<typeof CreateHiveSchema>;
export type UpdateHiveInput = z.infer<typeof UpdateHiveSchema>;
