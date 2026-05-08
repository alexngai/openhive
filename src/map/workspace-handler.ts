/**
 * OpenHive consumer-side implementation of `RepoProtocolHandler` from
 * `agent-workspace/kinds/repo`.
 *
 * The handler routes the four `x-workspace/repo.*` MAP methods through
 * openhive's persistence (repos + workspaces DALs) and broadcasts lifecycle
 * events on the realtime channels (`map:repos` + `map:repo:${repoId}`).
 *
 * Per CLAUDE.md "Repos and Workspaces":
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
  RepoBindingsParams,
  RepoBindingsResult,
  RepoBindingEntry,
  FederatedPeerEntry,
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
 * `syncable_resources.visibility` is unused for repos.
 *
 * Fails closed to `'private'` for repos with missing metadata visibility —
 * corrupt rows / partial migrations should be invisible to non-owners
 * rather than defaulting to a permissive tier. Repos created via the
 * production path always carry `metadata.visibility`, so the fallback
 * only triggers on schema drift. */
function repoVisibility(repo: { metadata: unknown }): RepoVisibility {
  const meta = repo.metadata as { visibility?: RepoVisibility } | null;
  return meta?.visibility ?? 'private';
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
    // Capability gate: agents that haven't declared `declare.enabled = true`
    // shouldn't be able to push declarations. Mirrors the `onList` guard.
    // Also covers the `onChanged → onDeclare` re-entry for `added` bindings
    // since that path doesn't gate independently.
    if (ctx.capabilities && !ctx.capabilities.declare.enabled) {
      throw new CapabilityError(['workspace.declare']);
    }

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
        // Workspace bindings expose `local_path` which is per-machine info.
        // Scope by visibility tier — anything broader than the caller's
        // immediate context leaks file paths the caller shouldn't see:
        //   - private  → owner agent only
        //   - hub_local → same swarm only (per-machine, per-swarm scope)
        //   - federated → caller hub (broader cross-hub federation flows
        //                 through the mesh-sync materializer, not onList)
        if (eff === 'private' && ws.agent_id !== ctx.agentId) continue;
        if (eff === 'hub_local' && ws.swarm_id !== ctx.swarmId) continue;
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
        // Bulk retract narrows per-binding visibility for one (agent, repo)
        // pair. The repo's own metadata.visibility is unchanged, so we
        // emit per-binding `workspace_changed` events — the previous
        // `repo_visibility_changed` event was a misnomer that lied to the
        // UI about what mutated.
        const affected = workspaces
          .listWorkspacesForRepo(repo.id, { activeOnly: false })
          .filter((ws) => ws.agent_id === ctx.agentId);
        for (const ws of affected) {
          broadcastWorkspaceLifecycleEvent(repo.id, {
            type: 'workspace_changed',
            data: { workspace: ws },
          });
        }
      }
    }
  }

  // ── bindings ─────────────────────────────────────────────────────────────

  async onBindings(params: RepoBindingsParams, ctx: RepoHandlerContext): Promise<RepoBindingsResult> {
    const repo = repos.findRepoByCanonicalUrl(params.canonical_url);
    if (!repo) {
      return { bindings: [], federated_peers: [] };
    }

    const repoVis = repoVisibility(repo);
    const allBindings = workspaces.listWorkspacesForRepo(repo.id, { activeOnly: true });

    const visibleBindings: RepoBindingEntry[] = [];
    for (const ws of allBindings) {
      const eff = effectiveVisibility(repoVis, ws.visibility);
      if (eff === 'private' && ws.agent_id !== ctx.agentId) continue;
      if (eff === 'hub_local' && ws.swarm_id !== ctx.swarmId) continue;

      visibleBindings.push({
        agent_id: ws.agent_id,
        workspace_id: ws.id,
        local_path: ws.local_path,
        visibility: ws.visibility,
        declared_at: ws.created_at,
      });
    }

    const db = getDatabase();
    const peerRows = db.prepare(`
      SELECT DISTINCT sr.origin_instance_id, sp.peer_endpoint
      FROM syncable_resources sr
      LEFT JOIN hive_sync_peers sp ON sp.peer_instance_id = sr.origin_instance_id
      WHERE sr.resource_type = 'repo'
        AND sr.git_remote_url = ?
        AND sr.origin_instance_id IS NOT NULL
    `).all(repo.git_remote_url) as Array<{ origin_instance_id: string; peer_endpoint: string | null }>;

    const federatedPeers: FederatedPeerEntry[] = peerRows.map((r) => ({
      hub_id: r.origin_instance_id,
      hub_url: r.peer_endpoint ?? '',
    }));

    return { bindings: visibleBindings, federated_peers: federatedPeers };
  }
}
