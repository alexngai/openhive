/**
 * OpenHive consumer-side implementation of `RepoProtocolHandler` from
 * `agent-workspace/kinds/repo`.
 *
 * The handler routes the four `x-workspace/repo.*` MAP methods through
 * openhive's persistence (repos + workspaces DALs) and broadcasts lifecycle
 * events on the realtime channels (`map:repos` + `map:repo:${repoId}`).
 *
 * Per the design doc (`docs/design/repos-as-syncable-resources.md`):
 * - `agent-workspace/kinds/repo` owns the wire format and protocol semantics.
 * - OpenHive owns persistence, federation, REST/UI, and policy enforcement.
 *
 * Slice 2 wires the handler with persistence + realtime fan-out. Per-swarm
 * `workspace_policy` enforcement is sketched but defers to a follow-up
 * (D5/D11 in the openhive design doc) since policy schema isn't yet read in
 * production paths.
 */

import {
  canonicalizeRepoUrl,
  effectiveVisibility,
  isVisibilityUpgrade,
  CapabilityError,
  PolicyViolationError,
} from 'agent-workspace/kinds/repo';
import type {
  RepoProtocolHandler,
  RepoHandlerContext,
  RepoDeclareParams,
  RepoChangedParams,
  RepoListParams,
  RepoListResult,
  RepoRetractParams,
  RepoVisibility,
  WorkspaceDeclareInput,
} from 'agent-workspace/kinds/repo';

import * as repos from '../db/dal/repos.js';
import * as workspaces from '../db/dal/workspaces.js';
import { ensureNodeWithId } from '../db/dal/map.js';
import { getDatabase } from '../db/index.js';
import { broadcastWorkspaceLifecycleEvent } from '../realtime/workspace-events.js';
import type { Workspace } from '../types.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

/** `RepoMetadata.visibility` is what the package cares about; column-level
 * `syncable_resources.visibility` is unused for repos. */
function repoVisibility(repo: { metadata: unknown }): RepoVisibility {
  const meta = repo.metadata as { visibility?: RepoVisibility } | null;
  return meta?.visibility ?? 'hub_local';
}

/** Convert a stored Workspace row to the wire shape the package expects. */
function workspaceToWire(ws: Workspace, canonicalUrl: string): WorkspaceDeclareInput {
  const out: WorkspaceDeclareInput = {
    remote_url: canonicalUrl,
    local_path: ws.local_path,
    dirty: ws.dirty === 1,
    visibility: ws.visibility,
  };
  if (ws.current_branch !== null) out.current_branch = ws.current_branch;
  if (ws.head_sha !== null) out.head_sha = ws.head_sha;
  if (ws.instance_label !== null) out.instance_label = ws.instance_label;
  return out;
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * The OpenHive-side implementation of `RepoProtocolHandler`. Constructed once
 * and registered against the MAP server via `registerRepoHandlers`.
 *
 * Owner-agent resolution for newly-created repo resources:
 * - If `defaultOwnerAgentId` is supplied at construction, that value is used.
 * - Otherwise the handler looks up `map_swarms.owner_agent_id` for the
 *   calling swarm. `ctx.agentId` is the map_nodes.id (per workspaces FK)
 *   and is NOT a valid owner of an agents-table-backed resource.
 */
export class OpenHiveRepoHandler implements RepoProtocolHandler {
  private readonly defaultOwnerAgentId?: string;

  constructor(options: { defaultOwnerAgentId?: string } = {}) {
    this.defaultOwnerAgentId = options.defaultOwnerAgentId;
  }

  private resolveOwnerAgentId(swarmId: string): string {
    if (this.defaultOwnerAgentId) return this.defaultOwnerAgentId;
    const db = getDatabase();
    const row = db.prepare(
      'SELECT owner_agent_id FROM map_swarms WHERE id = ?',
    ).get(swarmId) as { owner_agent_id: string } | undefined;
    if (!row) {
      throw new Error(
        `Cannot resolve repo owner: swarm "${swarmId}" not found in map_swarms`,
      );
    }
    return row.owner_agent_id;
  }

  // ── declare ───────────────────────────────────────────────────────────────

  async onDeclare(params: RepoDeclareParams, ctx: RepoHandlerContext): Promise<void> {
    for (const w of params.workspaces) {
      const identity = canonicalizeRepoUrl(w.remote_url);
      const bindingVisibility: RepoVisibility = w.visibility ?? 'hub_local';

      // Upsert the federated repo resource. Owner = swarm owner (or explicit
      // override). Repo visibility defaults to 'hub_local' regardless of the
      // declaring binding's visibility — they're independent dimensions per
      // the package's `effectiveVisibility = min(repo, binding)` rule.
      // `origin: 'agent_declared'` is only used on first creation; the upsert
      // preserves origin/visibility for existing repos (those settings are
      // owned by whoever first created the repo, typically a user via REST).
      const repo = repos.upsertRepoByCanonicalUrl(identity, {
        origin: 'agent_declared',
        visibility: 'hub_local',
        owner_agent_id: this.resolveOwnerAgentId(ctx.swarmId),
      });

      // Ensure a map_nodes row exists for ctx.agentId before inserting the
      // workspace binding (workspaces.agent_id REFERENCES map_nodes.id).
      // The MAP-protocol agent.registered path doesn't currently project
      // into map_nodes (only the explicit REST /map/nodes endpoint does),
      // so without this defensive upsert any sidecar declare would FK-fail.
      ensureNodeWithId({
        id: ctx.agentId,
        swarm_id: ctx.swarmId,
        map_agent_id: ctx.agentId,
      });

      // Upsert the per-agent binding (idempotent on the (agent, repo, path)
      // triple; reactivates if previously deactivated).
      const ws = workspaces.upsertWorkspace({
        repo_id: repo.id,
        agent_id: ctx.agentId,
        swarm_id: ctx.swarmId,
        local_path: w.local_path,
        ...(w.current_branch !== undefined && { current_branch: w.current_branch }),
        ...(w.head_sha !== undefined && { head_sha: w.head_sha }),
        ...(w.dirty !== undefined && { dirty: w.dirty }),
        ...(w.instance_label !== undefined && { instance_label: w.instance_label }),
        visibility: bindingVisibility,
      });

      broadcastWorkspaceLifecycleEvent(repo.id, {
        type: 'workspace_added',
        data: { workspace: ws },
      });
    }
  }

  // ── changed ───────────────────────────────────────────────────────────────

  async onChanged(params: RepoChangedParams, ctx: RepoHandlerContext): Promise<void> {
    if (params.added && params.added.length > 0) {
      await this.onDeclare({ workspaces: params.added }, ctx);
    }

    if (params.removed && params.removed.length > 0) {
      for (const r of params.removed) {
        const repo = repos.findRepoByCanonicalUrl(r.canonical_url);
        if (!repo) continue;

        const existing = workspaces.findWorkspace(repo.id, ctx.agentId, r.local_path);
        if (!existing) continue;

        workspaces.deleteWorkspace(repo.id, ctx.agentId, r.local_path);

        broadcastWorkspaceLifecycleEvent(repo.id, {
          type: 'workspace_deactivated',
          data: { workspace_id: existing.id, repo_id: repo.id, agent_id: ctx.agentId },
        });
      }
    }
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async onList(params: RepoListParams, ctx: RepoHandlerContext): Promise<RepoListResult> {
    // Capability gate: agents that haven't declared `list.enabled = true`
    // shouldn't be able to call list. (Trust-but-verify — a malformed agent
    // could still call; this catches the common-case misconfiguration.)
    if (ctx.capabilities && !ctx.capabilities.list.enabled) {
      throw new CapabilityError(['workspace.list']);
    }

    const filterUrl = params.filter?.canonical_url;
    const result: WorkspaceDeclareInput[] = [];

    // Strategy: we walk all repo resources (optionally filtered by canonical
    // URL), pull active bindings for each, apply the visibility filter
    // (effective = min(repo.visibility, binding.visibility)), and return wire
    // entries.
    const reposToScan = filterUrl
      ? [repos.findRepoByCanonicalUrl(filterUrl)].filter((r): r is NonNullable<typeof r> => r !== null)
      : repos.listRepos();

    for (const repo of reposToScan) {
      const repoVis = repoVisibility(repo);
      const bindings = workspaces.listWorkspacesForRepo(repo.id, { activeOnly: true });

      for (const ws of bindings) {
        const eff = effectiveVisibility(repoVis, ws.visibility);
        // Private bindings are visible only to their owner agent.
        if (eff === 'private' && ws.agent_id !== ctx.agentId) continue;
        result.push(workspaceToWire(ws, repo.git_remote_url));
      }
    }

    return { workspaces: result };
  }

  // ── retract ───────────────────────────────────────────────────────────────

  async onRetract(params: RepoRetractParams, ctx: RepoHandlerContext): Promise<void> {
    const repo = repos.findRepoByCanonicalUrl(params.canonical_url);
    if (!repo) return; // nothing to retract; treat as no-op

    // Retract narrows visibility to 'private'. Never an upgrade by definition;
    // the package's `isVisibilityUpgrade` is checked defensively in case
    // someone calls onRetract with a different intent in the future.
    const target: RepoVisibility = 'private';

    if (params.local_path !== undefined) {
      const existing = workspaces.findWorkspace(repo.id, ctx.agentId, params.local_path);
      if (!existing) return;
      if (isVisibilityUpgrade(existing.visibility, target)) {
        throw new PolicyViolationError('agent', `retract cannot upgrade visibility`);
      }
      const updated = workspaces.updateWorkspaceVisibility(
        repo.id,
        ctx.agentId,
        params.local_path,
        target,
      );
      if (updated) {
        broadcastWorkspaceLifecycleEvent(repo.id, {
          type: 'workspace_changed',
          data: { workspace: updated },
        });
      }
    } else {
      const count = workspaces.updateAllAgentWorkspacesVisibility(
        repo.id,
        ctx.agentId,
        target,
      );
      if (count > 0) {
        // Broadcast a single repo-level event rather than N per-binding
        // workspace_changed events. Subscribers refetch.
        broadcastWorkspaceLifecycleEvent(repo.id, {
          type: 'repo_visibility_changed',
          data: { repo_id: repo.id, new_visibility: target },
        });
      }
    }
  }
}
