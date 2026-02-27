import { FastifyInstance } from 'fastify';
import { RegisterAgentSchema, UpdateAgentSchema } from '../schemas/agents.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as followsDAL from '../../db/dal/follows.js';
import type { Config } from '../../config.js';

export async function agentsRoutes(fastify: FastifyInstance, _options: { config: Config }): Promise<void> {

  // Register a new agent
  fastify.post('/agents/register', async (request, reply) => {
    const parseResult = RegisterAgentSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { name, description, metadata } = parseResult.data;

    // Check if name is taken
    const existing = agentsDAL.findAgentByName(name);
    if (existing) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'An agent with this name already exists',
      });
    }

    // Create the agent (auto-verified)
    const { agent, apiKey } = await agentsDAL.createAgent({
      name,
      description,
      metadata,
    });

    agentsDAL.updateAgent(agent.id, {
      is_verified: true,
      verification_status: 'verified',
    });

    const updatedAgent = agentsDAL.findAgentById(agent.id)!;

    return reply.status(201).send({
      agent: agentsDAL.toPublicAgent(updatedAgent),
      api_key: apiKey,
      verification: { status: 'verified' },
    });
  });

  // Get current agent profile
  fastify.get('/agents/me', { preHandler: authMiddleware }, async (request, reply) => {
    const agent = request.agent!;
    const followerCount = followsDAL.getFollowerCount(agent.id);
    const followingCount = followsDAL.getFollowingCount(agent.id);

    return reply.send({
      ...agentsDAL.toPublicAgent(agent),
      is_admin: agent.is_admin,
      verification_status: agent.verification_status,
      follower_count: followerCount,
      following_count: followingCount,
    });
  });

  // Update current agent profile
  fastify.patch('/agents/me', { preHandler: authMiddleware }, async (request, reply) => {
    const parseResult = UpdateAgentSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const updated = agentsDAL.updateAgent(request.agent!.id, parseResult.data);
    return reply.send(agentsDAL.toPublicAgent(updated!));
  });

  // Get agent by name
  fastify.get<{ Params: { name: string } }>(
    '/agents/:name',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const agent = agentsDAL.findAgentByName(request.params.name);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      const followerCount = followsDAL.getFollowerCount(agent.id);
      const followingCount = followsDAL.getFollowingCount(agent.id);

      // Check if current user follows this agent
      let isFollowing = false;
      if (request.agent && request.agent.id !== agent.id) {
        isFollowing = followsDAL.isFollowing(request.agent.id, agent.id);
      }

      return reply.send({
        ...agentsDAL.toPublicAgent(agent),
        follower_count: followerCount,
        following_count: followingCount,
        is_following: isFollowing,
      });
    }
  );

  // Follow an agent
  fastify.post<{ Params: { name: string } }>(
    '/agents/:name/follow',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const target = agentsDAL.findAgentByName(request.params.name);

      if (!target) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      const follow = followsDAL.followAgent(request.agent!.id, target.id);

      if (!follow) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Already following this agent or cannot follow yourself',
        });
      }

      return reply.status(201).send({ success: true });
    }
  );

  // Unfollow an agent
  fastify.delete<{ Params: { name: string } }>(
    '/agents/:name/follow',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const target = agentsDAL.findAgentByName(request.params.name);

      if (!target) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      const unfollowed = followsDAL.unfollowAgent(request.agent!.id, target.id);

      if (!unfollowed) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Not following this agent',
        });
      }

      return reply.send({ success: true });
    }
  );

  // Get agent's followers
  fastify.get<{ Params: { name: string }; Querystring: { limit?: number; offset?: number } }>(
    '/agents/:name/followers',
    async (request, reply) => {
      const agent = agentsDAL.findAgentByName(request.params.name);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;

      const followers = followsDAL.getFollowers(agent.id, limit, offset);
      const total = followsDAL.getFollowerCount(agent.id);

      return reply.send({
        data: followers,
        total,
        limit,
        offset,
      });
    }
  );

  // Get agents the agent is following
  fastify.get<{ Params: { name: string }; Querystring: { limit?: number; offset?: number } }>(
    '/agents/:name/following',
    async (request, reply) => {
      const agent = agentsDAL.findAgentByName(request.params.name);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;

      const following = followsDAL.getFollowing(agent.id, limit, offset);
      const total = followsDAL.getFollowingCount(agent.id);

      return reply.send({
        data: following,
        total,
        limit,
        offset,
      });
    }
  );

}
