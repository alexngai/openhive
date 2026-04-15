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
  listCascadeOperations,
  listPushes,
  listQueueEntries,
  getCommitRangeForTask,
} from '../../db/dal/cascade-streams.js';
import { generateChangelog, renderMarkdown } from '../../cascade/changelog.js';

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

  // ── Changelog for a task ──────────────────────────────────────────────
  //
  //   GET /cascade/tasks/:resourceId/:nodeId/changelog
  //     ?title=&subtitle=&format=json|markdown|both (default 'both')
  //     &commitsLimit=&commitsOffset=
  //
  //   Phase 3 primary artifact: close a task, get a "what shipped" summary.
  //   Returns structured cascade data + rendered markdown. Use `format=json`
  //   when embedding in a UI that renders its own layout; `format=markdown`
  //   for copy-paste into PR descriptions; `both` (default) for dashboards.
  fastify.get<{
    Params: { resourceId: string; nodeId: string };
    Querystring: {
      title?: string;
      subtitle?: string;
      format?: 'json' | 'markdown' | 'both';
      commitsLimit?: string;
      commitsOffset?: string;
    };
  }>(
    '/cascade/tasks/:resourceId/:nodeId/changelog',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const format = request.query.format ?? 'both';
      if (format !== 'json' && format !== 'markdown' && format !== 'both') {
        return reply
          .status(400)
          .send({ error: 'Bad Request', message: "format must be 'json' | 'markdown' | 'both'" });
      }
      const changelog = generateChangelog(
        request.params.resourceId,
        request.params.nodeId,
        {
          commitsLimit: parseLimit(request.query.commitsLimit, 500, 5000),
          commitsOffset: parseOffset(request.query.commitsOffset),
        }
      );

      // markdown format returns raw text for easy Copy As
      if (format === 'markdown') {
        const md = renderMarkdown(changelog, {
          title: request.query.title,
          subtitle: request.query.subtitle,
        });
        return reply.type('text/markdown').send(md);
      }

      const body: Record<string, unknown> = { data: changelog };
      if (format === 'both') {
        body.markdown = renderMarkdown(changelog, {
          title: request.query.title,
          subtitle: request.query.subtitle,
        });
      }
      return reply.send(body);
    }
  );

  // ── Commit range for a task ───────────────────────────────────────────
  //
  //   GET /cascade/tasks/:resourceId/:nodeId/commits?limit=N&offset=N
  //
  //   Returns the commit range bound to (resource_id, node_id) — the core
  //   primitive for the Phase 3 changelog artifact. Joins cascade_streams
  //   with cascade_changes via the task_ref stored on each.
  //
  //   Pagination caps each stream's commit list (default 500, max 5000) to
  //   keep responses bounded for long-running tasks.
  fastify.get<{
    Params: { resourceId: string; nodeId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    '/cascade/tasks/:resourceId/:nodeId/commits',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const ranges = getCommitRangeForTask(
        request.params.resourceId,
        request.params.nodeId,
        {
          commitsLimit: parseLimit(request.query.limit, 500, 5000),
          commitsOffset: parseOffset(request.query.offset),
        }
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

  // ── Trunk push audit log (stream.pushed events) ───────────────────────
  fastify.get<{
    Querystring: {
      source_swarm_id?: string;
      stream_row_id?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    '/cascade/pushes',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const q = request.query;
      const pushes = listPushes({
        source_swarm_id: q.source_swarm_id,
        stream_row_id: q.stream_row_id,
        limit: parseLimit(q.limit, 50, 500),
        offset: parseOffset(q.offset),
      });
      return reply.send({ data: pushes });
    }
  );

  // ── Merge queue entries (queue.* events projection) ───────────────────
  fastify.get<{
    Querystring: {
      source_swarm_id?: string;
      status?: string;
      target_branch?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    '/cascade/queue',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const q = request.query;
      const entries = listQueueEntries({
        source_swarm_id: q.source_swarm_id,
        status: q.status,
        target_branch: q.target_branch,
        limit: parseLimit(q.limit, 100, 500),
        offset: parseOffset(q.offset),
      });
      return reply.send({ data: entries });
    }
  );

  // ── Cascade operations audit log ──────────────────────────────────────
  //
  //   GET /cascade/operations?source_swarm_id=&root_stream_row_id=&limit=&offset=
  //
  //   Historical view of cascade.completed walks. One row per cascadeRebase
  //   invocation. Use to answer "did this cascade succeed", "what's recent
  //   activity on swarm X", etc.
  fastify.get<{
    Querystring: {
      source_swarm_id?: string;
      root_stream_row_id?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    '/cascade/operations',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const q = request.query;
      const ops = listCascadeOperations({
        source_swarm_id: q.source_swarm_id,
        root_stream_row_id: q.root_stream_row_id,
        limit: parseLimit(q.limit, 50, 500),
        offset: parseOffset(q.offset),
      });
      return reply.send({ data: ops });
    }
  );
}
