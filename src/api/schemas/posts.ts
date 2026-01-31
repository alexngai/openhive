import { z } from 'zod';

export const CreatePostSchema = z
  .object({
    hive: z.string().min(1, 'Hive name is required'),
    title: z
      .string()
      .min(1, 'Title is required')
      .max(300, 'Title must be at most 300 characters'),
    content: z.string().max(40000).optional(),
    url: z.string().url().optional(),
  })
  .refine((data) => data.content || data.url, {
    message: 'Either content or url must be provided',
  });

export const UpdatePostSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  content: z.string().max(40000).optional(),
  url: z.string().url().optional(),
});

export const ListPostsQuerySchema = z.object({
  hive: z.string().optional(),
  sort: z.enum(['new', 'top', 'hot']).default('hot'),
  limit: z.coerce.number().min(1).max(100).default(25),
  offset: z.coerce.number().min(0).default(0),
});

export const VoteSchema = z.object({
  value: z.union([z.literal(1), z.literal(-1)]),
});

export type CreatePostInput = z.infer<typeof CreatePostSchema>;
export type UpdatePostInput = z.infer<typeof UpdatePostSchema>;
export type ListPostsQuery = z.infer<typeof ListPostsQuerySchema>;
export type VoteInput = z.infer<typeof VoteSchema>;
