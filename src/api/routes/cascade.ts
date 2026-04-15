/**
 * Cascade API Routes
 *
 * Read-only REST API over the hub's cascade projections. Runtimes own the
 * authoritative state; these endpoints surface lightweight indexes for the
 * UI, dashboards, and cross-swarm queries.
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import {
  getStreamByRowId,
  getStreamStats,
  listStreams,
  listChangesForStream,
  listConflictsForStream,
  listOpenConflicts,
  getCommitRangeForTask,
} from '../../db/dal/cascade-streams.js';

type ListStreamsQuery = {
  source_swarm_id?: string;
  source_agent_id?: string;
  status?: string;
  task_resource_id?: string;
  task_node_id?: string;
  limit?: string;
  offset?: string;
};

type ListChangesQuery = {
  limit?: string;
  offset?: string;
};

type ListConflictsQuery = {
  status?: string;
  source_swarm_id?: string;
  limit?: string;
  offset?: string;
};

function parseLimit(raw: string | undefined, fallback: number, max = 500): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function parseOffset(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export async function cascadeRoutes(fastify: FastifyInstance): Promise<void> {
  // ── List streams ───────────────────────────────────────────────────────
  fastify.get<{ Querystring: ListStreamsQuery }>(
    '/cascade/streams',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const q = request.query;
      const { streams, total } = listStreams({
        source_swarm_id: q.source_swarm_id,
        source_agent_id: q.source_agent_id,
        status: q.status,
        task_resource_id: q.task_resource_id,
        task_node_id: q.task_node_id,
        limit: parseLimit(q.limit, 50),
        offset: parseOffset(q.offset),
      });
      return reply.send({ data: streams, total });
    }
  );

  // ── Get stream by row id ───────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/cascade/streams/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Cascade stream not found' });
      }
      const stats = getStreamStats(stream.id);
      return reply.send({ ...stream, stats });
    }
  );

  // ── List changes for a stream ─────────────────────────────────────────
  fastify.get<{ Params: { id: string }; Querystring: ListChangesQuery }>(
    '/cascade/streams/:id/changes',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Cascade stream not found' });
      }
      const changes = listChangesForStream(stream.id, {
        limit: parseLimit(request.query.limit, 100),
        offset: parseOffset(request.query.offset),
      });
      return reply.send({ data: changes });
    }
  );

  // ── List conflicts for a stream ───────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/cascade/streams/:id/conflicts',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Cascade stream not found' });
      }
      const conflicts = listConflictsForStream(stream.id);
      return reply.send({ data: conflicts });
    }
  );

  // ── Commit range for a task ───────────────────────────────────────────
  //
  //   GET /cascade/tasks/:resourceId/:nodeId/commits
  //
  //   Returns the commit range bound to (resource_id, node_id) — the core
  //   primitive for the Phase 3 changelog artifact. Joins cascade_streams
  //   with cascade_changes via the task_ref stored on each.
  fastify.get<{ Params: { resourceId: string; nodeId: string } }>(
    '/cascade/tasks/:resourceId/:nodeId/commits',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const ranges = getCommitRangeForTask(
        request.params.resourceId,
        request.params.nodeId
      );
      return reply.send({ data: ranges });
    }
  );

  // ── Open conflicts triage ─────────────────────────────────────────────
  fastify.get<{ Querystring: ListConflictsQuery }>(
    '/cascade/conflicts',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const q = request.query;
      const conflicts = listOpenConflicts({
        status: q.status ?? 'pending',
        source_swarm_id: q.source_swarm_id,
        limit: parseLimit(q.limit, 100),
        offset: parseOffset(q.offset),
      });
      return reply.send({ data: conflicts });
    }
  );
}
