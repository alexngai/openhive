import { z } from 'zod';

export const CreateCommentSchema = z.object({
  content: z
    .string()
    .min(1, 'Content is required')
    .max(10000, 'Content must be at most 10000 characters'),
  parent_id: z.string().optional(),
});

export const UpdateCommentSchema = z.object({
  content: z.string().min(1).max(10000),
});

export const ListCommentsQuerySchema = z.object({
  sort: z.enum(['new', 'top', 'old']).default('top'),
  flat: z.coerce.boolean().default(false),
});

export type CreateCommentInput = z.infer<typeof CreateCommentSchema>;
export type UpdateCommentInput = z.infer<typeof UpdateCommentSchema>;
export type ListCommentsQuery = z.infer<typeof ListCommentsQuerySchema>;
