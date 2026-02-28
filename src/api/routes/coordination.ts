/**
 * Coordination API Routes
 *
 * REST API for inter-swarm coordination: task delegation, context sharing,
 * and direct messaging between swarms.
 *
 * Routes:
 *   POST   /coordination/tasks              - Assign a task
 *   GET    /coordination/tasks              - List tasks
 *   GET    /coordination/tasks/:id          - Get task by ID
 *   PATCH  /coordination/tasks/:id          - Update task status
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
import { getCoordinationService } from '../../coordination/index.js';
import type { Config } from '../../config.js';

// ============================================================================
// Zod Schemas
// ============================================================================

const CreateTaskSchema = z.object({
  hive_id: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  assigned_to_swarm_id: z.string().min(1),
  assigned_by_swarm_id: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  deadline: z.string().optional(),
});

const UpdateTaskSchema = z.object({
  status: z.enum(['accepted', 'in_progress', 'completed', 'failed', 'rejected']).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  result: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});

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
  // Task Routes
  // ==========================================================================

  // POST /coordination/tasks -- Assign a task
  fastify.post('/coordination/tasks', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = CreateTaskSchema.parse(request.body);
      const service = getCoordinationService();
      const task = service.assignTask(body.hive_id, {
        title: body.title,
        description: body.description,
        priority: body.priority,
        assigned_by_agent_id: request.agent!.id,
        assigned_by_swarm_id: body.assigned_by_swarm_id,
        assigned_to_swarm_id: body.assigned_to_swarm_id,
        context: body.context,
        deadline: body.deadline,
      }, request.agent!);
      return reply.status(201).send(task);
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

  // GET /coordination/tasks -- List tasks
  fastify.get('/coordination/tasks', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{
    Querystring: { hive_id?: string; status?: string; swarm_id?: string; limit?: string; offset?: string };
  }>, reply: FastifyReply) => {
    const { hive_id, status, swarm_id, limit, offset } = request.query;
    const service = getCoordinationService();

    if (!hive_id) {
      return reply.status(400).send({ error: 'MISSING_PARAM', message: 'hive_id query parameter is required' });
    }

    const result = service.listTasks(hive_id, {
      status,
      swarm_id,
      limit: parseIntParam(limit, MAX_PAGE_SIZE),
      offset: parseIntParam(offset),
    });

    return reply.send(result);
  });

  // GET /coordination/tasks/:id -- Get task by ID
  fastify.get('/coordination/tasks/:id', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const service = getCoordinationService();
    const task = service.getTask(request.params.id);
    if (!task) {
      return reply.status(404).send({ error: 'Not Found', message: 'Task not found' });
    }
    return reply.send(task);
  });

  // PATCH /coordination/tasks/:id -- Update task status
  fastify.patch('/coordination/tasks/:id', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const body = UpdateTaskSchema.parse(request.body);
      const service = getCoordinationService();
      const task = service.updateTaskStatus(request.params.id, body, request.agent!);
      if (!task) {
        return reply.status(404).send({ error: 'Not Found', message: 'Task not found' });
      }
      return reply.send(task);
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

  // ==========================================================================
  // Context Routes
  // ==========================================================================

  // POST /coordination/contexts -- Share context
  fastify.post('/coordination/contexts', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = CreateContextSchema.parse(request.body);
      const service = getCoordinationService();
      const ctx = service.shareContext(body.hive_id, {
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
  fastify.get('/coordination/contexts', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{
    Querystring: { hive_id?: string; type?: string; swarm_id?: string; limit?: string; offset?: string };
  }>, reply: FastifyReply) => {
    const { hive_id, type, swarm_id, limit, offset } = request.query;
    const service = getCoordinationService();

    if (!hive_id) {
      return reply.status(400).send({ error: 'MISSING_PARAM', message: 'hive_id query parameter is required' });
    }

    const result = service.listContexts(hive_id, {
      type,
      swarm_id,
      limit: parseIntParam(limit, MAX_PAGE_SIZE),
      offset: parseIntParam(offset),
    });

    return reply.send(result);
  });

  // GET /coordination/contexts/:id -- Get context by ID
  fastify.get('/coordination/contexts/:id', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const service = getCoordinationService();
    const ctx = service.getContext(request.params.id);
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
      const service = getCoordinationService();
      const msg = service.sendMessage({
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
  fastify.get('/coordination/messages', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{
    Querystring: { swarm_id?: string; hive_id?: string; since?: string; limit?: string; offset?: string };
  }>, reply: FastifyReply) => {
    const { swarm_id, hive_id, since, limit, offset } = request.query;
    const service = getCoordinationService();

    if (!swarm_id) {
      return reply.status(400).send({ error: 'MISSING_PARAM', message: 'swarm_id query parameter is required' });
    }

    const result = service.getMessages(swarm_id, {
      hive_id,
      since,
      limit: parseIntParam(limit, MAX_PAGE_SIZE),
      offset: parseIntParam(offset),
    });

    return reply.send(result);
  });

  // PATCH /coordination/messages/:id/read -- Mark message read
  fastify.patch('/coordination/messages/:id/read', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const service = getCoordinationService();
    service.markRead(request.params.id);
    return reply.send({ status: 'ok' });
  });
}
