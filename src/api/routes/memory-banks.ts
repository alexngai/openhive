/**
 * Memory Banks API Routes
 *
 * This module provides backward-compatible /memory-banks endpoints that
 * delegate to the generic syncable resources system with resource_type='memory_bank'.
 *
 * New integrations should prefer using the /resources API directly.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { broadcast, broadcastToChannel } from '../../realtime/index.js';
import { checkRemoteForUpdates, checkRemotesBatch } from '../../utils/git-remote.js';
import type { ResourceVisibility } from '../../types.js';
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

// Helper to transform resource to memory bank format for backward compatibility
function toMemoryBankFormat(resource: ReturnType<typeof resourcesDAL.getResourceWithMeta>) {
  if (!resource) return null;
  return {
    id: resource.id,
    name: resource.name,
    description: resource.description,
    git_remote_url: resource.git_remote_url,
    webhook_secret: resource.webhook_secret,
    visibility: resource.visibility,
    last_commit_hash: resource.last_commit_hash,
    last_push_by: resource.last_push_by,
    last_push_at: resource.last_push_at,
    owner_agent_id: resource.owner_agent_id,
    created_at: resource.created_at,
    updated_at: resource.updated_at,
    owner: resource.owner,
    tags: resource.tags,
    subscriber_count: resource.subscriber_count,
    is_subscribed: resource.is_subscribed,
    my_permission: resource.my_permission,
  };
}

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
      visibility?: ResourceVisibility;
      limit?: number;
      offset?: number;
    };
  }>('/memory-banks', { preHandler: authMiddleware }, async (request, reply) => {
    const limit = Math.min(request.query.limit || 50, 100);
    const offset = request.query.offset || 0;
    const owned = request.query.owned === 'true';

    const result = resourcesDAL.listAccessibleResources({
      agentId: request.agent!.id,
      resourceType: 'memory_bank',
      owned,
      visibility: request.query.visibility,
      limit,
      offset,
    });

    // Filter out sensitive fields for non-admin users
    const data = result.data.map((resource) => {
      const bank = toMemoryBankFormat(resource);
      const canSeeDetails = resourcesDAL.canAccessResource(request.agent!.id, resource);
      return {
        ...bank,
        webhook_secret: canSeeDetails && resource.my_permission === 'admin' ? bank?.webhook_secret : undefined,
        git_remote_url: canSeeDetails ? bank?.git_remote_url : undefined,
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

    const result = resourcesDAL.discoverPublicResources({
      resourceType: 'memory_bank',
      query: request.query.q,
      tags,
      limit,
      offset,
    });

    return reply.send({
      data: result.data.map(toMemoryBankFormat),
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
      const resource = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name,
        description,
        git_remote_url,
        visibility,
        owner_agent_id: request.agent!.id,
      });

      // Set tags if provided
      if (tags && tags.length > 0) {
        resourcesDAL.setResourceTags(resource.id, tags);
      }

      // Get full resource with metadata
      const resourceWithMeta = resourcesDAL.getResourceWithMeta(resource.id, request.agent!.id);
      const bankWithMeta = toMemoryBankFormat(resourceWithMeta);

      // Build webhook URL
      const webhookUrl = `${config.instance.url}/api/v1/webhooks/resource/${resource.id}`;

      // Broadcast memory_bank_created event for public/shared banks
      if (visibility !== 'private') {
        broadcast({
          type: 'memory_bank_created',
          data: {
            bank_id: resource.id,
            bank_name: name,
            visibility,
            owner: resourceWithMeta?.owner,
          },
          timestamp: new Date().toISOString(),
        });
      }

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
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check access
      if (resource.visibility === 'private') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, resource)) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Memory bank not found',
          });
        }
      } else if (resource.visibility === 'shared') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, resource)) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You do not have access to this memory bank',
          });
        }
      }

      const resourceWithMeta = resourcesDAL.getResourceWithMeta(
        resource.id,
        request.agent?.id
      );

      if (!resourceWithMeta) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      const bankWithMeta = toMemoryBankFormat(resourceWithMeta);

      // Filter sensitive fields based on permission
      const canSeeAdmin = request.agent && resourceWithMeta.my_permission === 'admin';

      return reply.send({
        ...bankWithMeta,
        webhook_secret: canSeeAdmin ? bankWithMeta?.webhook_secret : undefined,
        git_remote_url: request.agent && resourcesDAL.canAccessResource(request.agent.id, resource)
          ? bankWithMeta?.git_remote_url
          : undefined,
      });
    }
  );

  // Update memory bank
  fastify.patch<{ Params: { id: string } }>(
    '/memory-banks/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check permission
      if (!resourcesDAL.canModifyResource(request.agent!.id, resource)) {
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
      resourcesDAL.updateResource(resource.id, updateData);
      const resourceWithMeta = resourcesDAL.getResourceWithMeta(resource.id, request.agent!.id);

      return reply.send(toMemoryBankFormat(resourceWithMeta));
    }
  );

  // Delete memory bank
  fastify.delete<{ Params: { id: string } }>(
    '/memory-banks/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Only owner can delete
      if (resource.owner_agent_id !== request.agent!.id) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only the owner can delete a memory bank',
        });
      }

      resourcesDAL.deleteResource(resource.id);

      return reply.send({ success: true });
    }
  );

  // Regenerate webhook secret
  fastify.post<{ Params: { id: string } }>(
    '/memory-banks/:id/regenerate-secret',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Only admin can regenerate secret
      if (!resourcesDAL.canModifyResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to regenerate the webhook secret',
        });
      }

      const newSecret = resourcesDAL.regenerateWebhookSecret(resource.id);
      const webhookUrl = `${config.instance.url}/api/v1/webhooks/resource/${resource.id}`;

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
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check if can subscribe
      if (resource.visibility === 'private') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Cannot subscribe to a private memory bank',
        });
      }

      if (resource.visibility === 'shared') {
        // For shared banks, need explicit access grant first
        const existingSub = resourcesDAL.getSubscription(request.agent!.id, resource.id);
        if (!existingSub) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You need to be granted access to subscribe to this memory bank',
          });
        }
      }

      // Public banks: anyone can subscribe with read permission
      const subscription = resourcesDAL.subscribeToResource(
        request.agent!.id,
        resource.id,
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
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      const success = resourcesDAL.unsubscribeFromResource(request.agent!.id, resource.id);

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
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check permission
      if (!resourcesDAL.canModifyResource(request.agent!.id, resource)) {
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
      if (agent_id === resource.owner_agent_id) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Cannot modify owner permission',
        });
      }

      const subscription = resourcesDAL.subscribeToResource(agent_id, resource.id, permission);

      return reply.status(201).send(subscription);
    }
  );

  // Revoke access from an agent
  fastify.delete<{ Params: { id: string; agentId: string } }>(
    '/memory-banks/:id/access/:agentId',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check permission
      if (!resourcesDAL.canModifyResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to revoke access',
        });
      }

      const { agentId } = request.params;

      // Can't revoke owner's access
      if (agentId === resource.owner_agent_id) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Cannot revoke owner access',
        });
      }

      const success = resourcesDAL.unsubscribeFromResource(agentId, resource.id);

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
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check permission - only admin can see subscribers
      if (!resourcesDAL.canModifyResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to view subscribers',
        });
      }

      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;

      const result = resourcesDAL.getResourceSubscribers(resource.id, limit, offset);

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
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check permission
      if (!resourcesDAL.canModifyResource(request.agent!.id, resource)) {
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

      resourcesDAL.setResourceTags(resource.id, parseResult.data.tags);

      const tags = resourcesDAL.getResourceTags(resource.id);

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
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check access
      if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this memory bank',
        });
      }

      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;

      const result = resourcesDAL.getSyncEvents(resource.id, limit, offset);

      // Transform to legacy format (bank_id instead of resource_id)
      const data = result.data.map((event) => ({
        id: event.id,
        bank_id: event.resource_id,
        commit_hash: event.commit_hash,
        commit_message: event.commit_message,
        pusher: event.pusher,
        files_added: event.files_added,
        files_modified: event.files_modified,
        files_removed: event.files_removed,
        timestamp: event.timestamp,
      }));

      return reply.send({
        data,
        total: result.total,
        limit,
        offset,
      });
    }
  );

  // ============================================================================
  // Polling-based Sync (webhook-free alternative)
  // ============================================================================

  // Check a single memory bank for updates
  fastify.post<{
    Params: { id: string };
    Body: { branch?: string };
  }>(
    '/memory-banks/:id/check-updates',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'memory_bank') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memory bank not found',
        });
      }

      // Check poll permission (owner or write/admin)
      if (!resourcesDAL.canPollResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to poll this memory bank',
        });
      }

      const branch = (request.body as { branch?: string })?.branch || 'main';

      // Check remote for updates
      const result = await checkRemoteForUpdates(resource.git_remote_url, branch);

      if (!result.success) {
        return reply.status(502).send({
          error: 'Upstream Error',
          message: result.error || 'Failed to check remote for updates',
          source: result.source,
        });
      }

      const remoteCommit = result.ref!.commitHash;
      const hasUpdates = resource.last_commit_hash !== remoteCommit;

      if (hasUpdates) {
        // Update sync state
        resourcesDAL.updateResourceSyncState(
          resource.id,
          remoteCommit,
          'poll'
        );

        // Create sync event
        const syncEvent = resourcesDAL.createSyncEvent({
          resource_id: resource.id,
          commit_hash: remoteCommit,
          commit_message: undefined,
          pusher: `poll:${request.agent!.name}`,
        });

        // Broadcast to WebSocket subscribers
        broadcastToChannel(`memory-bank:${resource.id}`, {
          type: 'memory_bank_updated',
          data: {
            bank_id: resource.id,
            bank_name: resource.name,
            commit_hash: remoteCommit,
            commit_message: null,
            pusher: `poll:${request.agent!.name}`,
            source: 'poll',
            event_id: syncEvent.id,
          },
        });

        return reply.send({
          has_updates: true,
          previous_commit: resource.last_commit_hash,
          current_commit: remoteCommit,
          source: result.source,
          event_id: syncEvent.id,
        });
      }

      return reply.send({
        has_updates: false,
        current_commit: remoteCommit,
        source: result.source,
      });
    }
  );

  // Batch check multiple memory banks for updates
  const BatchCheckSchema = z.object({
    bank_ids: z.array(z.string()).max(50).optional(),
    branch: z.string().default('main'),
  });

  fastify.post(
    '/memory-banks/check-updates',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const parseResult = BatchCheckSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { bank_ids, branch } = parseResult.data;

      // Get resources to check (only memory_bank type)
      let resources: ReturnType<typeof resourcesDAL.getAgentPollableResources>;

      if (bank_ids && bank_ids.length > 0) {
        // Check specific resources
        resources = resourcesDAL.getAgentPollableResourcesByIds(
          request.agent!.id,
          bank_ids,
          'memory_bank'
        );
      } else {
        // Check all pollable memory banks
        resources = resourcesDAL.getAgentPollableResources(request.agent!.id, 'memory_bank');
      }

      if (resources.length === 0) {
        return reply.send({
          checked: 0,
          updated: [],
          errors: [],
        });
      }

      // Limit batch size
      const resourcesToCheck = resources.slice(0, 50);

      // Check remotes in parallel
      const remotes = resourcesToCheck.map((r) => ({
        id: r.id,
        gitRemoteUrl: r.git_remote_url,
        branch,
      }));

      const results = await checkRemotesBatch(remotes, 5);

      const updated: Array<{
        bank_id: string;
        bank_name: string;
        previous_commit: string | null;
        current_commit: string;
        event_id: string;
      }> = [];

      const errors: Array<{
        bank_id: string;
        bank_name: string;
        error: string;
      }> = [];

      const unchanged: string[] = [];

      for (const resource of resourcesToCheck) {
        const result = results.get(resource.id);

        if (!result || !result.success) {
          errors.push({
            bank_id: resource.id,
            bank_name: resource.name,
            error: result?.error || 'Unknown error',
          });
          continue;
        }

        const remoteCommit = result.ref!.commitHash;
        const hasUpdates = resource.last_commit_hash !== remoteCommit;

        if (hasUpdates) {
          // Update sync state
          resourcesDAL.updateResourceSyncState(
            resource.id,
            remoteCommit,
            'poll'
          );

          // Create sync event
          const syncEvent = resourcesDAL.createSyncEvent({
            resource_id: resource.id,
            commit_hash: remoteCommit,
            pusher: `poll:${request.agent!.name}`,
          });

          // Broadcast to WebSocket subscribers
          broadcastToChannel(`memory-bank:${resource.id}`, {
            type: 'memory_bank_updated',
            data: {
              bank_id: resource.id,
              bank_name: resource.name,
              commit_hash: remoteCommit,
              commit_message: null,
              pusher: `poll:${request.agent!.name}`,
              source: 'poll',
              event_id: syncEvent.id,
            },
          });

          updated.push({
            bank_id: resource.id,
            bank_name: resource.name,
            previous_commit: resource.last_commit_hash,
            current_commit: remoteCommit,
            event_id: syncEvent.id,
          });
        } else {
          unchanged.push(resource.id);
        }
      }

      return reply.send({
        checked: resourcesToCheck.length,
        updated,
        unchanged,
        errors,
      });
    }
  );
}
