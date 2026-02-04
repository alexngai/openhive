import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { broadcast, broadcastToChannel } from '../../realtime/index.js';
import { checkRemoteForUpdates, checkRemotesBatch } from '../../utils/git-remote.js';
import type { SyncableResourceType, ResourceVisibility } from '../../types.js';
import type { Config } from '../../config.js';

// Valid resource types
const RESOURCE_TYPES = ['memory_bank', 'task', 'skill', 'session'] as const;

// Validation schemas
const CreateResourceSchema = z.object({
  resource_type: z.enum(RESOURCE_TYPES),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9\/_-]*$/, 'Name must start with alphanumeric and contain only alphanumeric, /, _, -'),
  description: z.string().max(500).optional(),
  git_remote_url: z.string().min(1).max(500),
  visibility: z.enum(['private', 'shared', 'public']).default('private'),
  tags: z.array(z.string().max(50)).max(10).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const UpdateResourceSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9\/_-]*$/)
    .optional(),
  description: z.string().max(500).optional().nullable(),
  git_remote_url: z.string().min(1).max(500).optional(),
  visibility: z.enum(['private', 'shared', 'public']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const GrantAccessSchema = z.object({
  agent_id: z.string().min(1),
  permission: z.enum(['read', 'write', 'admin']).default('read'),
});

const SetTagsSchema = z.object({
  tags: z.array(z.string().max(50)).max(10),
});

const BatchCheckSchema = z.object({
  resource_ids: z.array(z.string()).max(50).optional(),
  resource_type: z.enum(RESOURCE_TYPES).optional(),
  branch: z.string().default('main'),
});

export async function resourcesRoutes(
  fastify: FastifyInstance,
  options: { config: Config }
): Promise<void> {
  const { config } = options;

  // ============================================================================
  // Resource CRUD
  // ============================================================================

  // List accessible resources
  fastify.get<{
    Querystring: {
      type?: SyncableResourceType;
      owned?: string;
      visibility?: ResourceVisibility;
      limit?: number;
      offset?: number;
    };
  }>('/resources', { preHandler: authMiddleware }, async (request, reply) => {
    const limit = Math.min(request.query.limit || 50, 100);
    const offset = request.query.offset || 0;
    const owned = request.query.owned === 'true';

    const result = resourcesDAL.listAccessibleResources({
      agentId: request.agent!.id,
      resourceType: request.query.type,
      owned,
      visibility: request.query.visibility,
      limit,
      offset,
    });

    // Filter out sensitive fields for non-admin users
    const data = result.data.map((resource) => {
      const canSeeDetails = resourcesDAL.canAccessResource(request.agent!.id, resource);
      return {
        ...resource,
        webhook_secret: canSeeDetails && resource.my_permission === 'admin' ? resource.webhook_secret : undefined,
        git_remote_url: canSeeDetails ? resource.git_remote_url : undefined,
      };
    });

    return reply.send({
      data,
      total: result.total,
      limit,
      offset,
    });
  });

  // Discover public resources
  fastify.get<{
    Querystring: {
      type?: SyncableResourceType;
      q?: string;
      tags?: string;
      limit?: number;
      offset?: number;
    };
  }>('/resources/discover', { preHandler: optionalAuthMiddleware }, async (request, reply) => {
    const limit = Math.min(request.query.limit || 50, 100);
    const offset = request.query.offset || 0;
    const tags = request.query.tags?.split(',').map((t) => t.trim()).filter(Boolean);

    const result = resourcesDAL.discoverPublicResources({
      resourceType: request.query.type,
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

  // Create a new resource
  fastify.post('/resources', { preHandler: authMiddleware }, async (request, reply) => {
    const parseResult = CreateResourceSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { resource_type, name, description, git_remote_url, visibility, tags, metadata } = parseResult.data;

    try {
      const resource = resourcesDAL.createResource({
        resource_type,
        name,
        description,
        git_remote_url,
        visibility,
        owner_agent_id: request.agent!.id,
        metadata,
      });

      // Set tags if provided
      if (tags && tags.length > 0) {
        resourcesDAL.setResourceTags(resource.id, tags);
      }

      // Get full resource with metadata
      const resourceWithMeta = resourcesDAL.getResourceWithMeta(resource.id, request.agent!.id);

      // Build webhook URL
      const webhookUrl = `${config.instance.url}/api/v1/webhooks/resource/${resource.id}`;

      // Broadcast resource_created event for public/shared resources
      if (visibility !== 'private') {
        broadcast({
          type: 'resource_created',
          data: {
            resource_id: resource.id,
            resource_type,
            resource_name: name,
            visibility,
            owner: resourceWithMeta?.owner,
          },
          timestamp: new Date().toISOString(),
        });
      }

      return reply.status(201).send({
        ...resourceWithMeta,
        webhook_url: webhookUrl,
      });
    } catch (error) {
      // Unique constraint violation
      if ((error as Error).message?.includes('UNIQUE constraint failed')) {
        return reply.status(409).send({
          error: 'Conflict',
          message: `A ${resource_type} resource with this name already exists for your account`,
        });
      }
      throw error;
    }
  });

  // Get resource by ID
  fastify.get<{ Params: { id: string } }>(
    '/resources/:id',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
        });
      }

      // Check access
      if (resource.visibility === 'private') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, resource)) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Resource not found',
          });
        }
      } else if (resource.visibility === 'shared') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, resource)) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You do not have access to this resource',
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
          message: 'Resource not found',
        });
      }

      // Filter sensitive fields based on permission
      const canSeeAdmin = request.agent && resourceWithMeta.my_permission === 'admin';

      return reply.send({
        ...resourceWithMeta,
        webhook_secret: canSeeAdmin ? resourceWithMeta.webhook_secret : undefined,
        git_remote_url: request.agent && resourcesDAL.canAccessResource(request.agent.id, resource)
          ? resourceWithMeta.git_remote_url
          : undefined,
      });
    }
  );

  // Update resource
  fastify.patch<{ Params: { id: string } }>(
    '/resources/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
        });
      }

      // Check permission
      if (!resourcesDAL.canModifyResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to modify this resource',
        });
      }

      const parseResult = UpdateResourceSchema.safeParse(request.body);
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

      return reply.send(resourceWithMeta);
    }
  );

  // Delete resource
  fastify.delete<{ Params: { id: string } }>(
    '/resources/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
        });
      }

      // Only owner can delete
      if (resource.owner_agent_id !== request.agent!.id) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only the owner can delete a resource',
        });
      }

      resourcesDAL.deleteResource(resource.id);

      return reply.send({ success: true });
    }
  );

  // Regenerate webhook secret
  fastify.post<{ Params: { id: string } }>(
    '/resources/:id/regenerate-secret',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
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

  // Subscribe to a resource
  fastify.post<{ Params: { id: string } }>(
    '/resources/:id/subscribe',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
        });
      }

      // Check if can subscribe
      if (resource.visibility === 'private') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Cannot subscribe to a private resource',
        });
      }

      if (resource.visibility === 'shared') {
        // For shared resources, need explicit access grant first
        const existingSub = resourcesDAL.getSubscription(request.agent!.id, resource.id);
        if (!existingSub) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You need to be granted access to subscribe to this resource',
          });
        }
      }

      // Public resources: anyone can subscribe with read permission
      const subscription = resourcesDAL.subscribeToResource(
        request.agent!.id,
        resource.id,
        'read'
      );

      return reply.status(201).send(subscription);
    }
  );

  // Unsubscribe from a resource
  fastify.delete<{ Params: { id: string } }>(
    '/resources/:id/subscribe',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
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
    '/resources/:id/access',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
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
    '/resources/:id/access/:agentId',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
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
          message: 'Agent is not subscribed to this resource',
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
    '/resources/:id/subscribers',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
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
    '/resources/:id/tags',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
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
    '/resources/:id/events',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
        });
      }

      // Check access
      if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this resource',
        });
      }

      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;

      const result = resourcesDAL.getSyncEvents(resource.id, limit, offset);

      return reply.send({
        data: result.data,
        total: result.total,
        limit,
        offset,
      });
    }
  );

  // ============================================================================
  // Polling-based Sync (webhook-free alternative)
  // ============================================================================

  // Check a single resource for updates
  fastify.post<{
    Params: { id: string };
    Body: { branch?: string };
  }>(
    '/resources/:id/check-updates',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found',
        });
      }

      // Check poll permission (owner or write/admin)
      if (!resourcesDAL.canPollResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to poll this resource',
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
        const channel = resourcesDAL.getResourceChannel(resource);
        broadcastToChannel(channel, {
          type: 'resource_updated',
          data: {
            resource_id: resource.id,
            resource_type: resource.resource_type,
            resource_name: resource.name,
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

  // Batch check multiple resources for updates
  fastify.post(
    '/resources/check-updates',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const parseResult = BatchCheckSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { resource_ids, resource_type, branch } = parseResult.data;

      // Get resources to check
      let resources: ReturnType<typeof resourcesDAL.getAgentPollableResources>;

      if (resource_ids && resource_ids.length > 0) {
        // Check specific resources
        resources = resourcesDAL.getAgentPollableResourcesByIds(
          request.agent!.id,
          resource_ids,
          resource_type
        );
      } else {
        // Check all pollable resources
        resources = resourcesDAL.getAgentPollableResources(request.agent!.id, resource_type);
      }

      if (resources.length === 0) {
        return reply.send({
          checked: 0,
          updated: [],
          unchanged: [],
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
        resource_id: string;
        resource_type: SyncableResourceType;
        resource_name: string;
        previous_commit: string | null;
        current_commit: string;
        event_id: string;
      }> = [];

      const errors: Array<{
        resource_id: string;
        resource_name: string;
        error: string;
      }> = [];

      const unchanged: string[] = [];

      for (const resource of resourcesToCheck) {
        const result = results.get(resource.id);

        if (!result || !result.success) {
          errors.push({
            resource_id: resource.id,
            resource_name: resource.name,
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
          const channel = resourcesDAL.getResourceChannel(resource);
          broadcastToChannel(channel, {
            type: 'resource_updated',
            data: {
              resource_id: resource.id,
              resource_type: resource.resource_type,
              resource_name: resource.name,
              commit_hash: remoteCommit,
              commit_message: null,
              pusher: `poll:${request.agent!.name}`,
              source: 'poll',
              event_id: syncEvent.id,
            },
          });

          updated.push({
            resource_id: resource.id,
            resource_type: resource.resource_type,
            resource_name: resource.name,
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

  // ============================================================================
  // Resource Type Specific Endpoints
  // ============================================================================

  // List resources by type (convenience endpoints)
  for (const resourceType of RESOURCE_TYPES) {
    const pluralType = resourceType === 'skill' ? 'skills' : `${resourceType}s`;

    // List resources of a specific type
    fastify.get<{
      Querystring: {
        owned?: string;
        visibility?: ResourceVisibility;
        limit?: number;
        offset?: number;
      };
    }>(`/${pluralType}`, { preHandler: authMiddleware }, async (request, reply) => {
      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;
      const owned = request.query.owned === 'true';

      const result = resourcesDAL.listAccessibleResources({
        agentId: request.agent!.id,
        resourceType: resourceType,
        owned,
        visibility: request.query.visibility,
        limit,
        offset,
      });

      // Filter out sensitive fields
      const data = result.data.map((resource) => {
        const canSeeDetails = resourcesDAL.canAccessResource(request.agent!.id, resource);
        return {
          ...resource,
          webhook_secret: canSeeDetails && resource.my_permission === 'admin' ? resource.webhook_secret : undefined,
          git_remote_url: canSeeDetails ? resource.git_remote_url : undefined,
        };
      });

      return reply.send({
        data,
        total: result.total,
        limit,
        offset,
      });
    });

    // Discover public resources of a specific type
    fastify.get<{
      Querystring: {
        q?: string;
        tags?: string;
        limit?: number;
        offset?: number;
      };
    }>(`/${pluralType}/discover`, { preHandler: optionalAuthMiddleware }, async (request, reply) => {
      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;
      const tags = request.query.tags?.split(',').map((t) => t.trim()).filter(Boolean);

      const result = resourcesDAL.discoverPublicResources({
        resourceType: resourceType,
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
  }
}
