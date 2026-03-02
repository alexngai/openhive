import { FastifyInstance } from 'fastify';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as postsDAL from '../../db/dal/posts.js';
import * as invitesDAL from '../../db/dal/invites.js';
import * as ingestKeysDAL from '../../db/dal/ingest-keys.js';
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

  // ═══════════════════════════════════════════════════════════════
  // Ingest API Keys
  // ═══════════════════════════════════════════════════════════════

  // Create ingest key
  fastify.post<{
    Body: { label: string; agent_id?: string; agent_name?: string; expires_in_hours?: number };
  }>(
    '/admin/ingest-keys',
    { preHandler: adminAuth },
    async (request, reply) => {
      const { label, agent_id, agent_name, scopes, expires_in_hours } = request.body as {
        label: string;
        agent_id?: string;
        agent_name?: string;
        scopes?: string[];
        expires_in_hours?: number;
      };

      if (!label) {
        return reply.status(400).send({ error: 'Validation Error', message: 'label is required' });
      }

      let targetAgentId = agent_id;

      if (!targetAgentId) {
        // Auto-create a synthetic agent for this key
        const name = agent_name || `ingest-${label}`;
        const existing = agentsDAL.findAgentByName(name);
        if (existing) {
          targetAgentId = existing.id;
        } else {
          const { agent } = await agentsDAL.createAgent({
            name,
            description: `Auto-created agent for ingest key: ${label}`,
          });
          targetAgentId = agent.id;
        }
      } else {
        const existing = agentsDAL.findAgentById(targetAgentId);
        if (!existing) {
          return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
        }
      }

      // Validate scopes
      const validScopes = ['map', 'sessions', 'resources', 'admin', '*'];
      const keyScopes = scopes?.length ? scopes : ['map'];
      for (const s of keyScopes) {
        if (!validScopes.includes(s)) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: `Invalid scope '${s}'. Valid scopes: ${validScopes.join(', ')}`,
          });
        }
      }

      const result = ingestKeysDAL.createIngestKey(request.agent?.id ?? targetAgentId, {
        label,
        agent_id: targetAgentId,
        scopes: keyScopes as ingestKeysDAL.CreateIngestKeyInput['scopes'],
        expires_in_hours,
      });

      return reply.status(201).send({
        id: result.key.id,
        key: result.plaintext_key,
        label: result.key.label,
        scopes: result.key.scopes,
        agent_id: result.key.agent_id,
        expires_at: result.key.expires_at,
        created_at: result.key.created_at,
      });
    },
  );

  // List ingest keys
  fastify.get<{
    Querystring: { agent_id?: string; include_revoked?: boolean; limit?: number; offset?: number };
  }>(
    '/admin/ingest-keys',
    { preHandler: adminAuth },
    async (request, reply) => {
      const keys = ingestKeysDAL.listIngestKeys({
        agent_id: request.query.agent_id,
        include_revoked: request.query.include_revoked,
        limit: Math.min(request.query.limit || 50, 100),
        offset: request.query.offset || 0,
      });

      const data = keys.map((k) => ({
        id: k.id,
        label: k.label,
        key: k.key_value,
        scopes: k.scopes,
        agent_id: k.agent_id,
        revoked: k.revoked,
        expires_at: k.expires_at,
        created_by: k.created_by,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
      }));

      return reply.send({ data });
    },
  );

  // Revoke ingest key (soft delete)
  fastify.post<{ Params: { id: string } }>(
    '/admin/ingest-keys/:id/revoke',
    { preHandler: adminAuth },
    async (request, reply) => {
      const revoked = ingestKeysDAL.revokeIngestKey(request.params.id);
      if (!revoked) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Ingest key not found or already revoked' });
      }
      return reply.send({ success: true });
    },
  );

  // Delete ingest key (hard delete)
  fastify.delete<{ Params: { id: string } }>(
    '/admin/ingest-keys/:id',
    { preHandler: adminAuth },
    async (request, reply) => {
      const deleted = ingestKeysDAL.deleteIngestKey(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Not Found', message: 'Ingest key not found' });
      }
      return reply.status(204).send();
    },
  );
}
