/**
 * MAP Tasks API Routes
 *
 * REST API for querying MAP task state from connected agents.
 * These tasks are ephemeral (in-memory) — sourced from MAP-connected agents'
 * task graphs, not from the coordination DAL.
 *
 * Routes:
 *   GET /map/tasks          - List all MAP tasks (filter by status, assignee, swarm)
 *   GET /map/tasks/summary  - Aggregate stats (counts by status, by swarm)
 *   GET /map/tasks/:id      - Get a single task
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { getMapTaskStore } from '../../map/task-store.js';
import type { MAPTaskStatus } from '../../map/task-types.js';
import type { Config } from '../../config.js';

export async function mapTasksRoutes(
  fastify: FastifyInstance,
  _opts: { config: Config },
): Promise<void> {

  // GET /map/tasks -- List MAP tasks with optional filters
  fastify.get<{
    Querystring: {
      status?: string;
      assignee?: string;
      swarm_id?: string;
      limit?: string;
      cursor?: string;
    };
  }>('/map/tasks', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { status, assignee, swarm_id, limit, cursor } = request.query;
    const store = getMapTaskStore();

    const filter: { assignee?: string; status?: MAPTaskStatus | MAPTaskStatus[] } = {};
    if (assignee) filter.assignee = assignee;
    if (status) {
      const statuses = status.split(',') as MAPTaskStatus[];
      filter.status = statuses.length === 1 ? statuses[0] : statuses;
    }

    let result = store.list({
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor: cursor || undefined,
    });

    // Additional swarm_id filter (not in the MAP SDK's filter interface, but useful for the frontend)
    if (swarm_id) {
      result = {
        ...result,
        tasks: result.tasks.filter((t) => store.getOwner(t.id) === swarm_id),
      };
    }

    return reply.send(result);
  });

  // GET /map/tasks/summary -- Aggregate task stats
  fastify.get('/map/tasks/summary', {
    preHandler: [authMiddleware],
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const store = getMapTaskStore();
    const stats = store.getStats();
    return reply.send(stats);
  });

  // GET /map/tasks/:id -- Get a single MAP task
  fastify.get<{ Params: { id: string } }>('/map/tasks/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const store = getMapTaskStore();
    const task = store.get(request.params.id);

    if (!task) {
      return reply.status(404).send({
        error: 'NOT_FOUND',
        message: `MAP task ${request.params.id} not found`,
      });
    }

    return reply.send({
      task,
      swarm_id: store.getOwner(task.id),
    });
  });
}
