/**
 * MAP Tasks API Routes
 *
 * REST API for querying task state from OpenTasks graphs via the daemon.
 * When resource_id is provided, connects to the daemon for that resource.
 * Without resource_id, returns empty (frontend Tasks page uses resource-content endpoints).
 *
 * Routes:
 *   GET /map/tasks          - List tasks (optional resource_id)
 *   GET /map/tasks/summary  - Aggregate stats (optional resource_id)
 *   GET /map/tasks/:id      - Get a single task (requires resource_id)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { daemonListTasks, resolveDaemonSocket, TaskDaemonError } from '../../map/task-daemon-client.js';
import type { Config } from '../../config.js';

function resolveLocalPath(resource: { local_path: string | null; git_remote_url: string }): string | null {
  if (resource.local_path) return resource.local_path;
  const url = resource.git_remote_url;
  if (url.startsWith('http') || url.startsWith('git://') || url.startsWith('ssh://')) return null;
  return url;
}

export async function mapTasksRoutes(
  fastify: FastifyInstance,
  _opts: { config: Config },
): Promise<void> {

  // GET /map/tasks -- List tasks from an OpenTasks graph
  fastify.get<{
    Querystring: {
      resource_id?: string;
      status?: string;
      assignee?: string;
      limit?: string;
    };
  }>('/map/tasks', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { resource_id, status, assignee, limit } = request.query;

    if (!resource_id) {
      return reply.send({ tasks: [], hasMore: false });
    }

    const resource = resourcesDAL.findResourceById(resource_id);
    if (!resource) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: `Resource ${resource_id} not found` });
    }

    const localPath = resolveLocalPath(resource);
    if (!localPath) {
      return reply.send({ tasks: [], hasMore: false });
    }

    try {
      const socketPath = resolveDaemonSocket(localPath);
      const statusFilter = status ? status.split(',') : undefined;
      const result = await daemonListTasks(
        socketPath,
        { assignee, status: statusFilter },
        limit ? parseInt(limit, 10) : undefined,
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof TaskDaemonError && err.code === 'DAEMON_NOT_RUNNING') {
        return reply.send({ tasks: [], hasMore: false, daemon_connected: false });
      }
      throw err;
    }
  });

  // GET /map/tasks/summary -- Aggregate task stats
  fastify.get<{
    Querystring: { resource_id?: string };
  }>('/map/tasks/summary', {
    preHandler: [authMiddleware],
  }, async (_request: FastifyRequest<{ Querystring: { resource_id?: string } }>, reply: FastifyReply) => {
    // Without resource_id, return empty
    return reply.send({ total: 0, byStatus: {}, bySwarm: {} });
  });

  // GET /map/tasks/:id -- Get a single task
  fastify.get<{ Params: { id: string }; Querystring: { resource_id?: string } }>('/map/tasks/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    return reply.status(404).send({
      error: 'NOT_FOUND',
      message: `Task ${request.params.id} not found — provide resource_id to search a specific graph`,
    });
  });
}
