/**
 * Repos REST API (slice 4).
 *
 * Surface for browsing and managing repo syncable resources from the UI.
 * Pairs with the producer hooks added in slice 5 (a, b) — visibility
 * transitions, archives, and merges fire the matching `onRepo*` hook so
 * federated peers get notified through the existing mesh.
 *
 * Read endpoints honor visibility per the package's `effectiveVisibility`
 * rule: `'private'` repos are visible only to their owner agent;
 * `'hub_local'` and `'federated'` are public-on-hub.
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as repos from '../../db/dal/repos.js';
import * as workspaces from '../../db/dal/workspaces.js';
import { getDatabase } from '../../db/index.js';
import {
  onRepoPublished,
  onRepoUpdated,
  onRepoRedacted,
  onRepoArchived,
  onRepoMerged,
} from '../../sync/resource-hooks.js';
import { broadcastWorkspaceLifecycleEvent } from '../../realtime/workspace-events.js';
import {
  ListReposQuerySchema,
  CreateRepoSchema,
  UpdateRepoSchema,
  MergeRepoSchema,
} from '../schemas/repos.js';
import type { Config } from '../../config.js';
import type { Agent, SyncableResource } from '../../types.js';
import type { RepoVisibility } from 'agent-workspace/kinds/repo';

interface RepoMetadataView {
  visibility?: RepoVisibility;
  origin?: 'user_defined' | 'agent_declared' | 'trajectory_inferred';
  default_branch?: string;
  description?: string;
  name?: string;
  binding_policy?: 'open' | 'closed';
}

function getMeta(repo: SyncableResource): RepoMetadataView {
  return (repo.metadata ?? {}) as RepoMetadataView;
}

/** Visibility check: private repos are owner-only. */
function canSee(repo: SyncableResource, viewer: Agent | undefined): boolean {
  const vis = getMeta(repo).visibility ?? 'hub_local';
  if (vis === 'private') {
    if (!viewer) return false;
    return repo.owner_agent_id === viewer.id || viewer.is_admin;
  }
  return true;
}

/**
 * Resolve a repo for a mutation route. Returns the repo if the caller may
 * mutate it; otherwise sends the right status to `reply` and returns null.
 *
 * Decision matrix (existence-leak guard):
 *   - repo missing                       → 404
 *   - repo private + caller can't see it → 404 (hide existence)
 *   - repo visible but caller not owner  → 403 (admin override allowed)
 *   - caller is owner OR admin           → return repo
 */
function authorizeMutation(
  reply: FastifyReply,
  repo: SyncableResource | null,
  viewer: Agent,
): SyncableResource | null {
  if (!repo) {
    reply.status(404).send({ error: 'Not Found' });
    return null;
  }
  if (!canSee(repo, viewer)) {
    reply.status(404).send({ error: 'Not Found' });
    return null;
  }
  if (repo.owner_agent_id !== viewer.id && !viewer.is_admin) {
    reply.status(403).send({ error: 'Forbidden', message: 'Not the owner' });
    return null;
  }
  return repo;
}

export async function reposRoutes(
  fastify: FastifyInstance,
  _options: { config: Config },
): Promise<void> {
  // ── List ──────────────────────────────────────────────────────────────────

  fastify.get('/repos', { preHandler: optionalAuthMiddleware }, async (request, reply) => {
    const parsed = ListReposQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation Error', details: parsed.error.issues });
    }
    const { origin, visibility, status, limit, offset } = parsed.data;

    let all = repos.listRepos({
      ...(origin !== undefined && { origin }),
      ...(visibility !== undefined && { visibility }),
    });

    // Status filter is on the column, not metadata — apply post-fetch since
    // listRepos doesn't expose it yet. (Cheap; repo count is bounded.)
    if (status !== undefined) {
      all = all.filter((r) => (r as SyncableResource & { status?: string }).status === status);
    }

    // Visibility scoping for unauthenticated / non-owner viewers.
    const visible = all.filter((r) => canSee(r, request.agent));

    const slice = visible.slice(offset, offset + limit);
    return reply.send({ data: slice, total: visible.length, limit, offset });
  });

  // ── Create (user-defined) ─────────────────────────────────────────────────

  fastify.post('/repos', { preHandler: authMiddleware }, async (request, reply) => {
    const parsed = CreateRepoSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation Error', details: parsed.error.issues });
    }

    const identity = canonicalizeRepoUrl(parsed.data.remote_url);
    const existing = repos.findRepoByCanonicalUrl(identity.canonicalUrl);
    if (existing) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Repo with this canonical URL already exists',
        repo: existing,
      });
    }

    const repo = repos.upsertRepoByCanonicalUrl(identity, {
      origin: 'user_defined',
      visibility: parsed.data.visibility,
      owner_agent_id: request.agent!.id,
      ...(parsed.data.name !== undefined && { name: parsed.data.name }),
      ...(parsed.data.default_branch !== undefined && { default_branch: parsed.data.default_branch }),
      ...(parsed.data.description !== undefined && { description: parsed.data.description }),
      ...(parsed.data.binding_policy !== undefined && { binding_policy: parsed.data.binding_policy }),
    });

    // Federation hook: only fires when visibility === 'federated'.
    onRepoPublished(repo);

    return reply.status(201).send({ repo });
  });

  // ── Get by id ─────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    '/repos/:id',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const repo = repos.findRepoById(request.params.id);
      if (!repo) {
        return reply.status(404).send({ error: 'Not Found', message: 'Repo not found' });
      }
      if (!canSee(repo, request.agent)) {
        return reply.status(404).send({ error: 'Not Found', message: 'Repo not found' });
      }
      return reply.send({ repo });
    },
  );

  // ── Patch (metadata + visibility transitions) ─────────────────────────────

  fastify.patch<{ Params: { id: string } }>(
    '/repos/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const parsed = UpdateRepoSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', details: parsed.error.issues });
      }

      const existing = authorizeMutation(reply, repos.findRepoById(request.params.id), request.agent!);
      if (!existing) return reply;

      const oldMeta = getMeta(existing);
      const oldVisibility = oldMeta.visibility ?? 'hub_local';

      // Build a metadata patch — only the keys actually present.
      const metadataPatch: Partial<RepoMetadataView> = {};
      if (parsed.data.default_branch !== undefined) metadataPatch.default_branch = parsed.data.default_branch;
      if (parsed.data.description !== undefined) metadataPatch.description = parsed.data.description;
      if (parsed.data.visibility !== undefined) metadataPatch.visibility = parsed.data.visibility;
      if (parsed.data.binding_policy !== undefined) metadataPatch.binding_policy = parsed.data.binding_policy;
      if (parsed.data.name !== undefined) metadataPatch.name = parsed.data.name;

      const updated = repos.updateRepoFields(existing.id, {
        ...(parsed.data.name !== undefined && { name: parsed.data.name }),
        ...(parsed.data.description !== undefined && { description: parsed.data.description }),
        ...(Object.keys(metadataPatch).length > 0 && { metadataPatch }),
      })!;
      const newVisibility = (parsed.data.visibility ?? oldVisibility) as RepoVisibility;

      // Visibility-transition hooks. The package owns the semantics — we
      // just dispatch the right hook for each transition.
      if (oldVisibility !== newVisibility) {
        if (oldVisibility !== 'federated' && newVisibility === 'federated') {
          // First federation publish.
          onRepoPublished(updated);
        } else if (oldVisibility === 'federated' && newVisibility !== 'federated') {
          // Federated → non-federated: redact on peers.
          onRepoRedacted(updated, oldVisibility, newVisibility);
        }
        broadcastWorkspaceLifecycleEvent(updated.id, {
          type: 'repo_visibility_changed',
          data: { repo_id: updated.id, new_visibility: newVisibility },
        });
      } else if (newVisibility === 'federated') {
        // Metadata-only refresh on a federated repo.
        onRepoUpdated(updated);
      }

      // Always broadcast `repo_updated` so UI subscribers invalidate even
      // for non-visibility, non-federated metadata edits (description,
      // default_branch, binding_policy on a hub_local repo).
      broadcastWorkspaceLifecycleEvent(updated.id, {
        type: 'repo_updated',
        data: { repo_id: updated.id },
      });

      return reply.send({ repo: updated });
    },
  );

  // ── Archive / Unarchive ───────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    '/repos/:id/archive',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const repo = authorizeMutation(reply, repos.findRepoById(request.params.id), request.agent!);
      if (!repo) return reply;

      const db = getDatabase();
      db.prepare(
        `UPDATE syncable_resources SET status = 'archived', updated_at = datetime('now') WHERE id = ?`,
      ).run(repo.id);

      const updated = repos.findRepoById(repo.id)!;
      onRepoArchived(updated);
      broadcastWorkspaceLifecycleEvent(updated.id, {
        type: 'repo_archived',
        data: { repo_id: updated.id },
      });
      return reply.send({ repo: updated });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/repos/:id/unarchive',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const repo = authorizeMutation(reply, repos.findRepoById(request.params.id), request.agent!);
      if (!repo) return reply;

      const db = getDatabase();
      db.prepare(
        `UPDATE syncable_resources SET status = 'active', updated_at = datetime('now') WHERE id = ?`,
      ).run(repo.id);

      const updated = repos.findRepoById(repo.id)!;
      broadcastWorkspaceLifecycleEvent(updated.id, {
        type: 'repo_updated',
        data: { repo_id: updated.id },
      });
      return reply.send({ repo: updated });
    },
  );

  // ── List workspaces (active bindings) for a repo ──────────────────────────

  fastify.get<{ Params: { id: string }; Querystring: { active_only?: string } }>(
    '/repos/:id/workspaces',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const repo = repos.findRepoById(request.params.id);
      if (!repo) return reply.status(404).send({ error: 'Not Found' });
      if (!canSee(repo, request.agent)) {
        return reply.status(404).send({ error: 'Not Found' });
      }

      const activeOnly = request.query.active_only !== 'false';
      const bindings = workspaces.listWorkspacesForRepo(repo.id, { activeOnly });
      return reply.send({ data: bindings, total: bindings.length });
    },
  );

  // ── Merge ─────────────────────────────────────────────────────────────────

  fastify.post<{ Params: { source_id: string } }>(
    '/repos/:source_id/merge',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const parsed = MergeRepoSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', details: parsed.error.issues });
      }
      const source = authorizeMutation(reply, repos.findRepoById(request.params.source_id), request.agent!);
      if (!source) return reply;
      const target = repos.findRepoById(parsed.data.into);
      if (!target) return reply.status(404).send({ error: 'Not Found', message: 'Target repo not found' });
      // Don't leak the existence of a private target the caller can't see.
      if (!canSee(target, request.agent)) {
        return reply.status(404).send({ error: 'Not Found', message: 'Target repo not found' });
      }
      if (source.id === target.id) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Cannot merge a repo into itself' });
      }

      const sourceMeta = getMeta(source);
      const merged = {
        ...sourceMeta,
        merged_into_canonical_url: target.git_remote_url,
        merged_at: new Date().toISOString(),
      };
      const db = getDatabase();
      db.prepare(
        `UPDATE syncable_resources
            SET status = 'merged_into', metadata = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(JSON.stringify(merged), source.id);

      const updated = repos.findRepoById(source.id)!;
      onRepoMerged(updated, target.git_remote_url);

      return reply.send({ source: updated, target });
    },
  );
}
