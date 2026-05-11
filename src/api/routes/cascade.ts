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
} from '../../db/dal/cascade-streams.js';
import { findResourcesByRepoUrl } from '../../db/dal/syncable-resources.js';
import { generateChangelog, renderMarkdown } from '../../cascade/changelog.js';
import { sendCascadeAction, type CascadeAction } from '../../map/cascade-actions.js';
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
} from '../../integrations/github-api.js';

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
  //   Returns 200 { sent: true } if the notification was dispatched, or
  //   422 { sent: false, error } if the swarm is disconnected or action
  //   is unknown.
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
