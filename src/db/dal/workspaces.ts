/**
 * Workspaces DAL — local-only per-agent bindings to repo resources.
 *
 * Bindings live in their own table (NOT a syncable resource) because they're
 * machine-specific runtime state. The `(agent_id, repo_id, local_path)` triple
 * is the natural key — see `docs/design/repos-as-syncable-resources.md` for
 * how this handles multiple clones, multi-remote per-clone, and worktrees.
 */

import { nanoid } from 'nanoid';
import type { RepoVisibility } from 'agent-workspace/protocol/repo';
import { getDatabase } from '../index.js';
import type { Workspace } from '../../types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UpsertWorkspaceInput {
  repo_id: string;
  agent_id: string;
  swarm_id: string;
  local_path: string;
  current_branch?: string;
  head_sha?: string;
  dirty?: boolean;
  instance_label?: string;
  visibility?: RepoVisibility;
}

export interface ListWorkspacesOptions {
  /** When true, exclude bindings with `is_active = 0`. Default: true. */
  activeOnly?: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  repo_id: string;
  agent_id: string;
  swarm_id: string;
  local_path: string;
  current_branch: string | null;
  head_sha: string | null;
  dirty: number;
  instance_label: string | null;
  visibility: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    repo_id: row.repo_id,
    agent_id: row.agent_id,
    swarm_id: row.swarm_id,
    local_path: row.local_path,
    current_branch: row.current_branch,
    head_sha: row.head_sha,
    dirty: row.dirty,
    instance_label: row.instance_label,
    visibility: row.visibility as Workspace['visibility'],
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upsert a workspace binding by `(agent_id, repo_id, local_path)`.
 *
 * On conflict (existing binding), updates branch/head/dirty/visibility/label
 * and bumps `last_seen_at` + `updated_at`. Sets `is_active = 1` (re-attaching
 * after a deactivation reactivates).
 */
export function upsertWorkspace(input: UpsertWorkspaceInput): Workspace {
  const db = getDatabase();
  const visibility: RepoVisibility = input.visibility ?? 'hub_local';
  const dirty = input.dirty ? 1 : 0;
  const id = `ws_${nanoid()}`;

  // SQLite UPSERT via INSERT ... ON CONFLICT.
  db.prepare(`
    INSERT INTO workspaces (
      id, repo_id, agent_id, swarm_id, local_path,
      current_branch, head_sha, dirty, instance_label,
      visibility, is_active, created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT (agent_id, repo_id, local_path) DO UPDATE SET
      current_branch = excluded.current_branch,
      head_sha       = excluded.head_sha,
      dirty          = excluded.dirty,
      instance_label = excluded.instance_label,
      visibility     = excluded.visibility,
      is_active      = 1,
      updated_at     = datetime('now'),
      last_seen_at   = datetime('now')
  `).run(
    id,
    input.repo_id,
    input.agent_id,
    input.swarm_id,
    input.local_path,
    input.current_branch ?? null,
    input.head_sha ?? null,
    dirty,
    input.instance_label ?? null,
    visibility,
  );

  return findWorkspace(input.repo_id, input.agent_id, input.local_path)!;
}

/**
 * Bulk-flip `is_active` to 0 for every binding owned by `agentId`.
 * Returns the number of rows affected. Used on agent disconnect /
 * `agent.unregistered`.
 */
export function deactivateWorkspacesByAgent(agentId: string): number {
  const db = getDatabase();
  const result = db.prepare(
    `UPDATE workspaces
       SET is_active = 0, updated_at = datetime('now')
       WHERE agent_id = ? AND is_active = 1`,
  ).run(agentId);
  return result.changes;
}

/**
 * Bulk-flip `is_active` to 0 for every binding under `swarmId`.
 * Returns the number of rows affected. Used on swarm disconnect / heartbeat
 * timeout / `markStaleSwarms` cascade.
 */
export function deactivateWorkspacesBySwarm(swarmId: string): number {
  const db = getDatabase();
  const result = db.prepare(
    `UPDATE workspaces
       SET is_active = 0, updated_at = datetime('now')
       WHERE swarm_id = ? AND is_active = 1`,
  ).run(swarmId);
  return result.changes;
}

/** All bindings for a given repo (federated entity). */
export function listWorkspacesForRepo(
  repoId: string,
  options: ListWorkspacesOptions = {},
): Workspace[] {
  const db = getDatabase();
  const activeOnly = options.activeOnly ?? true;

  const rows = activeOnly
    ? db.prepare(
        `SELECT * FROM workspaces WHERE repo_id = ? AND is_active = 1 ORDER BY created_at ASC`,
      ).all(repoId) as WorkspaceRow[]
    : db.prepare(
        `SELECT * FROM workspaces WHERE repo_id = ? ORDER BY created_at ASC`,
      ).all(repoId) as WorkspaceRow[];

  return rows.map(rowToWorkspace);
}

/** All bindings owned by a given agent. */
export function listWorkspacesForAgent(
  agentId: string,
  options: ListWorkspacesOptions = {},
): Workspace[] {
  const db = getDatabase();
  const activeOnly = options.activeOnly ?? true;

  const rows = activeOnly
    ? db.prepare(
        `SELECT * FROM workspaces WHERE agent_id = ? AND is_active = 1 ORDER BY created_at ASC`,
      ).all(agentId) as WorkspaceRow[]
    : db.prepare(
        `SELECT * FROM workspaces WHERE agent_id = ? ORDER BY created_at ASC`,
      ).all(agentId) as WorkspaceRow[];

  return rows.map(rowToWorkspace);
}

/** Look up a single binding by the natural key. */
export function findWorkspace(
  repoId: string,
  agentId: string,
  localPath: string,
): Workspace | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT * FROM workspaces
       WHERE agent_id = ? AND repo_id = ? AND local_path = ?
       LIMIT 1`,
  ).get(agentId, repoId, localPath) as WorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

/**
 * Update visibility on a single binding. Used by retract handling.
 * Returns the updated binding, or null if not found.
 */
export function updateWorkspaceVisibility(
  repoId: string,
  agentId: string,
  localPath: string,
  newVisibility: RepoVisibility,
): Workspace | null {
  const db = getDatabase();
  db.prepare(
    `UPDATE workspaces
       SET visibility = ?, updated_at = datetime('now')
       WHERE agent_id = ? AND repo_id = ? AND local_path = ?`,
  ).run(newVisibility, agentId, repoId, localPath);
  return findWorkspace(repoId, agentId, localPath);
}

/**
 * Update visibility on all bindings the calling agent owns for a repo.
 * Returns the number of rows affected.
 */
export function updateAllAgentWorkspacesVisibility(
  repoId: string,
  agentId: string,
  newVisibility: RepoVisibility,
): number {
  const db = getDatabase();
  const result = db.prepare(
    `UPDATE workspaces
       SET visibility = ?, updated_at = datetime('now')
       WHERE agent_id = ? AND repo_id = ?`,
  ).run(newVisibility, agentId, repoId);
  return result.changes;
}

/** Permanently delete a binding. Used by `changed.removed`. */
export function deleteWorkspace(
  repoId: string,
  agentId: string,
  localPath: string,
): boolean {
  const db = getDatabase();
  const result = db.prepare(
    `DELETE FROM workspaces
       WHERE agent_id = ? AND repo_id = ? AND local_path = ?`,
  ).run(agentId, repoId, localPath);
  return result.changes > 0;
}
