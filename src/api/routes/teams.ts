/**
 * Team Templates API Routes
 *
 * REST CRUD over the `team_template` syncable resource type. Stores authored
 * openteams team manifests with sidecar files (roles, loadouts, prompts).
 *
 * Resolution + per-role materialization happen in src/openteams/resolver.ts
 * (added in Slice 2). These routes are pure storage.
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { broadcastToChannel } from '../../realtime/index.js';
import {
  CreateTeamTemplateSchema,
  UpdateTeamTemplateSchema,
} from '../schemas/teams.js';
import {
  materializeRoleLoadout,
  RoleNotFoundError,
  TemplateNotFoundError,
} from '../../openteams/resolver.js';
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
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: parsed.data.name,
        description: parsed.data.description,
        content: parsed.data.content,
        ownerAgentId: request.agent!.id,
        visibility: parsed.data.visibility,
        metadata: parsed.data.metadata,
      });

      broadcastToChannel(`resource:team_template:${tmpl.id}`, {
        type: 'team_template:created',
        data: { team_template_id: tmpl.id, name: tmpl.name },
      });

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

  // Get team template by id.
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

      return reply.send({ team_template: updated });
    },
  );

  // Materialize a role's loadout — UI preview surface.
  // POST so we can extend with body params (token-budget overrides, format)
  // without breaking GET-cache assumptions.
  fastify.post<{ Params: { id: string; role: string } }>(
    '/teams/:id/roles/:role/loadout/materialize',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const tmpl = teamTemplatesDAL.getTeamTemplate(request.params.id);
      if (!tmpl) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Team template not found' });
      }

      // Visibility / access checks mirror GET /teams/:id.
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

      try {
        const materialized = await materializeRoleLoadout(
          request.params.id,
          request.params.role,
          request.agent?.id,
        );
        return reply.send({ materialized });
      } catch (err) {
        if (err instanceof TemplateNotFoundError) {
          return reply.status(404).send({ error: 'Not Found', message: err.message });
        }
        if (err instanceof RoleNotFoundError) {
          return reply.status(404).send({ error: 'Not Found', message: err.message });
        }
        throw err;
      }
    },
  );

  // Delete team template.
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
