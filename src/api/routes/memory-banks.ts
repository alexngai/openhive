import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as memoryBanksDAL from '../../db/dal/memory-banks.js';
import type { MemoryBankVisibility } from '../../types.js';
import type { Config } from '../../config.js';

// Validation schemas
const CreateMemoryBankSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9\/_-]*$/, 'Name must start with alphanumeric and contain only alphanumeric, /, _, -'),
  description: z.string().max(500).optional(),
  git_remote_url: z.string().min(1).max(500),
  visibility: z.enum(['private', 'shared', 'public']).default('private'),
  tags: z.array(z.string().max(50)).max(10).optional(),
});

const UpdateMemoryBankSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9\/_-]*$/)
    .optional(),
  description: z.string().max(500).optional().nullable(),
  git_remote_url: z.string().min(1).max(500).optional(),
  visibility: z.enum(['private', 'shared', 'public']).optional(),
});

const GrantAccessSchema = z.object({
  agent_id: z.string().min(1),
  permission: z.enum(['read', 'write', 'admin']).default('read'),
});

const SetTagsSchema = z.object({
  tags: z.array(z.string().max(50)).max(10),
});

export async function memoryBanksRoutes(
  fastify: FastifyInstance,
  options: { config: Config }
): Promise<void> {
  const { config } = options;

  // ============================================================================
  // Memory Bank CRUD
  // ============================================================================

  // List accessible memory banks
  fastify.get<{
    Querystring: {
      owned?: string;
      visibility?: MemoryBankVisibility;
      limit?: number;
      offset?: number;
    };
  }>('/memory-banks', { preHandler: authMiddleware }, async (request, reply) => {
    const limit = Math.min(request.query.limit || 50, 100);
    const offset = request.query.offset || 0;
    const owned = request.query.owned === 'true';

    const result = memoryBanksDAL.listAccessibleMemoryBanks({
      agentId: request.agent!.id,
      owned,
      visibility: request.query.visibility,
      limit,
      offset,
    });

    // Filter out sensitive fields for non-admin users
    const data = result.data.map((bank) => {
      // Only show webhook_secret and git_remote_url to users with access
      const canSeeDetails = memoryBanksDAL.canAccessMemoryBank(request.agent!.id, bank);
      return {
        ...bank,
        webhook_secret: canSeeDetails && bank.my_permission === 'admin' ? bank.webhook_secret : undefined,
        git_remote_url: canSeeDetails ? bank.git_remote_url : undefined,
      };
    });

    return reply.send({
      data,
      total: result.total,
      limit,
      offset,
    });
  });

  // Discover public memory banks
  fastify.get<{
    Querystring: {
      q?: string;
      tags?: string;
      limit?: number;
      offset?: number;
    };
  }>('/memory-banks/discover', { preHandler: optionalAuthMiddleware }, async (request, reply) => {
    const limit = Math.min(request.query.limit || 50, 100);
    const offset = request.query.offset || 0;
    const tags = request.query.tags?.split(',').map((t) => t.trim()).filter(Boolean);

    const result = memoryBanksDAL.discoverPublicMemoryBanks({
      query: request.query.q,
      tags,
      limit,
      offset,
    });

    return reply.send({
      data: result.data,
      total: result.total,
      limit,
      offset,
    });
  });

  // Create a new memory bank
  fastify.post('/memory-banks', { preHandler: authMiddleware }, async (request, reply) => {
    const parseResult = CreateMemoryBankSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { name, description, git_remote_url, visibility, tags } = parseResult.data;

    try {
      const bank = memoryBanksDAL.createMemoryBank({
        name,
        description,
        git_remote_url,
        visibility,
        owner_agent_id: request.agent!.id,
      });

      // Set tags if provided
      if (tags && tags.length > 0) {
        memoryBanksDAL.setMemoryBankTags(bank.id, tags);
      }

      // Get full bank with metadata
      const bankWithMeta = memoryBanksDAL.getMemoryBankWithMeta(bank.id, request.agent!.id);

      // Build webhook URL
      const webhookUrl = `${config.instance.url}/api/v1/webhooks/git/${bank.id}`;

      return reply.status(201).send({
        ...bankWithMeta,
        webhook_url: webhookUrl,
      });
    } catch (error) {
      // Unique constraint violation
      if ((error as Error).message?.includes('UNIQUE constraint failed')) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'A memory bank with this name already exists for your account',
        });
      }
      throw error;
    }
  });

  // Get memory bank by ID
  fastify.get<{ Params: { id: string } }>(
    '/memory-banks/:id',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check access
      if (bank.visibility === 'private') {
        if (!request.agent || !memoryBanksDAL.canAccessMemoryBank(request.agent.id, bank)) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Memory bank not found',
          });
        }
      } else if (bank.visibility === 'shared') {
        if (!request.agent || !memoryBanksDAL.canAccessMemoryBank(request.agent.id, bank)) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You do not have access to this memory bank',
          });
        }
      }

      const bankWithMeta = memoryBanksDAL.getMemoryBankWithMeta(
        bank.id,
        request.agent?.id
      );

      if (!bankWithMeta) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Filter sensitive fields based on permission
      const canSeeAdmin = request.agent && bankWithMeta.my_permission === 'admin';

      return reply.send({
        ...bankWithMeta,
        webhook_secret: canSeeAdmin ? bankWithMeta.webhook_secret : undefined,
        git_remote_url: request.agent && memoryBanksDAL.canAccessMemoryBank(request.agent.id, bank)
          ? bankWithMeta.git_remote_url
          : undefined,
      });
    }
  );

  // Update memory bank
  fastify.patch<{ Params: { id: string } }>(
    '/memory-banks/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check permission
      if (!memoryBanksDAL.canModifyMemoryBank(request.agent!.id, bank)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to modify this memory bank',
        });
      }

      const parseResult = UpdateMemoryBankSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      // Transform nullable description to undefined for DAL
      const updateData = {
        ...parseResult.data,
        description: parseResult.data.description === null ? undefined : parseResult.data.description,
      };
      memoryBanksDAL.updateMemoryBank(bank.id, updateData);
      const bankWithMeta = memoryBanksDAL.getMemoryBankWithMeta(bank.id, request.agent!.id);

      return reply.send(bankWithMeta);
    }
  );

  // Delete memory bank
  fastify.delete<{ Params: { id: string } }>(
    '/memory-banks/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Only owner can delete
      if (bank.owner_agent_id !== request.agent!.id) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only the owner can delete a memory bank',
        });
      }

      memoryBanksDAL.deleteMemoryBank(bank.id);

      return reply.send({ success: true });
    }
  );

  // Regenerate webhook secret
  fastify.post<{ Params: { id: string } }>(
    '/memory-banks/:id/regenerate-secret',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Only admin can regenerate secret
      if (!memoryBanksDAL.canModifyMemoryBank(request.agent!.id, bank)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to regenerate the webhook secret',
        });
      }

      const newSecret = memoryBanksDAL.regenerateWebhookSecret(bank.id);
      const webhookUrl = `${config.instance.url}/api/v1/webhooks/git/${bank.id}`;

      return reply.send({
        webhook_secret: newSecret,
        webhook_url: webhookUrl,
      });
    }
  );

  // ============================================================================
  // Subscriptions
  // ============================================================================

  // Subscribe to a memory bank
  fastify.post<{ Params: { id: string } }>(
    '/memory-banks/:id/subscribe',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check if can subscribe
      if (bank.visibility === 'private') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Cannot subscribe to a private memory bank',
        });
      }

      if (bank.visibility === 'shared') {
        // For shared banks, need explicit access grant first
        const existingSub = memoryBanksDAL.getSubscription(request.agent!.id, bank.id);
        if (!existingSub) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You need to be granted access to subscribe to this memory bank',
          });
        }
      }

      // Public banks: anyone can subscribe with read permission
      const subscription = memoryBanksDAL.subscribeToMemoryBank(
        request.agent!.id,
        bank.id,
        'read'
      );

      return reply.status(201).send(subscription);
    }
  );

  // Unsubscribe from a memory bank
  fastify.delete<{ Params: { id: string } }>(
    '/memory-banks/:id/subscribe',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      const success = memoryBanksDAL.unsubscribeFromMemoryBank(request.agent!.id, bank.id);

      if (!success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Cannot unsubscribe. You may be the owner or not subscribed.',
        });
      }

      return reply.send({ success: true });
    }
  );

  // Grant access to another agent
  fastify.post<{ Params: { id: string } }>(
    '/memory-banks/:id/access',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check permission
      if (!memoryBanksDAL.canModifyMemoryBank(request.agent!.id, bank)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to grant access',
        });
      }

      const parseResult = GrantAccessSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { agent_id, permission } = parseResult.data;

      // Can't change owner's permission
      if (agent_id === bank.owner_agent_id) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Cannot modify owner permission',
        });
      }

      const subscription = memoryBanksDAL.subscribeToMemoryBank(agent_id, bank.id, permission);

      return reply.status(201).send(subscription);
    }
  );

  // Revoke access from an agent
  fastify.delete<{ Params: { id: string; agentId: string } }>(
    '/memory-banks/:id/access/:agentId',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check permission
      if (!memoryBanksDAL.canModifyMemoryBank(request.agent!.id, bank)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to revoke access',
        });
      }

      const { agentId } = request.params;

      // Can't revoke owner's access
      if (agentId === bank.owner_agent_id) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Cannot revoke owner access',
        });
      }

      const success = memoryBanksDAL.unsubscribeFromMemoryBank(agentId, bank.id);

      if (!success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Agent is not subscribed to this memory bank',
        });
      }

      return reply.send({ success: true });
    }
  );

  // List subscribers
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: number; offset?: number };
  }>(
    '/memory-banks/:id/subscribers',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check permission - only admin can see subscribers
      if (!memoryBanksDAL.canModifyMemoryBank(request.agent!.id, bank)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to view subscribers',
        });
      }

      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;

      const result = memoryBanksDAL.getMemoryBankSubscribers(bank.id, limit, offset);

      return reply.send({
        data: result.data,
        total: result.total,
        limit,
        offset,
      });
    }
  );

  // ============================================================================
  // Tags
  // ============================================================================

  // Set tags
  fastify.put<{ Params: { id: string } }>(
    '/memory-banks/:id/tags',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check permission
      if (!memoryBanksDAL.canModifyMemoryBank(request.agent!.id, bank)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to modify tags',
        });
      }

      const parseResult = SetTagsSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      memoryBanksDAL.setMemoryBankTags(bank.id, parseResult.data.tags);

      const tags = memoryBanksDAL.getMemoryBankTags(bank.id);

      return reply.send({ tags });
    }
  );

  // ============================================================================
  // Sync Events
  // ============================================================================

  // Get sync events
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: number; offset?: number };
  }>(
    '/memory-banks/:id/events',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bank = memoryBanksDAL.findMemoryBankById(request.params.id);

      if (!bank) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check access
      if (!memoryBanksDAL.canAccessMemoryBank(request.agent!.id, bank)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this memory bank',
        });
      }

      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;

      const result = memoryBanksDAL.getSyncEvents(bank.id, limit, offset);

      return reply.send({
        data: result.data,
        total: result.total,
        limit,
        offset,
      });
    }
  );
}
