/**
 * Stack-of-PRs walker.
 *
 * Given a `cascade_streams.id` root, descend `parent_stream_id` edges and
 * build a parent-before-child plan suitable for opening one PR per stream.
 * Unlike Stream 2's `stack-resolver.ts` (which requires a linear chain for
 * cumulative-diff semantics), this walker accepts branching trees: stacked
 * PRs naturally fan out, with each leaf becoming its own PR sharing an
 * ancestor base (D20).
 *
 * Per-entry base resolution mirrors how Graphite / Spr / `gh stack` resolve
 * stacked-PR bases:
 *
 *   parent.publish_branch  // explicit alias, set via /pr endpoint or
 *                          // PATCH /streams/:id/branch
 *   ?? parent.branch_name  // runtime branch (typically `stream/<id>`)
 *   ?? swarm.metadata.trunk_branch
 *   ?? 'main'
 *
 * The root entry's base = trunk (no parent in the plan).
 *
 * Each plan entry carries a `lineage_id` — the stream_row_id of its
 * branching ancestor (root for entries that share a parent only at the
 * root, the fork node otherwise). The route uses this to propagate
 * `push_required → blocked_by_parent` correctly when parallel branches
 * exist: a missing branch on one fork doesn't block siblings (D18, D20).
 *
 * Skip-statuses (`merged`, `abandoned`, `paused`) are filtered out — we
 * still descend *through* them (in case live children exist below), and
 * base/ancestor resolution treats them as transparent: a paused mid-stack
 * stream collapses out of the plan, and its live descendants base on the
 * next-up live ancestor (or trunk). `conflicted` stays in the plan — it
 * represents work-in-progress that the operator may still want to push.
 *
 * Concurrency: the entire walk runs inside `db.transaction(...)` so the
 * children index and the per-node reads share one consistent snapshot.
 * A concurrent `handleStreamMerged` / `handleCascadeRebased` event landing
 * mid-walk can't produce a plan stitched from mixed projection states.
 */

import {
  getStreamByRowId,
  defaultPublishBranch,
  type CascadeStream,
} from '../db/dal/cascade-streams.js';
import { findSwarmById } from '../db/dal/map.js';
import { getDatabase } from '../db/index.js';

/**
 * Statuses skipped (collapsed out) in the plan. `paused` joins
 * `merged`/`abandoned`: operator-paused streams are explicitly out of
 * forward progress, so they shouldn't appear as PR candidates and their
 * live descendants should base on the next live ancestor up (D-paused).
 * `conflicted` stays out of this set — those streams still need attention
 * and may still be pushable.
 */
const SKIP_STATUSES = new Set(['merged', 'abandoned', 'paused']);
const DEFAULT_TRUNK = 'main';

export interface PRStackEntry {
  /** cascade_streams.id (hub row id). */
  stream_row_id: string;
  /** Cascade runtime stream id. */
  cascade_stream_id: string;
  /** Human stream name (for UI). */
  name: string;
  /** Current status of the stream at walk time. */
  status: string;
  /** PR `head` — branch on origin that holds this stream's commits. */
  head_branch: string;
  /** PR `base` — typically the parent's head_branch, or trunk for the root. */
  base_branch: string;
  /**
   * The chain of `stream_row_id`s from the walk root down to (but not
   * including) this entry. Empty for the root itself. The route uses
   * this for D18 `blocked_by_parent` propagation: an entry is blocked
   * iff any of its ancestors hit `push_required`. This replaces the
   * earlier `lineage_id`, which collapsed fork siblings into a single
   * "lineage" but missed root-with-immediate-fork cases (per code
   * review 2026-05-11).
   */
  ancestor_row_ids: string[];
}

export interface PRStackPlanResult {
  /** Toposorted entries: parent appears before any of its descendants. */
  entries: PRStackEntry[];
  /** Trunk branch resolved for the swarm (echoed for UI / debugging). */
  trunk: string;
}

export class PRStackRootNotFoundError extends Error {
  constructor(streamRowId: string) {
    super(`Stream ${streamRowId} not found`);
    this.name = 'PRStackRootNotFoundError';
  }
}

// ============================================================================
// buildPRStackPlan
// ============================================================================

export function buildPRStackPlan(rootRowId: string): PRStackPlanResult {
  // Snapshot the whole walk so children fan-out, trunk lookup, and the
  // root read all share one SQLite read-view. Without this, a concurrent
  // cascade event (`stream.merged`, `cascade.rebased`) landing mid-walk
  // could produce a plan stitched from mixed projection states.
  return getDatabase().transaction(() => doBuildPRStackPlan(rootRowId))();
}

function doBuildPRStackPlan(rootRowId: string): PRStackPlanResult {
  const root = getStreamByRowId(rootRowId);
  if (!root) throw new PRStackRootNotFoundError(rootRowId);

  const trunk = resolveTrunkBranch(root.source_swarm_id);

  // Pre-fetch the children-by-parent index for the swarm so the DFS doesn't
  // hit the DB once per node. cascade `parent_stream_id` references the
  // cascade `stream_id` (not row id), and is unique only within a swarm.
  const childrenByParentStreamId = buildChildrenIndex(root.source_swarm_id);

  // Memoized predicate: does `node` itself contribute to the plan, or
  // does any of its descendants (transitively, walking past terminal
  // nodes)? Used both for fork detection (a child counts as a topology
  // branch iff it leads to at least one live entry) and to skip dead
  // sub-trees from descent.
  const leadsToLiveCache = new Map<string, boolean>();
  function leadsToLive(node: CascadeStream): boolean {
    const cached = leadsToLiveCache.get(node.id);
    if (cached !== undefined) return cached;
    if (!SKIP_STATUSES.has(node.status)) {
      leadsToLiveCache.set(node.id, true);
      return true;
    }
    const children = childrenByParentStreamId.get(node.stream_id) ?? [];
    const result = children.some(leadsToLive);
    leadsToLiveCache.set(node.id, result);
    return result;
  }

  const entries: PRStackEntry[] = [];

  // DFS so each parent lands before its descendants — standard toposort
  // for a DAG with parent→child edges. Cycle defense via `visited` is
  // belt-and-suspenders; parent_stream_id can't cycle by construction.
  const visited = new Set<string>();

  function descend(
    node: CascadeStream,
    parentEntry: PRStackEntry | null,
    /** Chain of stream_row_ids from root to this node's parent (inclusive). */
    ancestors: string[],
  ): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    const allChildren = childrenByParentStreamId.get(node.stream_id) ?? [];
    // Children that will eventually emit at least one entry. A merged
    // child with live grandchildren still "counts" for topology — its
    // grandchildren take its place in the plan, treating the merged
    // node as transparent (effectively collapsed out).
    const productiveChildren = allChildren.filter(leadsToLive);

    if (SKIP_STATUSES.has(node.status)) {
      // Skip this node in the plan, but walk through it. parent_entry
      // and ancestors pass through unchanged — the merged node is
      // transparent for both base resolution and blocking propagation.
      for (const child of productiveChildren) {
        descend(child, parentEntry, ancestors);
      }
      return;
    }

    // Live node — emit an entry.
    const head = node.publish_branch ?? defaultPublishBranch(node.name);
    const base = parentEntry?.head_branch ?? trunk;
    const entry: PRStackEntry = {
      stream_row_id: node.id,
      cascade_stream_id: node.stream_id,
      name: node.name,
      status: node.status,
      head_branch: head,
      base_branch: base,
      ancestor_row_ids: ancestors,
    };
    entries.push(entry);

    // Children inherit this entry as their ancestor + this entry's row id
    // appended to the chain.
    const childAncestors = [...ancestors, node.id];
    for (const child of productiveChildren) {
      descend(child, entry, childAncestors);
    }
  }

  // Root has an empty ancestor list — it's the root of the walk regardless
  // of whether parent_stream_id exists above it (the caller asked for
  // descendants of THIS row specifically).
  descend(root, null, []);

  return { entries, trunk };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Index `parent_stream_id → CascadeStream[]` for a single swarm. The
 * walker needs to look up children many times; this trades one big query
 * for N point queries.
 */
function buildChildrenIndex(swarmId: string): Map<string, CascadeStream[]> {
  const db = getDatabase();
  const rows = db
    .prepare<[string], CascadeStream & { metadata: unknown }>(
      `SELECT id, stream_id, source_swarm_id, source_agent_id, parent_stream_id,
              name, branch_name, base_commit, status, is_local_mode,
              task_resource_id, task_node_id, metadata, publish_branch,
              opened_at, last_event_at, closed_at
         FROM cascade_streams
        WHERE source_swarm_id = ?`,
    )
    .all(swarmId);

  const out = new Map<string, CascadeStream[]>();
  for (const r of rows) {
    if (!r.parent_stream_id) continue;
    const list = out.get(r.parent_stream_id) ?? [];
    list.push({
      ...r,
      // `metadata` arrives as a JSON string from SQLite — DAL helpers
      // parse it elsewhere. The walker doesn't read metadata, so the
      // bare string is fine; downstream consumers go through
      // `getStreamByRowId` for typed access.
      metadata:
        typeof r.metadata === 'string'
          ? safeJsonParse(r.metadata)
          : (r.metadata as Record<string, unknown> | null),
      is_local_mode: r.is_local_mode ? true : false,
    });
    out.set(r.parent_stream_id, list);
  }
  return out;
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Resolve trunk branch from `findSwarmById(swarmId).metadata.trunk_branch`. */
function resolveTrunkBranch(swarmId: string): string {
  const swarm = findSwarmById(swarmId);
  if (!swarm?.metadata) return DEFAULT_TRUNK;
  const meta = swarm.metadata as Record<string, unknown>;
  const candidate = meta.trunk_branch;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : DEFAULT_TRUNK;
}
