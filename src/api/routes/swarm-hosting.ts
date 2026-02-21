/**
 * Swarm Hosting API Routes
 *
 * REST API for spawning, managing, and monitoring OpenSwarm instances
 * hosted by this OpenHive instance.
 *
 * Routes:
 *   POST   /map/hosted/spawn         - Spawn a new hosted swarm
 *   GET    /map/hosted               - List hosted swarms
 *   GET    /map/hosted/:id           - Get hosted swarm details
 *   POST   /map/hosted/:id/stop      - Stop a hosted swarm
 *   POST   /map/hosted/:id/restart   - Restart a hosted swarm
 *   DELETE /map/hosted/:id           - Remove a stopped/failed hosted swarm
 *   GET    /map/hosted/:id/logs      - Get logs from a hosted swarm
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { SwarmHostingError } from '../../swarm/manager.js';
import * as dal from '../../swarm/dal.js';
import type { SwarmManager } from '../../swarm/manager.js';
import type { Config } from '../../config.js';

// ============================================================================
// Zod Schemas
// ============================================================================

const SpawnSwarmSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  adapter: z.string().max(100).optional(),
  adapter_config: z.record(z.unknown()).optional(),
  hive: z.string().max(100).optional(),
  provider: z.enum(['local', 'docker', 'fly', 'ssh', 'k8s']).optional(),
  metadata: z.record(z.unknown()).optional(),
  credential_overrides: z.record(z.string(), z.string()).optional(),
});

// ============================================================================
// Error Handler
// ============================================================================

function handleSwarmError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof SwarmHostingError) {
    const statusMap: Record<string, number> = {
      MAX_SWARMS_REACHED: 429,
      PROVIDER_NOT_AVAILABLE: 400,
      NO_PORTS_AVAILABLE: 503,
      HIVE_NOT_FOUND: 404,
      PREAUTH_KEY_FAILED: 500,
      SPAWN_FAILED: 500,
      NOT_FOUND: 404,
      NOT_OWNER: 403,
      RESTART_NOT_SUPPORTED: 400,
      RESTART_FAILED: 500,
    };
    return reply.status(statusMap[error.code] || 500).send({
      error: error.code,
      message: error.message,
    });
  }
  if (error instanceof z.ZodError) {
    return reply.status(422).send({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request body',
      details: error.errors,
    });
  }
  throw error;
}

// ============================================================================
// Route Registration
// ============================================================================

export async function swarmHostingRoutes(
  fastify: FastifyInstance,
  _opts: { config: Config }
): Promise<void> {
  // Helper to get the SwarmManager from the fastify instance
  function getManager(request: FastifyRequest): SwarmManager {
    const manager = (request.server as unknown as { swarmManager?: SwarmManager }).swarmManager;
    if (!manager) {
      throw new SwarmHostingError(
        'PROVIDER_NOT_AVAILABLE',
        'Swarm hosting is not enabled. Set swarmHosting.enabled = true in config.'
      );
    }
    return manager;
  }

  // POST /map/hosted/spawn — Spawn a new hosted swarm
  fastify.post('/map/hosted/spawn', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const manager = getManager(request);
      const body = SpawnSwarmSchema.parse(request.body);
      const hosted = await manager.spawn(request.agent!.id, body);

      return reply.status(201).send({
        id: hosted.id,
        swarm_id: hosted.swarm_id,
        provider: hosted.provider,
        state: hosted.state,
        endpoint: hosted.endpoint,
        assigned_port: hosted.assigned_port,
        created_at: hosted.created_at,
      });
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // GET /map/hosted — List hosted swarms
  fastify.get('/map/hosted', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{
    Querystring: {
      state?: string;
      provider?: string;
      mine?: string;
      limit?: string;
      offset?: string;
    };
  }>, reply: FastifyReply) => {
    const { state, provider, mine, limit, offset } = request.query;

    const result = dal.listHostedSwarms({
      state: state as never,
      provider: provider as never,
      spawned_by: mine === 'true' ? request.agent!.id : undefined,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    // Strip sensitive fields from config
    const data = result.data.map((h) => ({
      id: h.id,
      swarm_id: h.swarm_id,
      provider: h.provider,
      state: h.state,
      pid: h.pid,
      assigned_port: h.assigned_port,
      endpoint: h.endpoint,
      error: h.error,
      spawned_by: h.spawned_by,
      created_at: h.created_at,
      updated_at: h.updated_at,
    }));

    return reply.send({ data, total: result.total });
  });

  // GET /map/hosted/:id — Get hosted swarm details
  fastify.get('/map/hosted/:id', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const hosted = dal.findHostedSwarmById(request.params.id);
    if (!hosted) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Hosted swarm not found' });
    }

    return reply.send({
      id: hosted.id,
      swarm_id: hosted.swarm_id,
      provider: hosted.provider,
      state: hosted.state,
      pid: hosted.pid,
      container_id: hosted.container_id,
      assigned_port: hosted.assigned_port,
      endpoint: hosted.endpoint,
      error: hosted.error,
      spawned_by: hosted.spawned_by,
      created_at: hosted.created_at,
      updated_at: hosted.updated_at,
    });
  });

  // POST /map/hosted/:id/stop — Stop a hosted swarm
  fastify.post('/map/hosted/:id/stop', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const manager = getManager(request);
      const hosted = await manager.stop(request.params.id, request.agent!.id);

      return reply.send({
        id: hosted.id,
        state: hosted.state,
        message: 'Swarm stopped successfully',
      });
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // POST /map/hosted/:id/restart — Restart a hosted swarm
  fastify.post('/map/hosted/:id/restart', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const manager = getManager(request);
      const hosted = await manager.restart(request.params.id, request.agent!.id);

      return reply.send({
        id: hosted.id,
        state: hosted.state,
        endpoint: hosted.endpoint,
        message: 'Swarm restarted successfully',
      });
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // DELETE /map/hosted/:id — Remove a stopped/failed hosted swarm record
  fastify.delete('/map/hosted/:id', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const hosted = dal.findHostedSwarmById(request.params.id);
    if (!hosted) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Hosted swarm not found' });
    }
    if (hosted.spawned_by !== request.agent!.id) {
      return reply.status(403).send({ error: 'NOT_OWNER', message: 'You did not spawn this swarm' });
    }
    if (hosted.state !== 'stopped' && hosted.state !== 'failed') {
      return reply.status(409).send({
        error: 'INVALID_STATE',
        message: `Cannot remove a swarm in "${hosted.state}" state. Stop it first.`,
      });
    }

    dal.deleteHostedSwarm(hosted.id);
    return reply.status(204).send();
  });

  // GET /map/hosted/:id/logs — Get logs from a hosted swarm
  fastify.get('/map/hosted/:id/logs', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Querystring: { lines?: string };
  }>, reply: FastifyReply) => {
    try {
      const manager = getManager(request);
      const lines = request.query.lines ? parseInt(request.query.lines, 10) : undefined;
      const logs = await manager.getLogs(request.params.id, request.agent!.id, { lines });

      return reply.type('text/plain').send(logs);
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });
}
