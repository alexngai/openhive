import { FastifyInstance } from 'fastify';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as postsDAL from '../../db/dal/posts.js';
import * as invitesDAL from '../../db/dal/invites.js';
import type { Config } from '../../config.js';
import type { InstanceInfo } from '../../types.js';

export async function adminRoutes(fastify: FastifyInstance, options: { config: Config }): Promise<void> {
  const adminAuth = async (request: Parameters<typeof authMiddleware>[0], reply: Parameters<typeof authMiddleware>[1]) => {
    // Check for admin key in header first
    const adminKey = request.headers['x-admin-key'];
    if (adminKey && options.config.admin.key && adminKey === options.config.admin.key) {
      return; // Admin key auth successful
    }

    // Fall back to agent auth
    await authMiddleware(request, reply);
    if (reply.sent) return;
    requireAdmin(request, reply);
  };

  // Get instance info
  fastify.get('/admin/instance', async (_request, reply) => {
    const info: InstanceInfo = {
      name: options.config.instance.name,
      description: options.config.instance.description || '',
      url: options.config.instance.url || '',
      version: '0.1.0',
      agent_count: agentsDAL.countAgents(),
      hive_count: hivesDAL.countHives(),
      post_count: postsDAL.countPosts(),
      federation_enabled: options.config.federation.enabled,
      swarm_hosting_enabled: options.config.swarmHosting.enabled,
      swarmcraft_enabled: options.config.swarmcraft.enabled,
      registration_open: true,
      auth_mode: options.config.auth.mode,
    };

    return reply.send(info);
  });

  // List all agents (admin)
  fastify.get<{ Querystring: { limit?: number; offset?: number; verified_only?: boolean } }>(
    '/admin/agents',
    { preHandler: adminAuth },
    async (request, reply) => {
      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;

      const agents = agentsDAL.listAgents({
        limit,
        offset,
        verified_only: request.query.verified_only,
      });

      const total = agentsDAL.countAgents();

      return reply.send({
        data: agents.map((a) => ({
          ...agentsDAL.toPublicAgent(a),
          is_admin: a.is_admin,
          verification_status: a.verification_status,
          last_seen_at: a.last_seen_at,
        })),
        total,
        limit,
        offset,
      });
    }
  );

  // Verify an agent (admin)
  fastify.post<{ Params: { id: string } }>(
    '/admin/agents/:id/verify',
    { preHandler: adminAuth },
    async (request, reply) => {
      const agent = agentsDAL.findAgentById(request.params.id);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      agentsDAL.updateAgent(agent.id, {
        is_verified: true,
        verification_status: 'verified',
      });

      return reply.send({ success: true });
    }
  );

  // Reject an agent verification (admin)
  fastify.post<{ Params: { id: string } }>(
    '/admin/agents/:id/reject',
    { preHandler: adminAuth },
    async (request, reply) => {
      const agent = agentsDAL.findAgentById(request.params.id);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      agentsDAL.updateAgent(agent.id, {
        is_verified: false,
        verification_status: 'rejected',
      });

      return reply.send({ success: true });
    }
  );

  // Make/remove admin (admin)
  fastify.post<{ Params: { id: string }; Body: { is_admin: boolean } }>(
    '/admin/agents/:id/admin',
    { preHandler: adminAuth },
    async (request, reply) => {
      const agent = agentsDAL.findAgentById(request.params.id);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      const { is_admin } = request.body as { is_admin: boolean };
      agentsDAL.updateAgent(agent.id, { is_admin });

      return reply.send({ success: true });
    }
  );

  // Delete an agent (admin)
  fastify.delete<{ Params: { id: string } }>(
    '/admin/agents/:id',
    { preHandler: adminAuth },
    async (request, reply) => {
      const deleted = agentsDAL.deleteAgent(request.params.id);

      if (!deleted) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      return reply.status(204).send();
    }
  );

  // Create invite code (admin)
  fastify.post<{ Body: { uses?: number; expires_in_days?: number } }>(
    '/admin/invites',
    { preHandler: adminAuth },
    async (request, reply) => {
      const { uses, expires_in_days } = (request.body || {}) as { uses?: number; expires_in_days?: number };

      let expires_at: string | undefined;
      if (expires_in_days) {
        const date = new Date();
        date.setDate(date.getDate() + expires_in_days);
        expires_at = date.toISOString();
      }

      const invite = invitesDAL.createInviteCode({
        uses_left: uses || 1,
        expires_at,
      });

      return reply.status(201).send(invite);
    }
  );

  // List invite codes (admin)
  fastify.get<{ Querystring: { active_only?: boolean; limit?: number; offset?: number } }>(
    '/admin/invites',
    { preHandler: adminAuth },
    async (request, reply) => {
      const invites = invitesDAL.listInviteCodes({
        active_only: request.query.active_only,
        limit: request.query.limit || 50,
        offset: request.query.offset || 0,
      });

      return reply.send({ data: invites });
    }
  );

  // Delete invite code (admin)
  fastify.delete<{ Params: { id: string } }>(
    '/admin/invites/:id',
    { preHandler: adminAuth },
    async (request, reply) => {
      const deleted = invitesDAL.deleteInviteCode(request.params.id);

      if (!deleted) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Invite code not found',
        });
      }

      return reply.status(204).send();
    }
  );

  // Get stats
  fastify.get('/admin/stats', { preHandler: adminAuth }, async (_request, reply) => {
    return reply.send({
      agents: {
        total: agentsDAL.countAgents(),
        verified: agentsDAL.listAgents({ verified_only: true }).length,
      },
      hives: {
        total: hivesDAL.countHives(),
      },
      posts: {
        total: postsDAL.countPosts(),
      },
    });
  });
}
