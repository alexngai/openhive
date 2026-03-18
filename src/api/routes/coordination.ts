/**
 * Coordination API Routes
 *
 * REST API for inter-swarm coordination: context sharing and direct messaging.
 * Task endpoints have been removed — use OpenTasks mutation endpoints instead:
 *   POST /resources/:id/content/opentasks/tasks
 *   PATCH /resources/:id/content/opentasks/tasks/:nodeId
 *
 * Routes:
 *   POST   /coordination/contexts           - Share context
 *   GET    /coordination/contexts           - List contexts
 *   GET    /coordination/contexts/:id       - Get context by ID
 *   POST   /coordination/messages           - Send message
 *   GET    /coordination/messages           - Get messages
 *   PATCH  /coordination/messages/:id/read  - Mark message read
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getMessagingService } from '../../messaging/index.js';
import { getContextsService } from '../../contexts/index.js';
import type { Config } from '../../config.js';

// ============================================================================
// Zod Schemas
// ============================================================================

const CreateContextSchema = z.object({
  hive_id: z.string().min(1),
  source_swarm_id: z.string().min(1),
  context_type: z.string().min(1).max(100),
  data: z.record(z.unknown()),
  target_swarm_ids: z.array(z.string()).optional(),
  ttl_seconds: z.number().int().min(1).optional(),
});

const CreateMessageSchema = z.object({
  to_swarm_id: z.string().min(1),
  from_swarm_id: z.string().min(1),
  hive_id: z.string().optional(),
  content_type: z.enum(['text', 'json', 'binary_ref']).optional(),
  content: z.string().min(1),
  reply_to: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ============================================================================
// Helpers
// ============================================================================

const MAX_PAGE_SIZE = 200;

function parseIntParam(value: string | undefined, max?: number): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return max ? Math.min(n, max) : n;
}

// ============================================================================
// Route Registration
// ============================================================================

export async function coordinationRoutes(
  fastify: FastifyInstance,
  _opts: { config: Config },
): Promise<void> {

  // ==========================================================================
  // Context Routes
  // ==========================================================================

  // POST /coordination/contexts -- Share context
  fastify.post('/coordination/contexts', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = CreateContextSchema.parse(request.body);
      const ctx = getContextsService().shareContext(body.hive_id, {
        source_swarm_id: body.source_swarm_id,
        context_type: body.context_type,
        data: body.data,
        target_swarm_ids: body.target_swarm_ids,
        ttl_seconds: body.ttl_seconds,
      });
      return reply.status(201).send(ctx);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(422).send({
          error: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: error.errors,
        });
      }
      throw error;
    }
  });

  // GET /coordination/contexts -- List contexts
  fastify.get<{
    Querystring: { hive_id?: string; type?: string; swarm_id?: string; limit?: string; offset?: string };
  }>('/coordination/contexts', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { hive_id, type, swarm_id, limit, offset } = request.query;

    if (!hive_id) {
      return reply.status(400).send({ error: 'MISSING_PARAM', message: 'hive_id query parameter is required' });
    }

    const result = getContextsService().listContexts(hive_id, {
      type,
      swarm_id,
      limit: parseIntParam(limit, MAX_PAGE_SIZE),
      offset: parseIntParam(offset),
    });

    return reply.send(result);
  });

  // GET /coordination/contexts/:id -- Get context by ID
  fastify.get<{ Params: { id: string } }>('/coordination/contexts/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const ctx = getContextsService().getContext(request.params.id);
    if (!ctx) {
      return reply.status(404).send({ error: 'Not Found', message: 'Context not found' });
    }
    return reply.send(ctx);
  });

  // ==========================================================================
  // Message Routes
  // ==========================================================================

  // POST /coordination/messages -- Send message
  fastify.post('/coordination/messages', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = CreateMessageSchema.parse(request.body);
      const msg = getMessagingService().sendMessage({
        hive_id: body.hive_id,
        from_swarm_id: body.from_swarm_id,
        to_swarm_id: body.to_swarm_id,
        content_type: body.content_type,
        content: body.content,
        reply_to: body.reply_to,
        metadata: body.metadata,
      });
      return reply.status(201).send(msg);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(422).send({
          error: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: error.errors,
        });
      }
      throw error;
    }
  });

  // GET /coordination/messages -- Get messages
  fastify.get<{
    Querystring: { swarm_id?: string; hive_id?: string; since?: string; limit?: string; offset?: string };
  }>('/coordination/messages', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { swarm_id, hive_id, since, limit, offset } = request.query;

    if (!swarm_id) {
      return reply.status(400).send({ error: 'MISSING_PARAM', message: 'swarm_id query parameter is required' });
    }

    const result = getMessagingService().getMessages(swarm_id, {
      hive_id,
      since,
      limit: parseIntParam(limit, MAX_PAGE_SIZE),
      offset: parseIntParam(offset),
    });

    return reply.send(result);
  });

  // PATCH /coordination/messages/:id/read -- Mark message read
  fastify.patch<{ Params: { id: string } }>('/coordination/messages/:id/read', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    getMessagingService().markRead(request.params.id);
    return reply.send({ status: 'ok' });
  });
}
