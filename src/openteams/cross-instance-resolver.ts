/**
 * Layer 7 — cross-instance bundle fetch.
 *
 * When an agent asks for an `x-openteams/loadout` or `x-openteams/team` by
 * `sha256:<hex>` and the local bundle store doesn't have it, we may still
 * be able to satisfy the request: mesh sync has already replicated a
 * `syncable_resources` row from a peer instance, possibly with a
 * `git_remote_url` pointing at the canonical repo.
 *
 * Flow on a store miss:
 *
 *   1. List replicated rows of the matching openhive resource_type
 *      (loadout / team_template) whose `origin_instance_id` belongs to a
 *      trusted peer (`federated_instances.is_trusted = 1`). Rows are
 *      ordered `updated_at DESC` so the freshest candidate is tried
 *      first.
 *   2. **Inline pass**: bundle rows that have inline `metadata.content`
 *      first — no filesystem or network. Cheap. The freshly authored
 *      content of a peer is usually still in `metadata.content` even on
 *      git-backed rows (it acts as a transient cache), so this hits the
 *      hot path without paying clone cost.
 *   3. **Git pass**: only after the inline pass exhausts all candidates
 *      do we touch git remotes — lazy-clone via `bundleXxxFromRow` after
 *      promoting rows with a non-local `git_remote_url` to an `ls-remote`
 *      view (inbound replication leaves `sync_strategy` at the schema
 *      default `'metadata'`). Bounded by candidate count.
 *   4. The first row whose bundle hash matches the requested id wins.
 *      Hash mismatch is logged at warn level (signals trusted-but-drifting
 *      peer); on exhaustion we return `null`.
 *
 * Trust is a strict gate, not a soft signal: untrusted peers' rows are
 * filtered out *before* any clone attempt or content rebundling.
 */

import { LOADOUT_RESOURCE_TYPE, TEAM_RESOURCE_TYPE } from 'openteams';
import type { LoadoutResource, MAPResource, TeamResource } from 'openteams';

import { getDatabase } from '../db/index.js';
import { findInstanceById } from '../db/dal/instances.js';
import type { SyncableResource, SyncStrategy } from '../types.js';
import {
  bundleLoadoutFromRow,
  bundleTeamTemplateFromRow,
} from './internal/bundle-content.js';

/** Local resource_type values that map to openteams MAP kinds. */
type OpenteamsResourceType = 'loadout' | 'team_template';

function mapKindToResourceType(kind: string): OpenteamsResourceType | null {
  if (kind === LOADOUT_RESOURCE_TYPE) return 'loadout';
  if (kind === TEAM_RESOURCE_TYPE) return 'team_template';
  return null;
}

/**
 * Inbound replication sets `sync_strategy` to the schema default
 * (`'metadata'`) because the mesh payload doesn't carry the strategy.
 * For a row whose `git_remote_url` is a real remote, return a shallow
 * copy with `sync_strategy: 'ls-remote'` so `bundleXxxFromRow` takes the
 * git-checkout path. Otherwise return the row unchanged.
 */
function promoteGitBacked(row: SyncableResource): SyncableResource {
  const url = row.git_remote_url ?? '';
  if (!url || url.startsWith('local://')) return row;
  if (row.sync_strategy === 'ls-remote') return row;
  return { ...row, sync_strategy: 'ls-remote' as SyncStrategy };
}

/**
 * Hydrate one DB row into a `SyncableResource`. `origin_instance_id`
 * lives on the column but not on the TS interface; the caller carries
 * it alongside the row when it needs the trust gate.
 */
function rowToResource(row: Record<string, unknown>): SyncableResource {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata as string);
    } catch {
      /* swallow — treat as no inline content */
    }
  }
  return {
    id: row.id as string,
    resource_type: row.resource_type as SyncableResource['resource_type'],
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    git_remote_url: (row.git_remote_url as string | null) ?? '',
    webhook_secret: (row.webhook_secret as string | null) ?? null,
    visibility: row.visibility as SyncableResource['visibility'],
    last_commit_hash: (row.last_commit_hash as string | null) ?? null,
    last_push_by: (row.last_push_by as string | null) ?? null,
    last_push_at: (row.last_push_at as string | null) ?? null,
    owner_agent_id: row.owner_agent_id as string,
    scope: row.scope as SyncableResource['scope'],
    sync_strategy: ((row.sync_strategy as SyncStrategy | null) ?? 'metadata'),
    local_path: (row.local_path as string | null) ?? null,
    metadata,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string) ?? row.created_at as string,
  };
}

interface CrossInstanceCandidate {
  row: SyncableResource;
  originInstanceId: string;
  hasInlineContent: boolean;
}

/** Does the row carry `metadata.content`? Used to split inline vs git pass. */
function hasInlineContent(row: SyncableResource): boolean {
  const content = (row.metadata as { content?: unknown } | null)?.content;
  return content !== undefined && content !== null;
}

/**
 * Return all replicated (`origin_instance_id != NULL`) rows of the given
 * resource_type whose origin peer is trusted. Rows from untrusted peers
 * are filtered out *before* any clone attempt — trust is a precondition
 * for touching the remote. Ordered `updated_at DESC, created_at DESC` so
 * the freshest authored version is tried first.
 */
function listCandidateRows(
  resourceType: OpenteamsResourceType,
): CrossInstanceCandidate[] {
  let db;
  try {
    db = getDatabase();
  } catch {
    // Resolver is opt-in: if the surrounding test (or boot-time probe)
    // didn't initialize the DB, treat it as "no candidates" rather than
    // propagating. Restores the pre-Layer-7 store-miss semantics where
    // a miss just returned null. We log at debug rather than warn since
    // this is the expected state in many unit tests.
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[openteams] cross-instance resolver: database not initialized');
    }
    return [];
  }
  const rawRows = db
    .prepare(
      `SELECT * FROM syncable_resources
       WHERE resource_type = ? AND origin_instance_id IS NOT NULL
       ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC`,
    )
    .all(resourceType) as Record<string, unknown>[];

  const out: CrossInstanceCandidate[] = [];
  for (const raw of rawRows) {
    const originInstanceId = raw.origin_instance_id as string | null;
    if (!originInstanceId) continue;
    const instance = findInstanceById(originInstanceId);
    if (!instance?.is_trusted) continue;
    const row = rowToResource(raw);
    out.push({ row, originInstanceId, hasInlineContent: hasInlineContent(row) });
  }
  return out;
}

/**
 * Bundle a candidate row via the inline path *only* (no git clone). Used
 * for the cheap first pass. Returns null if the row lacks inline content
 * — caller falls through to the git pass.
 */
async function bundleInline(
  resourceType: OpenteamsResourceType,
  row: SyncableResource,
): Promise<LoadoutResource | TeamResource | null> {
  // Force metadata-strategy view so `bundleXxxFromRow` always takes the
  // in-memory path even if the row carries a real git remote.
  const inlineView: SyncableResource = { ...row, sync_strategy: 'metadata' };
  return resourceType === 'loadout'
    ? bundleLoadoutFromRow(inlineView)
    : bundleTeamTemplateFromRow(inlineView);
}

/**
 * Bundle a candidate row via the git path — clones if needed. Used for
 * the second, expensive pass.
 */
async function bundleGit(
  resourceType: OpenteamsResourceType,
  row: SyncableResource,
): Promise<LoadoutResource | TeamResource | null> {
  const promoted = promoteGitBacked(row);
  return resourceType === 'loadout'
    ? bundleLoadoutFromRow(promoted)
    : bundleTeamTemplateFromRow(promoted);
}

/**
 * Common per-candidate flow: bundle → verify hash → return on match.
 * Hash mismatches are logged at warn (signals a trusted-but-drifting
 * peer); errors are logged and skipped.
 */
async function tryCandidate(
  resourceType: OpenteamsResourceType,
  row: SyncableResource,
  expectedId: string,
  bundler: (rt: OpenteamsResourceType, r: SyncableResource) => Promise<LoadoutResource | TeamResource | null>,
): Promise<MAPResource | null> {
  try {
    const bundle = await bundler(resourceType, row);
    if (!bundle) return null;
    if (bundle.id !== expectedId) {
      console.warn(
        `[openteams] cross-instance hash mismatch for ${resourceType} row ${row.id}: ` +
          `requested ${expectedId}, rebundle produced ${bundle.id}`,
      );
      return null;
    }
    return bundle as unknown as MAPResource;
  } catch (err) {
    console.warn(
      `[openteams] cross-instance resolve failed for ${resourceType} row ${row.id}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Try to resolve `(kind, hash)` cross-instance. Returns the resolved
 * bundle on hit (caller is responsible for `put`-ing into the store),
 * or `null` on miss.
 *
 * Two-pass strategy: cheap inline-content rebundles first, then git
 * clones. This avoids paying network cost when a peer's `metadata.content`
 * blob already hashes to the requested id — common because mesh sync
 * replicates the inline content alongside the row.
 */
export async function tryCrossInstanceResolve(
  kind: string,
  id: string,
): Promise<MAPResource | null> {
  const resourceType = mapKindToResourceType(kind);
  if (!resourceType) return null;

  const candidates = listCandidateRows(resourceType);
  if (candidates.length === 0) return null;

  // Pass 1: inline content (cheap, no IO).
  for (const candidate of candidates) {
    if (!candidate.hasInlineContent) continue;
    const hit = await tryCandidate(resourceType, candidate.row, id, bundleInline);
    if (hit) return hit;
  }

  // Pass 2: git-backed (lazy clone). Skip rows that are pure-inline (no
  // git remote, or local://) — they've already been tried in pass 1.
  for (const candidate of candidates) {
    const url = candidate.row.git_remote_url ?? '';
    if (!url || url.startsWith('local://')) continue;
    const hit = await tryCandidate(resourceType, candidate.row, id, bundleGit);
    if (hit) return hit;
  }

  return null;
}
