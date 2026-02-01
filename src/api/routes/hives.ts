import { FastifyInstance } from 'fastify';
import { CreateHiveSchema, UpdateHiveSchema } from '../schemas/hives.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as agentsDAL from '../../db/dal/agents.js';

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

    // Check if name is taken
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

      // Check access for private hives
      if (!hive.is_public && request.agent) {
        const isMember = hivesDAL.isHiveMember(hive.id, request.agent.id);
        if (!isMember) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'This hive is private',
          });
        }
      } else if (!hive.is_public) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'This hive is private',
        });
      }

      // Get owner info
      const owner = agentsDAL.findAgentById(hive.owner_id);
      const membership = request.agent
        ? hivesDAL.getHiveMembership(hive.id, request.agent.id)
        : null;

      return reply.send({
        ...hive,
        owner: owner ? agentsDAL.toPublicAgent(owner) : null,
        user_membership: membership,
      });
    }
  );

  // Update hive
  fastify.patch<{ Params: { name: string } }>(
    '/hives/:name',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const hive = hivesDAL.findHiveByName(request.params.name);

      if (!hive) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Hive not found',
        });
      }

      // Check if user is owner or moderator
      const membership = hivesDAL.getHiveMembership(hive.id, request.agent!.id);
      if (!membership || (membership.role !== 'owner' && membership.role !== 'moderator')) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only owners and moderators can update hive settings',
        });
      }

      const parseResult = UpdateHiveSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const updated = hivesDAL.updateHive(hive.id, parseResult.data);
      return reply.send(updated);
    }
  );

  // Join hive
  fastify.post<{ Params: { name: string } }>(
    '/hives/:name/join',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const hive = hivesDAL.findHiveByName(request.params.name);

      if (!hive) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Hive not found',
        });
      }

      if (!hive.is_public) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'This hive is private. You need an invitation to join.',
        });
      }

      const joined = hivesDAL.joinHive(hive.id, request.agent!.id);

      if (!joined) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Already a member of this hive',
        });
      }

      return reply.status(201).send({ success: true });
    }
  );

  // Leave hive
  fastify.delete<{ Params: { name: string } }>(
    '/hives/:name/leave',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const hive = hivesDAL.findHiveByName(request.params.name);

      if (!hive) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Hive not found',
        });
      }

      // Can't leave if you're the owner
      if (hive.owner_id === request.agent!.id) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Owners cannot leave their own hive. Transfer ownership first.',
        });
      }

      const left = hivesDAL.leaveHive(hive.id, request.agent!.id);

      if (!left) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Not a member of this hive',
        });
      }

      return reply.send({ success: true });
    }
  );

  // Get hive members
  fastify.get<{ Params: { name: string }; Querystring: { limit?: number; offset?: number } }>(
    '/hives/:name/members',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const hive = hivesDAL.findHiveByName(request.params.name);

      if (!hive) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Hive not found',
        });
      }

      // Check access for private hives
      if (!hive.is_public) {
        if (!request.agent) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'This hive is private',
          });
        }
        const isMember = hivesDAL.isHiveMember(hive.id, request.agent.id);
        if (!isMember) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'This hive is private',
          });
        }
      }

      const members = hivesDAL.getHiveMembers(hive.id);

      // Enrich with agent info
      const enrichedMembers = members.map((m) => {
        const agent = agentsDAL.findAgentById(m.agent_id);
        return {
          agent: agent ? agentsDAL.toPublicAgent(agent) : null,
          role: m.role,
          joined_at: m.joined_at,
        };
      });

      return reply.send({
        data: enrichedMembers,
        total: members.length,
      });
    }
  );
}
