/**
 * Team Templates API Routes
 *
 * REST CRUD over `team_template` syncable resources. Authored openteams
 * team manifests + sidecar files (roles, loadouts, prompts) live in
 * `metadata.content` and round-trip through a single JSON column.
 *
 * Layer 0 of the openteams MAP integration — pure storage. Layer 1 wires
 * `onResourcePublished/Updated/Unpublished` from these handlers so peers
 * federate the rows; Layer 2 bundles the content to MAP for cross-runtime
 * fetch-by-hash.
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { broadcastToChannel } from '../../realtime/index.js';
import {
  onResourcePublished,
  onResourceUpdated,
  onResourceUnpublished,
} from '../../sync/resource-hooks.js';
import {
  onTeamTemplateBundle,
  onTeamTemplateRemoved,
} from '../../openteams/sync-bridge.js';
import {
  CreateTeamTemplateSchema,
  UpdateTeamTemplateSchema,
} from '../schemas/teams.js';
import type { Config } from '../../config.js';

export async function teamsRoutes(
  fastify: FastifyInstance,
  _options: { config: Config },
): Promise<void> {
  // List team templates the caller can access.
  fastify.get<{
    Querystring: {
      owned?: string;
      visibility?: 'private' | 'shared' | 'public';
      limit?: number;
      offset?: number;
    };
  }>('/teams', { preHandler: authMiddleware }, async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(request.query.offset) || 0, 0);

    const result = teamTemplatesDAL.listTeamTemplates({
      agentId: request.agent!.id,
      owned: request.query.owned === 'true',
      visibility: request.query.visibility,
      limit,
      offset,
    });

    return reply.send({ data: result.data, total: result.total, limit, offset });
  });

  // Create a new team template.
  fastify.post('/teams', { preHandler: authMiddleware }, async (request, reply) => {
    const parsed = CreateTeamTemplateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parsed.error.issues,
      });
    }

    try {
      // Layer 6: git_remote_url presence flips the row to `ls-remote`
      // strategy + lazy-clone on first read. Content remains optional but
      // we still validate the inline blob when supplied so partial-content
      // hash-stickiness keeps working until the first pull lands.
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: parsed.data.name,
        description: parsed.data.description,
        content: parsed.data.content,
        ownerAgentId: request.agent!.id,
        visibility: parsed.data.visibility,
        metadata: parsed.data.metadata,
        gitRemoteUrl: parsed.data.git_remote_url,
      });

      broadcastToChannel(`resource:team_template:${tmpl.id}`, {
        type: 'team_template:created',
        data: { team_template_id: tmpl.id, name: tmpl.name },
      });

      // Bundle to the MAP store (Layer 2 auto-bundle on write). Fire-and-
      // forget — the kind handler emits `resource.added`/`updated` events
      // on the SDK bus from within `bundleStore.put`.
      void onTeamTemplateBundle(tmpl);

      // Fan-out to peer hubs over the JSON-RPC sync mesh. Private rows stay
      // local — federation is opt-in via visibility, matching how the
      // generic /resources route gates its hooks.
      if (tmpl.visibility !== 'private') {
        onResourcePublished(
          {
            id: tmpl.id,
            resource_type: 'team_template',
            name: tmpl.name,
            description: tmpl.description ?? null,
            git_remote_url: tmpl.git_remote_url,
            visibility: tmpl.visibility,
          },
          [],
          (tmpl.metadata as Record<string, unknown> | null) ?? null,
          request.agent!,
        );
      }

      return reply.status(201).send({ team_template: tmpl });
    } catch (error) {
      if ((error as Error).message?.includes('UNIQUE constraint failed')) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'A team template with this name already exists for your account',
        });
      }
      throw error;
    }
  });

  // Get team template by id. Visibility-gated.
  fastify.get<{ Params: { id: string } }>(
    '/teams/:id',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const tmpl = teamTemplatesDAL.getTeamTemplate(request.params.id);
      if (!tmpl) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Team template not found' });
      }

      // Private rows are invisible to non-owners (return 404, not 403, to
      // avoid leaking existence). Shared rows require ACL check. Public
      // rows are open.
      if (tmpl.visibility === 'private') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, tmpl)) {
          return reply
            .status(404)
            .send({ error: 'Not Found', message: 'Team template not found' });
        }
      } else if (tmpl.visibility === 'shared') {
        if (!request.agent || !resourcesDAL.canAccessResource(request.agent.id, tmpl)) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You do not have access to this team template',
          });
        }
      }

      return reply.send({ team_template: tmpl });
    },
  );

  // Update team template.
  fastify.patch<{ Params: { id: string } }>(
    '/teams/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const existing = teamTemplatesDAL.getTeamTemplate(request.params.id);
      if (!existing) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Team template not found' });
      }
      if (!resourcesDAL.canAccessResource(request.agent!.id, existing)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this team template',
        });
      }

      const parsed = UpdateTeamTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parsed.error.issues,
        });
      }

      const updated = teamTemplatesDAL.updateTeamTemplate(request.params.id, parsed.data);
      if (!updated) {
        return reply.status(500).send({ error: 'Internal Error', message: 'Update failed' });
      }

      broadcastToChannel(`resource:team_template:${updated.id}`, {
        type: 'team_template:updated',
        data: { team_template_id: updated.id, name: updated.name },
      });

      // Re-bundle to keep the MAP store in sync with authored content.
      void onTeamTemplateBundle(updated);

      // Mesh fan-out. We only emit when the effective visibility (post-update)
      // is non-private; flipping a federated row back to private is a future
      // "redacted" event handled in a later slice (see plan §"Out of scope").
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

      return reply.send({ team_template: updated });
    },
  );

  // Delete team template. Owner-only.
  fastify.delete<{ Params: { id: string } }>(
    '/teams/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const existing = teamTemplatesDAL.getTeamTemplate(request.params.id);
      if (!existing) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Team template not found' });
      }
      if (existing.owner_agent_id !== request.agent!.id) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only the owner can delete this team template',
        });
      }

      // Emit the unpublish event before deletion so the hook can read the
      // row's pre-delete visibility (matches resources.ts:386 ordering).
      if (existing.visibility !== 'private') {
        onResourceUnpublished(request.params.id, request.agent!);
      }

      // Remove the corresponding bundle from the MAP store.
      void onTeamTemplateRemoved(existing);

      const deleted = teamTemplatesDAL.deleteTeamTemplate(request.params.id);
      if (!deleted) {
        return reply.status(500).send({ error: 'Internal Error', message: 'Delete failed' });
      }

      broadcastToChannel(`resource:team_template:${request.params.id}`, {
        type: 'team_template:deleted',
        data: { team_template_id: request.params.id },
      });

      return reply.status(204).send();
    },
  );
}
