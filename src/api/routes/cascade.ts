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
  getStreamDAG,
  getStreamTimeline,
  getLatestCommitForStream,
} from '../../db/dal/cascade-streams.js';
import {
  recordVerdict,
  listVerdictsForStream,
  getCurrentVerdict,
  REVIEW_VERDICT_VALUES,
  type ReviewVerdictValue,
} from '../../db/dal/cascade-review-verdicts.js';
import { mapHubEvents } from '../../map/service.js';
import { broadcastToChannel } from '../../realtime/index.js';
import {
  resolveStreamReviewGate,
  listStreamsAwaitingReview,
} from '../../cascade/review-monitor.js';
import { requestReviewDispatch } from '../../cascade/review-dispatch.js';
import { postVerdictThreadTurn } from '../../cascade/review-thread.js';
import { findResourcesByRepoUrl } from '../../db/dal/syncable-resources.js';
import { generateChangelog, renderMarkdown } from '../../cascade/changelog.js';
import { sendCascadeAction, type CascadeAction } from '../../map/cascade-actions.js';
import { hasCapability, getInbound } from '../../map/connection-registry.js';
import {
  updatePublishBranch,
  defaultPublishBranch,
  createPR,
  getPRForStream,
  updatePR,
} from '../../db/dal/cascade-streams.js';
import {
  createPullRequest,
  updatePullRequest,
  closePullRequest,
  getPullRequest,
  checkGitHubConnection,
  parseGitHubRepo,
  branchExists,
  findOpenPRByHead,
} from '../../integrations/github-api.js';
import {
  buildPRStackPlan,
  PRStackRootNotFoundError,
  type PRStackEntry,
} from '../../cascade/pr-stack-walker.js';

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

  // ── Stream DAG ───────────────────────────────────────────────────────
  //
  //   GET /cascade/streams/dag?source_swarm_id=&task_resource_id=
  //
  //   Returns the full stream parent/child DAG with merge edges for graph
  //   visualization. Each node carries commit_count + open_conflict_count
  //   for sizing/coloring. Edges come from parent_stream_id (type=parent)
  //   and cascade_merges (type=merge).
  fastify.get<{
    Querystring: { source_swarm_id?: string; task_resource_id?: string };
  }>(
    '/cascade/streams/dag',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const dag = getStreamDAG({
        source_swarm_id: request.query.source_swarm_id,
        task_resource_id: request.query.task_resource_id,
      });
      return reply.send({ data: dag });
    }
  );

  // ── Stream timeline ─────────────────────────────────────────────────
  //
  //   GET /cascade/streams/:id/timeline
  //
  //   Returns an ordered list of all events on a stream: commits, merges,
  //   conflicts (detected + resolved), pushes. Used by StreamDetailSidebar
  //   to render the vertical timeline.
  fastify.get<{ Params: { id: string } }>(
    '/cascade/streams/:id/timeline',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Cascade stream not found' });
      }
      const timeline = getStreamTimeline(stream.id);
      return reply.send({ data: timeline });
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

  // ── Task ↔ resource_id lookup ─────────────────────────────────────────
  //
  //   GET /cascade/tasks/lookup?git_remote_url=...&node_id=...
  //
  //   Resolves a task-typed syncable_resource by its git_remote_url so
  //   runtimes that only know their OpenTasks graph's URL + node_id can
  //   discover the hub's canonical resource_id. Used by macro-agent's
  //   `cascade.resolveTaskRef` implementations that want to fill
  //   `task_ref.resource_id` automatically instead of hand-wiring it per
  //   spawn.
  //
  //   Matching uses the same URL normalization as cross-instance resource
  //   sync (strip protocol, trailing `.git`, trailing slash, case). When
  //   multiple task resources share a URL (rare but possible — different
  //   owners), the first row returned is used; clients that need to
  //   disambiguate should call /resources?type=task directly.
  //
  //   Returns 404 if no task resource matches.
  fastify.get<{
    Querystring: { git_remote_url?: string; node_id?: string };
  }>(
    '/cascade/tasks/lookup',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { git_remote_url, node_id } = request.query;
      if (!git_remote_url || typeof git_remote_url !== 'string') {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'git_remote_url is required',
        });
      }
      const matches = findResourcesByRepoUrl(git_remote_url, 'task');
      if (matches.length === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `No task resource matches git_remote_url: ${git_remote_url}`,
        });
      }
      const resource = matches[0];
      return reply.send({
        data: {
          resource_id: resource.id,
          node_id: node_id ?? null,
          resource_name: resource.name,
          git_remote_url: resource.git_remote_url,
          owner_agent_id: resource.owner_agent_id,
          match_count: matches.length,
        },
      });
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

  // ── Stream actions (Level 2 — hub→runtime commands) ─────────────────
  //
  //   POST /cascade/streams/:id/actions/:action
  //     body: { target_stream_id?, reason?, conflict_id?, strategy? }
  //
  //   Sends an `x-cascade/request.<action>` JSON-RPC notification to the
  //   connected runtime that owns the stream. Fire-and-forget — the UI
  //   updates reactively when the runtime's response event arrives via WS.
  //
  //   Supported actions: merge, abandon, pause, resume, resolve
  //
  //   Returns 200 { sent: true } if the notification was dispatched,
  //   422 { sent: false, error } if the swarm is disconnected or action
  //   is unknown, or 409 { sent: false, error } if the owning swarm does
  //   not declare `cascade.canAct` (observe-only — nothing would answer).
  const VALID_ACTIONS = new Set<CascadeAction>(['merge', 'abandon', 'pause', 'resume', 'resolve', 'push', 'commit']);

  fastify.post<{
    Params: { id: string; action: string };
    Body: {
      target_stream_id?: string;
      reason?: string;
      conflict_id?: string;
      strategy?: string;
      remote?: string;
      target_ref?: string;
      message?: string;
      metadata?: Record<string, unknown>;
    };
  }>(
    '/cascade/streams/:id/actions/:action',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { id, action } = request.params;

      if (!VALID_ACTIONS.has(action as CascadeAction)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Unknown action: ${action}. Valid actions: ${Array.from(VALID_ACTIONS).join(', ')}`,
        });
      }

      const stream = getStreamByRowId(id);
      if (!stream) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Cascade stream not found',
        });
      }

      // Capability pre-check: the owning swarm must declare `cascade.canAct`
      // to receive action requests. Belt-and-suspenders behind the UI gate —
      // capabilities are advisory, but an observe-only swarm (e.g. cc-swarm,
      // which declares `canAct: false`) silently no-ops any `x-cascade/request.*`
      // we'd dispatch, so reject up front with a clear typed error instead.
      //
      // Only run this when the swarm IS connected — a disconnected swarm has
      // no capabilities to read either, and "not connected" is the more
      // fundamental failure (surfaces as 422 from sendCascadeAction below).
      // Skipping the gate when offline preserves the existing 422 contract
      // and prevents misleading "capability unavailable" responses for what
      // is really a transient connectivity issue.
      if (
        getInbound(stream.source_swarm_id) &&
        !hasCapability(stream.source_swarm_id, 'cascade.canAct')
      ) {
        return reply.status(409).send({
          error: 'Capability Unavailable',
          message:
            "The swarm that owns this stream does not accept cascade actions (cascade.canAct not declared). It is observe-only.",
          sent: false,
        });
      }

      // QC gate (Q2): a hub-initiated merge is withheld when the stream's
      // resolved review policy is `required` and there is no current-head
      // HUMAN approval ([D3]/[D4] — docs/design/cascade-review-verdicts.md).
      // Other actions (pause, abandon, resolve, …) are never review-gated.
      if (action === 'merge') {
        const gate = resolveStreamReviewGate(stream);
        if (gate.blocked) {
          return reply.status(409).send({
            error: 'Review Required',
            code: 'review_required',
            message:
              'This stream requires a human-approved review at its current head before the hub will request a merge.',
            policy: gate.policy,
            head_commit: gate.head_commit,
            current_verdict: gate.current_verdict?.verdict ?? null,
            sent: false,
          });
        }
      }

      const body = request.body ?? {};
      const result = sendCascadeAction(
        stream.source_swarm_id,
        action as CascadeAction,
        {
          stream_id: stream.stream_id,
          target_stream_id: body.target_stream_id,
          reason: body.reason,
          conflict_id: body.conflict_id,
          strategy: body.strategy,
          remote: body.remote,
          target_ref: body.target_ref ?? stream.publish_branch ?? undefined,
          message: body.message,
          metadata: body.metadata,
        },
      );

      if (!result.sent) {
        return reply.status(422).send({
          error: 'Unprocessable',
          message: result.error,
          sent: false,
        });
      }

      return reply.send({ sent: true, action, stream_id: stream.stream_id });
    }
  );

  // ── Review verdicts (QC station, Q1) ──────────────────────────────────
  //
  //   POST /cascade/streams/:id/verdicts   { verdict, notes?, dispatch_id? }
  //   GET  /cascade/streams/:id/verdicts   ?current=true | ?limit=&offset=
  //
  //   Hub-owned QC records over the stream projections
  //   (docs/design/cascade-review-verdicts.md). Append-only; the head commit
  //   is resolved server-side at verdict time so a new push invalidates
  //   approval by construction. reviewer_kind is derived from the
  //   authenticated principal — never client-declared — because "verified
  //   merge" means HUMAN acceptance ([D3]). Purely additive in Q1: nothing
  //   gates on these rows yet.

  fastify.post<{
    Params: { id: string };
    Body: { verdict?: string; notes?: string; dispatch_id?: string };
  }>(
    '/cascade/streams/:id/verdicts',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const body = request.body ?? {};
      if (
        !body.verdict ||
        !REVIEW_VERDICT_VALUES.includes(body.verdict as ReviewVerdictValue)
      ) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `verdict must be one of: ${REVIEW_VERDICT_VALUES.join(', ')}`,
        });
      }

      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Cascade stream not found' });
      }

      // Principal → reviewer_kind. Human accounts (A3 password login) and
      // admin-stamped operator credentials count as human acceptance; every
      // other agent key records an advisory agent verdict.
      const principal = request.agent;
      const reviewer_kind =
        principal?.account_type === 'human' || principal?.is_admin
          ? 'human'
          : 'agent';

      // The reviewed head is whatever the projection knows right now — the
      // reviewer looked at the hub's diff of this stream, which is derived
      // from the same latest-commit row.
      const head = getLatestCommitForStream(stream.id);

      const verdict = recordVerdict({
        stream_row_id: stream.id,
        source_swarm_id: stream.source_swarm_id,
        stream_id: stream.stream_id,
        head_commit: head?.commit_hash ?? null,
        verdict: body.verdict as ReviewVerdictValue,
        reviewer_kind,
        reviewer_id: principal?.id ?? null,
        notes: body.notes ?? null,
        dispatch_id: body.dispatch_id ?? null,
      });

      try {
        mapHubEvents.emit('cascade_review_verdict_recorded', verdict);
      } catch {
        // Non-critical — listener failures shouldn't fail the write.
      }
      try {
        const wsMessage = {
          type: 'cascade:review_verdict' as const,
          data: verdict,
        };
        broadcastToChannel(`cascade:stream:${stream.id}`, wsMessage);
        broadcastToChannel(`cascade:swarm:${stream.source_swarm_id}`, wsMessage);
        broadcastToChannel('global', wsMessage);
      } catch {
        // Non-critical
      }

      // Close the feedback loop: the verdict lands in the author's work
      // thread (dispatch conversation, else spec discussion). Fire-and-
      // forget; postVerdictThreadTurn never rejects.
      void postVerdictThreadTurn(verdict, stream);

      return reply.status(201).send({ data: verdict });
    }
  );

  fastify.get<{
    Params: { id: string };
    Querystring: { current?: string; limit?: string; offset?: string };
  }>(
    '/cascade/streams/:id/verdicts',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Cascade stream not found' });
      }

      if (request.query.current === 'true') {
        const head = getLatestCommitForStream(stream.id);
        const current = getCurrentVerdict(stream.id, head?.commit_hash ?? null);
        return reply.send({
          data: current,
          head_commit: head?.commit_hash ?? null,
        });
      }

      const { verdicts, total } = listVerdictsForStream(stream.id, {
        limit: parseLimit(request.query.limit, 50),
        offset: parseOffset(request.query.offset),
      });
      return reply.send({ data: verdicts, total });
    }
  );

  // ── Review inbox ──────────────────────────────────────────────────────
  //
  //   GET /cascade/review-inbox
  //
  //   The DERIVED "awaiting review" set: active streams with commits under
  //   a non-`none` policy and no HUMAN verdict at the current head. No
  //   state machine — new commits move the head and streams re-enter
  //   automatically. Feeds the Changes page bucket.

  fastify.get(
    '/cascade/review-inbox',
    { preHandler: authMiddleware },
    async (_request, reply) => {
      const entries = listStreamsAwaitingReview();
      return reply.send({ data: entries, total: entries.length });
    }
  );

  // ── Request agent review (QC station Q3) ─────────────────────────────
  //
  //   POST /cascade/streams/:id/request-review   { target_swarm_id? }
  //
  //   Creates a reviewer dispatch (`role: 'reviewer'`) whose prompt embeds
  //   the stream diff. The reviewing agent's completion report is parsed
  //   into an ADVISORY agent verdict via the finalize hook — it never
  //   satisfies a `required` policy ([D3]). Manual trigger in v1;
  //   policy-driven triggering is future work.

  fastify.post<{
    Params: { id: string };
    Body: { target_swarm_id?: string };
  }>(
    '/cascade/streams/:id/request-review',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Cascade stream not found' });
      }

      const principal = request.agent;
      const result = await requestReviewDispatch({
        streamRowId: stream.id,
        targetSwarmId: request.body?.target_swarm_id,
        initiatorType:
          principal?.account_type === 'human' || principal?.is_admin
            ? 'user'
            : 'agent',
      });
      if (!result) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Cascade stream not found' });
      }

      return reply.status(201).send({
        data: {
          dispatch_id: result.dispatch.id,
          target_swarm_id: result.dispatch.target_swarm_id,
          role: result.dispatch.role,
          status: result.dispatch.status,
          diff_inlined: result.diff_inlined,
        },
      });
    }
  );

  // ── Branch alias management ─────────────────────────────────────────
  //
  //   PATCH /cascade/streams/:id/branch
  //     { publish_branch: "feature/oauth-v2" }
  //
  //   Sets the human-readable branch name used for push + PR. Auto-
  //   generates from stream name if not explicitly set.

  fastify.patch<{
    Params: { id: string };
    Body: { publish_branch?: string };
  }>(
    '/cascade/streams/:id/branch',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply.status(404).send({ error: 'Not Found', message: 'Stream not found' });
      }
      const branchName = request.body?.publish_branch ?? defaultPublishBranch(stream.name);
      updatePublishBranch(stream.id, branchName);
      return reply.send({ data: { stream_id: stream.stream_id, publish_branch: branchName } });
    }
  );

  // ── Diff fetch (cascade_diff_cache + on-demand via MAP) ─────────────
  //
  //   GET /cascade/streams/:id/commits/:hash/diff
  //     ?file=src/a.ts        — restrict to one path
  //     &base=<sha>           — explicit base for ranged diffs
  //     &files_only=true      — return files_touched only (D17)
  //
  //   Returns { data: { diff, files_touched, truncated } } on hit. Error
  //   codes are mapped to HTTP statuses (see diffErrorStatus below).

  fastify.get<{
    Params: { id: string; hash: string };
    Querystring: { file?: string; base?: string; files_only?: string };
  }>(
    '/cascade/streams/:id/commits/:hash/diff',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { resolveCommitDiff } = await import('../../cascade/diff-resolver.js');
      const result = await resolveCommitDiff({
        stream_row_id: request.params.id,
        commit_hash: request.params.hash,
        base_hash: request.query.base,
        file_path: request.query.file,
        files_only: request.query.files_only === 'true',
      });

      if (!result.ok) {
        return reply.status(diffErrorStatus(result.error.code)).send({
          error: result.error.code,
          message: result.error.message,
        });
      }
      return reply.send({ data: result.payload });
    }
  );

  // ── Stream-level diff (base_commit..head) ──────────────────────────
  //
  //   GET /cascade/streams/:id/diff
  //     ?file=src/foo.ts     — restrict to one path
  //     &files_only=true     — return files_touched only (D17)

  fastify.get<{
    Params: { id: string };
    Querystring: { file?: string; files_only?: string };
  }>(
    '/cascade/streams/:id/diff',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { resolveStreamDiff } = await import('../../cascade/diff-resolver.js');
      const result = await resolveStreamDiff({
        stream_row_id: request.params.id,
        file_path: request.query.file,
        files_only: request.query.files_only === 'true',
      });
      if (!result.ok) {
        return reply.status(diffErrorStatus(result.error.code)).send({
          error: result.error.code,
          message: result.error.message,
        });
      }
      return reply.send({ data: result.payload });
    }
  );

  // ── Stack-level diff (lowest_base..highest_head across linear stack) ─
  //
  //   GET /cascade/streams/:id/stack/diff
  //     ?file=src/foo.ts     — restrict to one path
  //     &files_only=true     — files_touched only
  //
  //   Stream 2 D2: walker uses active-subset linearity (merged / abandoned
  //   children are skipped). Non-linear stacks return 400 with code
  //   `non_linear_stack` so the UI can show a useful notice.

  fastify.get<{
    Params: { id: string };
    Querystring: { file?: string; files_only?: string };
  }>(
    '/cascade/streams/:id/stack/diff',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { resolveStackDiff } = await import('../../cascade/diff-resolver.js');
      const result = await resolveStackDiff({
        stack_root_row_id: request.params.id,
        file_path: request.query.file,
        files_only: request.query.files_only === 'true',
      });

      if (!result.ok) {
        // Translate the wrapped non-linear error to a dedicated REST code
        // so the UI can show a "view individual streams instead" notice.
        const isNonLinear =
          result.error.code === 'bad_request' &&
          result.error.message.startsWith('non_linear_stack');
        if (isNonLinear) {
          return reply.status(400).send({
            error: 'non_linear_stack',
            message: result.error.message,
          });
        }
        return reply.status(diffErrorStatus(result.error.code)).send({
          error: result.error.code,
          message: result.error.message,
        });
      }

      // Echo the stack shape back so the UI can render the file tree
      // alongside metadata about which streams contributed to the range.
      return reply.send({
        data: result.payload,
        stack: result.stack ?? null,
      });
    }
  );

  // ── PR management (hub-side GitHub API) ─────────────────────────────
  //
  //   POST   /cascade/streams/:id/pr — create PR
  //   PATCH  /cascade/streams/:id/pr — update PR body/title
  //   DELETE /cascade/streams/:id/pr — close PR
  //   GET    /cascade/streams/:id/pr — get current PR state

  fastify.post<{
    Params: { id: string };
    Body: { target_branch?: string; title?: string; draft?: boolean };
  }>(
    '/cascade/streams/:id/pr',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply.status(404).send({ error: 'Not Found', message: 'Stream not found' });
      }

      // Resolve GitHub repo from the resource's git_remote_url
      const resource = stream.task_resource_id
        ? (await import('../../db/dal/syncable-resources.js')).findResourceById(stream.task_resource_id)
        : null;
      const gitUrl = resource?.git_remote_url ?? '';
      const repoInfo = parseGitHubRepo(gitUrl);
      if (!repoInfo) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Cannot parse GitHub repo from: ${gitUrl}. PR creation requires a github.com remote.`,
        });
      }

      // Ensure publish_branch is set
      const sourceBranch = stream.publish_branch ?? defaultPublishBranch(stream.name);
      if (!stream.publish_branch) {
        updatePublishBranch(stream.id, sourceBranch);
      }

      // Auto-push first (send request.push to runtime)
      sendCascadeAction(stream.source_swarm_id, 'push', {
        stream_id: stream.stream_id,
        target_ref: sourceBranch,
      });

      const targetBranch = request.body?.target_branch ?? 'main';
      const title = request.body?.title ?? stream.name;

      // Generate PR body from changelog
      let prBody = '';
      try {
        const changelog = generateChangelog(
          stream.task_resource_id ?? stream.stream_id,
          stream.task_node_id ?? stream.stream_id,
        );
        if (changelog.has_work) {
          prBody = renderMarkdown(changelog);
        }
      } catch { /* changelog generation failed — empty body */ }

      prBody = prBody || `Stream \`${stream.stream_id}\` from ${stream.source_agent_id}`;
      const bodyHash = simpleHash(prBody);

      try {
        const ghPR = await createPullRequest({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          title,
          body: prBody,
          head: sourceBranch,
          base: targetBranch,
          draft: request.body?.draft ?? false,
        });

        const pr = createPR({
          stream_row_id: stream.id,
          source_branch: sourceBranch,
          target_branch: targetBranch,
          title,
          body_hash: bodyHash,
          repo_owner: repoInfo.owner,
          repo_name: repoInfo.repo,
          remote_pr_number: ghPR.number,
          remote_pr_url: ghPR.html_url,
          state: ghPR.draft ? 'draft' : 'open',
        });

        return reply.status(201).send({ data: pr });
      } catch (err) {
        return reply.status(502).send({
          error: 'GitHub API Error',
          message: sanitizeGitHubError(err),
        });
      }
    }
  );

  fastify.patch<{
    Params: { id: string };
    Body: { title?: string; target_branch?: string };
  }>(
    '/cascade/streams/:id/pr',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply.status(404).send({ error: 'Not Found', message: 'Stream not found' });
      }

      const pr = getPRForStream(stream.id);
      if (!pr || !pr.remote_pr_number) {
        return reply.status(404).send({ error: 'Not Found', message: 'No open PR for this stream' });
      }

      // Re-generate body from latest changelog
      let prBody = '';
      try {
        const changelog = generateChangelog(
          stream.task_resource_id ?? stream.stream_id,
          stream.task_node_id ?? stream.stream_id,
        );
        if (changelog.has_work) prBody = renderMarkdown(changelog);
      } catch { /* */ }

      try {
        const ghPR = await updatePullRequest({
          owner: pr.repo_owner!,
          repo: pr.repo_name!,
          prNumber: pr.remote_pr_number,
          title: request.body?.title,
          body: prBody || undefined,
          base: request.body?.target_branch,
        });

        const updated = updatePR(pr.id, {
          title: request.body?.title,
          body_hash: prBody ? simpleHash(prBody) : undefined,
          state: ghPR.merged ? 'merged' : ghPR.state,
          synced_at: new Date().toISOString(),
        });

        return reply.send({ data: updated });
      } catch (err) {
        return reply.status(502).send({
          error: 'GitHub API Error',
          message: sanitizeGitHubError(err),
        });
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/cascade/streams/:id/pr',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply.status(404).send({ error: 'Not Found', message: 'Stream not found' });
      }

      const pr = getPRForStream(stream.id);
      if (!pr || !pr.remote_pr_number) {
        return reply.status(404).send({ error: 'Not Found', message: 'No open PR for this stream' });
      }

      try {
        await closePullRequest(pr.repo_owner!, pr.repo_name!, pr.remote_pr_number);
        updatePR(pr.id, { state: 'closed' });
        return reply.send({ data: { closed: true } });
      } catch (err) {
        return reply.status(502).send({
          error: 'GitHub API Error',
          message: sanitizeGitHubError(err),
        });
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/cascade/streams/:id/pr',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const stream = getStreamByRowId(request.params.id);
      if (!stream) {
        return reply.status(404).send({ error: 'Not Found', message: 'Stream not found' });
      }

      const pr = getPRForStream(stream.id);
      if (!pr) {
        return reply.send({ data: null });
      }

      // Optionally sync state from GitHub
      if (pr.remote_pr_number && pr.repo_owner && pr.repo_name) {
        try {
          const ghPR = await getPullRequest(pr.repo_owner, pr.repo_name, pr.remote_pr_number);
          if (ghPR) {
            const newState = ghPR.merged ? 'merged' : ghPR.state;
            if (newState !== pr.state) {
              updatePR(pr.id, { state: newState, synced_at: new Date().toISOString() });
              pr.state = newState;
            }
          }
        } catch { /* sync failure non-fatal */ }
      }

      return reply.send({ data: pr });
    }
  );

  // ── PR-stack action (Stream 3) ──────────────────────────────────────
  //
  //   POST /cascade/streams/:id/pr-stack
  //     body: { target_branch?: string; draft?: boolean }
  //
  //   Walks descendants of the given stream root, opens one PR per
  //   unmerged stream. Sequential per D18 with `blocked_by_parent`
  //   propagation per lineage (D20). Idempotent per D19: existing PRs
  //   are surfaced as `status='existing'`, GitHub 422 races are
  //   recovered via findOpenPRByHead. Best-effort push hint per entry
  //   (D21) gives connected sidecars a chance to push before we check
  //   branch existence on origin.

  fastify.post<{
    Params: { id: string };
    Body: { target_branch?: string; draft?: boolean };
  }>(
    '/cascade/streams/:id/pr-stack',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const rootStream = getStreamByRowId(request.params.id);
      if (!rootStream) {
        return reply.status(404).send({
          error: 'not_found',
          message: `Stream ${request.params.id} not found`,
        });
      }

      // Resolve repo from the root's task_resource_id. Every stream in
      // the plan must share the same GitHub repo — descendants inherit
      // task_resource_id by convention, but we don't enforce it here;
      // a per-entry mismatch falls through to GitHub returning a real
      // error which becomes `status='failed'`.
      const resource = rootStream.task_resource_id
        ? (await import('../../db/dal/syncable-resources.js')).findResourceById(rootStream.task_resource_id)
        : null;
      const gitUrl = resource?.git_remote_url ?? '';
      const repoInfo = parseGitHubRepo(gitUrl);
      if (!repoInfo) {
        return reply.status(400).send({
          error: 'bad_request',
          message: `Cannot parse GitHub repo from: ${gitUrl}. PR stack creation requires a github.com remote.`,
        });
      }

      let plan;
      try {
        plan = buildPRStackPlan(request.params.id);
      } catch (err) {
        if (err instanceof PRStackRootNotFoundError) {
          return reply.status(404).send({
            error: 'not_found',
            message: err.message,
          });
        }
        return reply.status(500).send({
          error: 'internal',
          message: (err as Error).message,
        });
      }

      // Caller-supplied target_branch overrides the root entry's base
      // (the only entry that uses trunk). All other bases come from the
      // walker's parent.head_branch chain.
      const rootTargetBranch = request.body?.target_branch;
      if (rootTargetBranch && plan.entries.length > 0) {
        plan.entries[0].base_branch = rootTargetBranch;
      }

      const draft = request.body?.draft ?? false;
      // Track stream_row_ids of entries that hit push_required (or fail
      // outright). D18: any plan entry whose `ancestor_row_ids` includes
      // one of these is blocked_by_parent without contacting GitHub.
      // Earlier impl used `lineage_id` which collapsed fork siblings
      // into a shared marker but missed root-with-immediate-fork cases
      // (code review 2026-05-11).
      const blockedAncestors = new Set<string>();

      type PRStackOutEntry = PRStackEntry & {
        result_status:
          | 'created'
          | 'existing'
          | 'push_required'
          | 'blocked_by_parent'
          | 'blocked_by_review'
          | 'failed';
        pr_url?: string;
        pr_number?: number;
        error?: string;
      };
      const results: PRStackOutEntry[] = [];

      for (const entry of plan.entries) {
        const base: PRStackOutEntry = { ...entry, result_status: 'failed' };

        // D18: skip if any ancestor in this entry's chain hit
        // push_required (or failed before us). Walker emits ancestors
        // parent-first, so checking by stream_row_id is unambiguous.
        if (entry.ancestor_row_ids.some((id) => blockedAncestors.has(id))) {
          base.result_status = 'blocked_by_parent';
          results.push(base);
          continue;
        }

        // D19: existing PR short-circuit.
        try {
          const existing = getPRForStream(entry.stream_row_id);
          if (existing && existing.remote_pr_number && existing.state !== 'closed') {
            base.result_status = 'existing';
            base.pr_url = existing.remote_pr_url ?? undefined;
            base.pr_number = existing.remote_pr_number ?? undefined;
            results.push(base);
            continue;
          }
        } catch { /* fall through to fresh-create path */ }

        // QC gate (Q2): opening a PR is a hub-initiated landing action, so
        // a `required` review policy withholds it until the stream carries
        // a current-head human approval. Blocks propagate to descendants
        // like push_required (their base branch would be unreviewed work).
        const entryStream = getStreamByRowId(entry.stream_row_id);
        if (entryStream) {
          const gate = resolveStreamReviewGate(entryStream);
          if (gate.blocked) {
            base.result_status = 'blocked_by_review';
            blockedAncestors.add(entry.stream_row_id);
            results.push(base);
            continue;
          }
        }

        // D21: best-effort push hint. Fire-and-forget; offline-swarm
        // failures are silently ignored, the branch-exists check below
        // still gates whether we actually call GitHub.
        try {
          sendCascadeAction(rootStream.source_swarm_id, 'push', {
            stream_id: entry.cascade_stream_id,
            target_ref: entry.head_branch,
          });
        } catch { /* non-critical */ }

        // Branch-exists gate (D8).
        let onOrigin = false;
        try {
          onOrigin = await branchExists(
            repoInfo.owner,
            repoInfo.repo,
            entry.head_branch,
          );
        } catch (err) {
          base.result_status = 'failed';
          base.error = sanitizeGitHubError(err);
          results.push(base);
          continue;
        }

        if (!onOrigin) {
          base.result_status = 'push_required';
          // D18: any descendant whose ancestor chain contains this row
          // is blocked. The walker emits in parent-before-child order,
          // so adding this row id now suffices for all future entries.
          blockedAncestors.add(entry.stream_row_id);
          results.push(base);
          continue;
        }

        // Build PR body from changelog (same approach as single-PR
        // endpoint at cascade.ts:693-705). Empty body is acceptable.
        let prBody = '';
        try {
          const changelog = generateChangelog(
            rootStream.task_resource_id ?? entry.cascade_stream_id,
            rootStream.task_node_id ?? entry.cascade_stream_id,
          );
          if (changelog.has_work) prBody = renderMarkdown(changelog);
        } catch { /* changelog generation failed — empty body */ }
        prBody =
          prBody ||
          `Stream \`${entry.cascade_stream_id}\` from ${rootStream.source_agent_id}`;
        const bodyHash = simpleHash(prBody);

        try {
          const ghPR = await createPullRequest({
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            title: entry.name,
            body: prBody,
            head: entry.head_branch,
            base: entry.base_branch,
            draft,
          });

          // Persist + ensure publish_branch matches what we just used.
          if (!getStreamByRowId(entry.stream_row_id)?.publish_branch) {
            updatePublishBranch(entry.stream_row_id, entry.head_branch);
          }
          createPR({
            stream_row_id: entry.stream_row_id,
            source_branch: entry.head_branch,
            target_branch: entry.base_branch,
            title: entry.name,
            body_hash: bodyHash,
            repo_owner: repoInfo.owner,
            repo_name: repoInfo.repo,
            remote_pr_number: ghPR.number,
            remote_pr_url: ghPR.html_url,
            state: ghPR.draft ? 'draft' : 'open',
          });
          base.result_status = 'created';
          base.pr_url = ghPR.html_url;
          base.pr_number = ghPR.number;
          results.push(base);
        } catch (err) {
          // D19 race: 422 duplicate-PR-for-branch → look up the open PR
          // by `head=owner:branch` and surface as `existing`.
          const msg = err instanceof Error ? err.message : String(err);
          if (/→ 422\b/.test(msg)) {
            try {
              const existingPR = await findOpenPRByHead(
                repoInfo.owner,
                repoInfo.repo,
                entry.head_branch,
              );
              if (existingPR) {
                createPR({
                  stream_row_id: entry.stream_row_id,
                  source_branch: existingPR.head.ref,
                  target_branch: existingPR.base.ref,
                  title: existingPR.title,
                  body_hash: bodyHash,
                  repo_owner: repoInfo.owner,
                  repo_name: repoInfo.repo,
                  remote_pr_number: existingPR.number,
                  remote_pr_url: existingPR.html_url,
                  state: existingPR.draft ? 'draft' : existingPR.state,
                });
                base.result_status = 'existing';
                base.pr_url = existingPR.html_url;
                base.pr_number = existingPR.number;
                results.push(base);
                continue;
              }
            } catch { /* fall through to failed */ }
          }
          base.result_status = 'failed';
          base.error = sanitizeGitHubError(err);
          results.push(base);
        }
      }

      return reply.send({
        data: {
          trunk: plan.trunk,
          entries: results,
        },
      });
    }
  );

  // ── GitHub connection check ─────────────────────────────────────────

  fastify.get(
    '/cascade/github/status',
    { preHandler: authMiddleware },
    async (_request, reply) => {
      const status = await checkGitHubConnection();
      return reply.send({ data: status });
    }
  );
}

/**
 * Map a DiffError code to an HTTP status. Kept here (not in diff-types.ts)
 * because HTTP semantics are a transport concern, not a domain concern.
 */
function diffErrorStatus(code: string): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'bad_request':
      return 400;
    case 'timeout':
      return 504;
    case 'integrity_failed':
      return 502;
    case 'swarm_offline':
    case 'capability_missing':
      return 503;
    case 'internal':
    default:
      return 500;
  }
}

/**
 * Strip potentially sensitive details from GitHub API errors before
 * returning to the client. Keeps the HTTP status + a short reason
 * but removes raw response bodies that may contain token scoping info.
 */
function sanitizeGitHubError(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown GitHub API error';
  const msg = err.message;
  // Extract just the status code + endpoint, drop the raw response body
  const match = msg.match(/GitHub API \w+ (\/[^\s]+) → (\d+)/);
  if (match) return `GitHub API ${match[1]} returned ${match[2]}`;
  // Fallback: truncate and strip anything after a colon that might be a body
  const short = msg.split('\n')[0].slice(0, 120);
  return short.includes('{') ? short.slice(0, short.indexOf('{')) + '(details omitted)' : short;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
