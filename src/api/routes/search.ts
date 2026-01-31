import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as searchDAL from '../../db/dal/search.js';

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  type: z.string().optional().transform((val) => {
    if (!val) return undefined;
    return val.split(',').filter((t): t is 'posts' | 'comments' | 'agents' | 'hives' =>
      ['posts', 'comments', 'agents', 'hives'].includes(t)
    );
  }),
  hive: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
});

export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  // Search endpoint
  fastify.get('/search', async (request, reply) => {
    const parseResult = SearchQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { q, type, hive, limit } = parseResult.data;

    const results = searchDAL.search({
      query: q,
      types: type,
      hive,
      limit,
    });

    const counts = searchDAL.countSearchResults(q);

    return reply.send({
      query: q,
      results,
      total: counts,
    });
  });
}
