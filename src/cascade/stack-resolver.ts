/**
 * Stack-linearity walker.
 *
 * Given a root `cascade_streams.id`, walk parent→child edges (via the
 * `parent_stream_id` foreign key inside `cascade_streams`) and produce the
 * **linear active-subset** of the stack:
 *
 *   - Skip children whose `status` is `merged`, `abandoned`, or `paused` —
 *     merged/abandoned have already integrated upward or been discarded;
 *     `paused` is operator-suspended and explicitly opted out of forward
 *     progress until resumed. `conflicted` stays *in* the walk — it still
 *     represents work-in-progress that needs attention.
 *   - Reject if any node still has more than one active child. A stacked
 *     PR set is by definition linear at the unmerged front; the walker
 *     errors out with `NonLinearStackError` carrying the branching node
 *     + its active children so the UI can show a useful notice.
 *
 * The walker returns the ordered chain plus the (lowest_base, highest_head)
 * SHAs that frame the cumulative diff. `head` is derived per-stream via
 * `getLatestCommitForStream` since `cascade_streams` doesn't denormalize
 * head (see Stream 2 D1 in docs/design/cascade-diff-and-stacked-prs.md).
 *
 * Concurrency: the whole walk runs inside `db.transaction(...)` so all
 * reads share a consistent SQLite snapshot. Without this, a concurrent
 * `handleStreamMerged` / `handleCascadeRebased` landing between
 * `getStreamByRowId(root)` and the children-fanout reads could produce a
 * plan stitched from mixed pre- / post-event state.
 *
 * No cycles: `cascade_streams.parent_stream_id` is the cascade `stream_id`
 * (not the row id) of the parent, which by construction can't form a
 * cycle inside a single swarm. A defensive `seen` guard catches any
 * malformed projection state.
 */

import {
  getStreamByRowId,
  getStreamBySwarmAndId,
  getLatestCommitForStream,
  type CascadeStream,
  type CascadeChange,
} from '../db/dal/cascade-streams.js';
import { getDatabase } from '../db/index.js';

/**
 * Statuses that exclude a node from the active-subset walk.
 * `paused` is treated like terminal for stack semantics — operator-paused
 * streams shouldn't surface in a stack diff or block siblings via fork
 * detection. `conflicted` is deliberately NOT in this set: it represents
 * work-in-progress that still belongs in the chain.
 */
const SKIP_STATUSES = new Set(['merged', 'abandoned', 'paused']);

export interface LinearStackEntry {
  /** Hub row id. */
  stream_row_id: string;
  /** Cascade runtime stream_id. */
  cascade_stream_id: string;
  /** Stream name (for UI). */
  name: string;
  /** Status as of walk time. */
  status: string;
  /** Base commit SHA on this stream (the parent's head when forked). */
  base_commit: string | null;
  /** Most recent commit on this stream, or null if none. */
  head_commit: string | null;
}

export interface LinearStackResult {
  /** The linear chain ordered root→leaf. Includes the root. */
  entries: LinearStackEntry[];
  /** SHA the cumulative range begins at — typically the root's base_commit. */
  lowest_base: string;
  /** SHA the cumulative range ends at — the leaf's head_commit. */
  highest_head: string;
  /** Root stream — used as the cache key for stack-level entries. */
  root: LinearStackEntry;
  /** Leaf (last entry in the chain) — convenience. */
  leaf: LinearStackEntry;
}

export interface NonLinearBranching {
  /** Hub row id of the node with multiple active children. */
  stream_row_id: string;
  /** Cascade stream_id of that node. */
  cascade_stream_id: string;
  /** Active children that prevented linearity. */
  active_children: Array<{
    stream_row_id: string;
    cascade_stream_id: string;
    name: string;
    status: string;
  }>;
}

export class NonLinearStackError extends Error {
  branching: NonLinearBranching;
  constructor(branching: NonLinearBranching) {
    super(
      `Stack is non-linear at ${branching.cascade_stream_id} (${branching.active_children.length} active children)`,
    );
    this.name = 'NonLinearStackError';
    this.branching = branching;
  }
}

export class StackNotFoundError extends Error {
  constructor(streamRowId: string) {
    super(`Stream ${streamRowId} not found`);
    this.name = 'StackNotFoundError';
  }
}

export class StackHasNoCommitsError extends Error {
  cascade_stream_id: string;
  constructor(streamRowId: string, cascade_stream_id: string) {
    super(
      `Leaf stream ${cascade_stream_id} (${streamRowId}) has no commits — nothing to diff`,
    );
    this.name = 'StackHasNoCommitsError';
    this.cascade_stream_id = cascade_stream_id;
  }
}

export class StackHasNoBaseError extends Error {
  cascade_stream_id: string;
  constructor(streamRowId: string, cascade_stream_id: string) {
    super(
      `Root stream ${cascade_stream_id} (${streamRowId}) has no base_commit — nothing to anchor the diff range`,
    );
    this.name = 'StackHasNoBaseError';
    this.cascade_stream_id = cascade_stream_id;
  }
}

// ============================================================================
// Walk
// ============================================================================

/**
 * Resolve the active-subset linear chain starting at a root stream.
 *
 * @throws NonLinearStackError    branching at some node
 * @throws StackNotFoundError     root row id doesn't exist
 * @throws StackHasNoBaseError    root has no base_commit
 * @throws StackHasNoCommitsError leaf has no commits → empty diff range
 */
export function resolveLinearStack(rootRowId: string): LinearStackResult {
  // Snapshot the whole walk so children fan-out is consistent with the
  // root read. `getDatabase()` returns the raw better-sqlite3 Database
  // whose `transaction(fn)` returns a *thunk* that must be invoked — note
  // the trailing `()`. Inner throws propagate (better-sqlite3 rolls back
  // automatically) and the result is returned.
  return getDatabase().transaction(() => doResolveLinearStack(rootRowId))();
}

function doResolveLinearStack(rootRowId: string): LinearStackResult {
  const root = getStreamByRowId(rootRowId);
  if (!root) throw new StackNotFoundError(rootRowId);

  const entries: LinearStackEntry[] = [];
  const seen = new Set<string>(); // by stream_row_id, defensive against cycles

  let cursor: CascadeStream | null = root;
  while (cursor) {
    if (seen.has(cursor.id)) {
      // Cycle in the projection — bail with the same shape as a
      // missing-leaf-commit; the UI can surface "malformed stack".
      throw new StackHasNoCommitsError(cursor.id, cursor.stream_id);
    }
    seen.add(cursor.id);

    const head = getLatestCommitForStream(cursor.id);
    entries.push(entryFor(cursor, head));

    const active = getActiveChildren(cursor);
    if (active.length === 0) break; // leaf reached
    if (active.length > 1) {
      throw new NonLinearStackError({
        stream_row_id: cursor.id,
        cascade_stream_id: cursor.stream_id,
        active_children: active.map((c) => ({
          stream_row_id: c.id,
          cascade_stream_id: c.stream_id,
          name: c.name,
          status: c.status,
        })),
      });
    }
    cursor = active[0];
  }

  const rootEntry = entries[0];
  const leafEntry = entries[entries.length - 1];

  if (!rootEntry.base_commit) {
    throw new StackHasNoBaseError(rootEntry.stream_row_id, rootEntry.cascade_stream_id);
  }
  if (!leafEntry.head_commit) {
    throw new StackHasNoCommitsError(leafEntry.stream_row_id, leafEntry.cascade_stream_id);
  }

  return {
    entries,
    lowest_base: rootEntry.base_commit,
    highest_head: leafEntry.head_commit,
    root: rootEntry,
    leaf: leafEntry,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function entryFor(stream: CascadeStream, head: CascadeChange | null): LinearStackEntry {
  return {
    stream_row_id: stream.id,
    cascade_stream_id: stream.stream_id,
    name: stream.name,
    status: stream.status,
    base_commit: stream.base_commit,
    head_commit: head?.commit_hash ?? null,
  };
}

/**
 * Children of a stream are rows whose `parent_stream_id` equals this
 * stream's `cascade_stream_id` AND whose `source_swarm_id` matches —
 * cascade parent ids are namespaced per swarm, not globally unique.
 */
function getActiveChildren(parent: CascadeStream): CascadeStream[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id, stream_id FROM cascade_streams
       WHERE parent_stream_id = ? AND source_swarm_id = ?`,
    )
    .all(parent.stream_id, parent.source_swarm_id) as Array<{
    id: string;
    stream_id: string;
  }>;

  const out: CascadeStream[] = [];
  for (const row of rows) {
    const child = getStreamBySwarmAndId(parent.source_swarm_id, row.stream_id);
    if (!child) continue;
    if (SKIP_STATUSES.has(child.status)) continue;
    out.push(child);
  }
  return out;
}
