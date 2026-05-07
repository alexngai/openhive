/**
 * Repo DAL — federated repo resources stored in the existing `syncable_resources`
 * table with `resource_type = 'repo'`. The federation key is the canonical
 * git remote URL (stored in `git_remote_url`).
 *
 * The package-level `RepoVisibility` ('private' | 'hub_local' | 'federated')
 * is independent of `syncable_resources.visibility` ('private' | 'shared' |
 * 'public') — the former lives in `metadata.visibility` for repos. The
 * column-level visibility is set to 'private' on insert and is not consulted
 * by the repo kind; it stays for back-compat with shared infrastructure.
 *
 * See `docs/design/repos-as-syncable-resources.md` for the consumer-side
 * design and `repo-kind.md` for the package-side protocol.
 */

import { nanoid } from 'nanoid';
import {
  canonicalizeRepoUrl,
  type CanonicalRepoIdentity,
} from 'agent-workspace/kinds/repo';
import type { RepoVisibility } from 'agent-workspace/protocol/repo';
import { getDatabase } from '../index.js';
import type { SyncableResource } from '../../types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Per-repo metadata stored in `syncable_resources.metadata` for `resource_type='repo'`.
 *
 * - `origin` distinguishes how the resource came into being.
 * - `visibility` is the repo kind's visibility tier (independent of column-level
 *   `visibility`).
 * - `branches` is a tracked branch index (default branch + named-of-interest);
 *   updated by the changed-handler when branches move.
 * - `merged_into` is set when this resource has been merged into another
 *   (`status` is independently set to `merged_into` on the resource).
 */
export interface RepoMetadata {
  name: string;
  default_branch?: string;
  description?: string;
  branches?: Array<{ name: string; head_sha: string; last_seen: string }>;
  origin: 'user_defined' | 'agent_declared' | 'trajectory_inferred';
  visibility: RepoVisibility;
  binding_policy?: 'open' | 'closed';
  merged_into?: string;
}

export interface RepoUpsertDefaults {
  origin: RepoMetadata['origin'];
  visibility?: RepoVisibility;
  name?: string;
  default_branch?: string;
  description?: string;
  binding_policy?: RepoMetadata['binding_policy'];
  /** Owner agent for the syncable_resources row. Required on first insert. */
  owner_agent_id: string;
}

export interface ListReposFilter {
  origin?: RepoMetadata['origin'];
  visibility?: RepoVisibility;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface SyncableResourceRow {
  id: string;
  resource_type: string;
  name: string;
  description: string | null;
  git_remote_url: string;
  webhook_secret: string | null;
  visibility: string;
  last_commit_hash: string | null;
  last_push_by: string | null;
  last_push_at: string | null;
  owner_agent_id: string;
  scope: string;
  sync_strategy: string;
  local_path: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  status: string | null;
}

function rowToResource(row: SyncableResourceRow): SyncableResource {
  return {
    id: row.id,
    resource_type: row.resource_type as SyncableResource['resource_type'],
    name: row.name,
    description: row.description,
    git_remote_url: row.git_remote_url,
    webhook_secret: row.webhook_secret,
    visibility: row.visibility as SyncableResource['visibility'],
    last_commit_hash: row.last_commit_hash,
    last_push_by: row.last_push_by,
    last_push_at: row.last_push_at,
    owner_agent_id: row.owner_agent_id,
    scope: row.scope as SyncableResource['scope'],
    sync_strategy: row.sync_strategy as SyncableResource['sync_strategy'],
    local_path: row.local_path,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: (row.status as SyncableResource['status']) ?? 'active',
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upsert a repo resource by its canonical URL. If a repo with the same
 * canonical URL exists, returns it; otherwise creates a new row.
 *
 * On existing-row return: does NOT overwrite `origin` (origin is set once at
 * creation) but does merge other defaults into `metadata` if absent.
 */
export function upsertRepoByCanonicalUrl(
  identity: CanonicalRepoIdentity,
  defaults: RepoUpsertDefaults,
): SyncableResource {
  const db = getDatabase();
  const existing = findRepoByCanonicalUrl(identity.canonicalUrl);
  if (existing) {
    // Merge defaults into metadata if missing — never overwrite `origin`.
    const meta = (existing.metadata ?? {}) as Partial<RepoMetadata>;
    const merged: RepoMetadata = {
      name: meta.name ?? defaults.name ?? identity.name,
      origin: meta.origin ?? defaults.origin,
      visibility: meta.visibility ?? defaults.visibility ?? 'hub_local',
      ...(meta.default_branch !== undefined || defaults.default_branch !== undefined
        ? { default_branch: meta.default_branch ?? defaults.default_branch }
        : {}),
      ...(meta.description !== undefined || defaults.description !== undefined
        ? { description: meta.description ?? defaults.description }
        : {}),
      ...(meta.binding_policy !== undefined || defaults.binding_policy !== undefined
        ? { binding_policy: meta.binding_policy ?? defaults.binding_policy }
        : {}),
      ...(meta.branches !== undefined ? { branches: meta.branches } : {}),
      ...(meta.merged_into !== undefined ? { merged_into: meta.merged_into } : {}),
    };
    db.prepare(
      `UPDATE syncable_resources
         SET metadata = ?, updated_at = datetime('now')
         WHERE id = ?`,
    ).run(JSON.stringify(merged), existing.id);
    return findRepoById(existing.id)!;
  }

  // Insert new repo.
  const id = `repo_${nanoid()}`;
  const meta: RepoMetadata = {
    name: defaults.name ?? identity.name,
    origin: defaults.origin,
    visibility: defaults.visibility ?? 'hub_local',
    ...(defaults.default_branch !== undefined ? { default_branch: defaults.default_branch } : {}),
    ...(defaults.description !== undefined ? { description: defaults.description } : {}),
    ...(defaults.binding_policy !== undefined ? { binding_policy: defaults.binding_policy } : {}),
  };

  db.prepare(`
    INSERT INTO syncable_resources (
      id, resource_type, name, description, git_remote_url, visibility,
      owner_agent_id, scope, sync_strategy, metadata
    ) VALUES (?, 'repo', ?, ?, ?, 'private', ?, 'manual', 'metadata', ?)
  `).run(
    id,
    meta.name,
    defaults.description ?? null,
    identity.canonicalUrl,
    defaults.owner_agent_id,
    JSON.stringify(meta),
  );

  return findRepoById(id)!;
}

/** Find a repo by its canonical URL. */
export function findRepoByCanonicalUrl(canonicalUrl: string): SyncableResource | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT * FROM syncable_resources
       WHERE resource_type = 'repo' AND git_remote_url = ?
       LIMIT 1`,
  ).get(canonicalUrl) as SyncableResourceRow | undefined;
  return row ? rowToResource(row) : null;
}

/** Find a repo by its row id. */
export function findRepoById(id: string): SyncableResource | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT * FROM syncable_resources WHERE id = ? AND resource_type = 'repo'`,
  ).get(id) as SyncableResourceRow | undefined;
  return row ? rowToResource(row) : null;
}

/** List repo resources, optionally filtered by metadata fields. */
export function listRepos(filter: ListReposFilter = {}): SyncableResource[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT * FROM syncable_resources WHERE resource_type = 'repo' ORDER BY created_at DESC`,
  ).all() as SyncableResourceRow[];

  return rows
    .map(rowToResource)
    .filter((r) => {
      const meta = r.metadata as Partial<RepoMetadata> | null;
      if (filter.origin !== undefined && meta?.origin !== filter.origin) return false;
      if (filter.visibility !== undefined && meta?.visibility !== filter.visibility) return false;
      return true;
    });
}

/**
 * Update a repo's visibility (in metadata). Returns whether the change
 * requires emitting a `resource.redacted` mesh event (i.e., transition out
 * of `federated`). Caller is responsible for emitting.
 */
export function updateRepoVisibility(
  id: string,
  newVisibility: RepoVisibility,
): { requires_redaction: boolean } {
  const db = getDatabase();
  const repo = findRepoById(id);
  if (!repo) throw new Error(`Repo not found: ${id}`);

  const meta = (repo.metadata ?? {}) as Partial<RepoMetadata>;
  const oldVisibility = meta.visibility ?? 'hub_local';

  if (oldVisibility === newVisibility) {
    return { requires_redaction: false };
  }

  const updated: RepoMetadata = {
    ...meta,
    name: meta.name ?? '',
    origin: meta.origin ?? 'agent_declared',
    visibility: newVisibility,
  } as RepoMetadata;

  db.prepare(
    `UPDATE syncable_resources
       SET metadata = ?, updated_at = datetime('now')
       WHERE id = ?`,
  ).run(JSON.stringify(updated), id);

  return { requires_redaction: oldVisibility === 'federated' };
}

/**
 * Convenience: upsert from a raw remote URL. Canonicalizes via the package's
 * `canonicalizeRepoUrl` and forwards to `upsertRepoByCanonicalUrl`.
 */
export function upsertRepoFromRemoteUrl(
  remoteUrl: string,
  defaults: RepoUpsertDefaults,
): SyncableResource {
  const identity = canonicalizeRepoUrl(remoteUrl);
  return upsertRepoByCanonicalUrl(identity, defaults);
}
