/**
 * Hives — namespace / tenancy primitive.
 *
 * The legacy social-community surface (posts, comments, votes, memberships,
 * joining/leaving, member lists) was removed. What remains is the minimal
 * list + create + lookup surface needed by:
 *   - MAP swarm registration (swarms auto-join a hive via pre-auth key)
 *   - Event subscription forms (swarms in a hive receive routed events)
 *   - Swarmhub connector (provisions hives when federating)
 *
 * All remaining endpoints are namespace-shaped — the `is_public` /
 * `member_count` columns on the table are unused for MAP paths and will
 * be dropped in a later schema migration.
 */

import { FastifyInstance } from 'fastify';
import { CreateHiveSchema } from '../schemas/hives.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as hivesDAL from '../../db/dal/hives.js';

export async function hivesRoutes(fastify: FastifyInstance): Promise<void> {
  // List hives
  fastify.get<{ Querystring: { limit?: number; offset?: number } }>(
    '/hives',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;

      const hives = hivesDAL.listHives({
        limit,
        offset,
        agent_id: request.agent?.id,
        public_only: true,
      });

      const total = hivesDAL.countHives();

      return reply.send({
        data: hives,
        total,
        limit,
        offset,
      });
    }
  );

  // Create a new hive
  fastify.post('/hives', { preHandler: authMiddleware }, async (request, reply) => {
    const parseResult = CreateHiveSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { name, description, is_public, settings } = parseResult.data;

    const existing = hivesDAL.findHiveByName(name);
    if (existing) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'A hive with this name already exists',
      });
    }

    const hive = hivesDAL.createHive({
      name,
      description,
      owner_id: request.agent!.id,
      is_public,
      settings,
    });

    return reply.status(201).send(hive);
  });

  // Get hive by name
  fastify.get<{ Params: { name: string } }>(
    '/hives/:name',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const hive = hivesDAL.findHiveByName(request.params.name);

      if (!hive) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Hive not found',
        });
      }

      return reply.send(hive);
    }
  );
}
