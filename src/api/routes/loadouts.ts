/**
 * Loadouts API Routes
 *
 * REST CRUD over `loadout` syncable resources. Parallel to `teams.ts` — see
 * that file for the shared design rationale. A standalone loadout is the
 * leaf-agent unit in openteams's resource model; teams reference loadouts
 * by slug (or inline) but a loadout can equip many teams, so it has its
 * own resource type and lifecycle.
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { broadcastToChannel } from '../../realtime/index.js';
import {
  onResourcePublished,
  onResourceUpdated,
  onResourceUnpublished,
} from '../../sync/resource-hooks.js';
import {
  onLoadoutBundle,
  onLoadoutRemoved,
} from '../../openteams/sync-bridge.js';
import { CreateLoadoutSchema, UpdateLoadoutSchema } from '../schemas/loadouts.js';
import {
  materializeLoadoutById,
  LoadoutNotFoundError,
} from '../../openteams/resolver.js';
import type { Config } from '../../config.js';

export async function loadoutsRoutes(
  fastify: FastifyInstance,
  _options: { config: Config },
): Promise<void> {
  fastify.get<{
    Querystring: {
      owned?: string;
      visibility?: 'private' | 'shared' | 'public';
      limit?: number;
      offset?: number;
    };
  }>('/loadouts', { preHandler: authMiddleware }, async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(request.query.offset) || 0, 0);

    const result = loadoutsDAL.listLoadouts({
      agentId: request.agent!.id,
      owned: request.query.owned === 'true',
      visibility: request.query.visibility,
      limit,
      offset,
    });

    return reply.send({ data: result.data, total: result.total, limit, offset });
  });

  fastify.post('/loadouts', { preHandler: authMiddleware }, async (request, reply) => {
    const parsed = CreateLoadoutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parsed.error.issues,
      });
    }

    try {
      // Layer 6 — `git_remote_url` flips the row to `ls-remote`; the
      // hub lazy-clones the remote on first content read and reconciles
      // via webhook + auto-pull.
      const loadout = loadoutsDAL.createLoadout({
        name: parsed.data.name,
        description: parsed.data.description,
        content: parsed.data.content,
        ownerAgentId: request.agent!.id,
        visibility: parsed.data.visibility,
        metadata: parsed.data.metadata,
        gitRemoteUrl: parsed.data.git_remote_url,
      });

      broadcastToChannel(`resource:loadout:${loadout.id}`, {
        type: 'loadout:created',
        data: { loadout_id: loadout.id, name: loadout.name },
      });

      // Bundle to the MAP store; the kind handler emits `resource.added`
      // on the SDK event bus from inside `put`.
      void onLoadoutBundle(loadout);

      // Mesh fan-out to peer hubs for non-private rows. See the matching
      // hook in teams.ts for the design rationale.
      if (loadout.visibility !== 'private') {
        onResourcePublished(
          {
            id: loadout.id,
            resource_type: 'loadout',
            name: loadout.name,
            description: loadout.description ?? null,
            git_remote_url: loadout.git_remote_url,
            visibility: loadout.visibility,
          },
          [],
          (loadout.metadata as Record<string, unknown> | null) ?? null,
          request.agent!,
        );
      }

      return reply.status(201).send({ loadout });
    } catch (error) {
      if ((error as Error).message?.includes('UNIQUE constraint failed')) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'A loadout with this name already exists for your account',
        });
      }
      throw error;
    }
  });

  fastify.get<{ Params: { id: string } }>(
    '/loadouts/:id',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const loadout = loadoutsDAL.getLoadout(request.params.id);
      if (!loadout) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Loadout not found' });
      }

      if (loadout.visibility === 'private') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, loadout)) {
          return reply
            .status(404)
            .send({ error: 'Not Found', message: 'Loadout not found' });
        }
      } else if (loadout.visibility === 'shared') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, loadout)) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You do not have access to this loadout',
          });
        }
      }

      return reply.send({ loadout });
    },
  );

  // Resolve the row to its content-addressed bundle id. UI uses this to
  // pass loadout_bundle_id to /map/hosted/spawn.
  fastify.get<{ Params: { id: string } }>(
    '/loadouts/:id/bundle',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const loadout = loadoutsDAL.getLoadout(request.params.id);
      if (!loadout) {
        return reply.status(404).send({ error: 'Not Found', message: 'Loadout not found' });
      }
      if (loadout.visibility === 'private') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, loadout)) {
          return reply.status(404).send({ error: 'Not Found', message: 'Loadout not found' });
        }
      } else if (loadout.visibility === 'shared') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, loadout)) {
          return reply.status(403).send({ error: 'Forbidden', message: 'No access' });
        }
      }
      const content = (loadout.metadata as { content?: unknown } | null)?.content;
      if (!content) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'Loadout has no inline content yet (git-backed row pre-first-pull?)',
        });
      }
      try {
        const { bundleLoadoutContent } = await import('../../openteams/internal/bundle-content.js');
        const bundle = bundleLoadoutContent(
          loadout.name,
          content as Parameters<typeof bundleLoadoutContent>[1],
        );
        return reply.send({ bundle_id: bundle.id });
      } catch (err) {
        return reply.status(500).send({
          error: 'Internal Error',
          message: `Bundle computation failed: ${(err as Error).message}`,
        });
      }
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/loadouts/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const existing = loadoutsDAL.getLoadout(request.params.id);
      if (!existing) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Loadout not found' });
      }
      if (!resourcesDAL.canAccessResource(request.agent!.id, existing)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this loadout',
        });
      }

      const parsed = UpdateLoadoutSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parsed.error.issues,
        });
      }

      const updated = loadoutsDAL.updateLoadout(request.params.id, parsed.data);
      if (!updated) {
        return reply.status(500).send({ error: 'Internal Error', message: 'Update failed' });
      }

      broadcastToChannel(`resource:loadout:${updated.id}`, {
        type: 'loadout:updated',
        data: { loadout_id: updated.id, name: updated.name },
      });

      void onLoadoutBundle(updated);

      if (updated.visibility !== 'private') {
        onResourceUpdated(
          updated.id,
          {
            name: parsed.data.name,
            description: parsed.data.description,
            visibility: parsed.data.visibility,
            metadata: (updated.metadata as Record<string, unknown> | null) ?? undefined,
          },
          request.agent!,
        );
      }

      return reply.send({ loadout: updated });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/loadouts/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const existing = loadoutsDAL.getLoadout(request.params.id);
      if (!existing) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Loadout not found' });
      }
      if (existing.owner_agent_id !== request.agent!.id) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only the owner can delete this loadout',
        });
      }

      // Emit before delete so the hook reads the row's pre-delete visibility.
      if (existing.visibility !== 'private') {
        onResourceUnpublished(request.params.id, request.agent!);
      }

      void onLoadoutRemoved(existing);

      const deleted = loadoutsDAL.deleteLoadout(request.params.id);
      if (!deleted) {
        return reply.status(500).send({ error: 'Internal Error', message: 'Delete failed' });
      }

      broadcastToChannel(`resource:loadout:${request.params.id}`, {
        type: 'loadout:deleted',
        data: { loadout_id: request.params.id },
      });

      return reply.status(204).send();
    },
  );

  // Materialize a standalone loadout — UI preview surface.
  fastify.post<{ Params: { id: string } }>(
    '/loadouts/:id/materialize',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const loadout = loadoutsDAL.getLoadout(request.params.id);
      if (!loadout) {
        return reply.status(404).send({ error: 'Not Found', message: 'Loadout not found' });
      }

      if (loadout.visibility === 'private') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, loadout)) {
          return reply.status(404).send({ error: 'Not Found', message: 'Loadout not found' });
        }
      } else if (loadout.visibility === 'shared') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, loadout)) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You do not have access to this loadout',
          });
        }
      }

      try {
        const materialized = await materializeLoadoutById(
          request.params.id,
          request.agent?.id,
        );
        return reply.send({ materialized });
      } catch (err) {
        if (err instanceof LoadoutNotFoundError) {
          return reply.status(404).send({ error: 'Not Found', message: err.message });
        }
        throw err;
      }
    },
  );
}
