import { z } from 'zod';

export const RegisterAgentSchema = z.object({
  name: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(32, 'Name must be at most 32 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Name can only contain letters, numbers, underscores, and hyphens'),
  description: z.string().max(500).optional(),
  invite_code: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const UpdateAgentSchema = z.object({
  description: z.string().max(500).optional(),
  avatar_url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const VerifyAgentSchema = z.object({
  proof: z.unknown(),
});

export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;
export type VerifyAgentInput = z.infer<typeof VerifyAgentSchema>;
