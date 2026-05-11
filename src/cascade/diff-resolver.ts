/**
 * Cascade diff resolver — five-tier fetch.
 *
 *   1. cache hit            → cascade_diff_cache.getDiff (touches access)
 *   2. presence + capability gate → swarm connected + cascade.canServeDiff
 *   3. on-demand via MAP    → sendDiffRequest (S1.8 — currently stubbed)
 *   4. timeout              → 60s wait surface as DiffError 'timeout'
 *   5. write-through cache  → putDiff on success
 *
 * Tiers 1, 2, and 5 are wired here. Tiers 3 and 4 delegate to a pluggable
 * `MapDiffFetcher` so the resolver can be tested end-to-end (REST + cache)
 * before the MAP protocol lands in S1.8. The default fetcher returns
 * `not_implemented` until S1.8 swaps in the real one.
 *
 * Design: docs/design/cascade-diff-and-stacked-prs.md
 */

import {
  getStreamByRowId,
  getLatestCommitForStream,
  type CascadeStream,
} from '../db/dal/cascade-streams.js';
import * as cache from '../db/dal/cascade-diff-cache.js';
import { getInbound, hasCapability } from '../map/connection-registry.js';
import WebSocket from 'ws';
import type {
  DiffError,
  DiffPayload,
  DiffResult,
} from './diff-types.js';
import {
  resolveLinearStack,
  NonLinearStackError,
  StackNotFoundError,
  StackHasNoBaseError,
  StackHasNoCommitsError,
  type LinearStackResult,
} from './stack-resolver.js';

const CAPABILITY_PATH = 'cascade.canServeDiff';

// ============================================================================
// MapDiffFetcher — swappable transport for tiers 3/4
// ============================================================================

export interface MapDiffFetchArgs {
  swarmId: string;
  stream_id: string;
  head: string;
  base?: string;
  file_paths?: string[];
  files_only?: boolean;
}

export interface MapDiffFetcher {
  fetch(args: MapDiffFetchArgs): Promise<DiffResult>;
}

let fetcher: MapDiffFetcher = {
  // Default — replaced in S1.8 when the MAP protocol lands.
  // Returns a DiffError so REST + cache wiring is testable today.
  async fetch(): Promise<DiffResult> {
    return {
      ok: false,
      error: {
        code: 'internal',
        message:
          'cascade diff MAP protocol not yet wired (S1.8); resolver returned stub',
      },
    };
  },
};

/**
 * Replace the on-demand fetcher. Called by S1.8 (the MAP protocol module)
 * once it boots, and by tests to inject a fake.
 */
export function setMapDiffFetcher(next: MapDiffFetcher): void {
  fetcher = next;
}

/** Read-only access (test helper / introspection). */
export function getMapDiffFetcher(): MapDiffFetcher {
  return fetcher;
}

// ============================================================================
// Resolve a single commit diff
// ============================================================================

export interface ResolveDiffInput {
  /** cascade_streams.id (hub row id), not the runtime stream_id. */
  stream_row_id: string;
  /** Head commit SHA. */
  commit_hash: string;
  /** Optional base SHA for ranged diffs. */
  base_hash?: string;
  /** Optional path scope. NULL = whole commit. */
  file_path?: string;
  /** D17 — skip blob; resolver also bypasses cache when set. */
  files_only?: boolean;
}

export async function resolveCommitDiff(
  input: ResolveDiffInput
): Promise<DiffResult> {
  const stream = getStreamByRowId(input.stream_row_id);
  if (!stream) {
    return err('not_found', `stream ${input.stream_row_id} not found`);
  }

  // Tier 1: cache hit (skipped for files_only — see D17).
  if (!input.files_only) {
    const cached = cache.getDiff({
      stream_id: stream.stream_id,
      commit_hash: input.commit_hash,
      base_hash: input.base_hash ?? null,
      file_path: input.file_path ?? null,
    });
    if (cached) {
      return {
        ok: true,
        payload: {
          diff: cached.diff_blob,
          files_touched: cached.files_touched,
          truncated: false,
        },
      };
    }
  }

  // Tier 2: presence + capability gate.
  const gate = checkPresenceAndCapability(stream);
  if (!gate.ok) return gate;

  // Tier 3 + 4: on-demand fetch via MAP. Timeout is the fetcher's
  // responsibility; here we just await and pass through.
  const fetched = await fetcher.fetch({
    swarmId: stream.source_swarm_id,
    stream_id: stream.stream_id,
    head: input.commit_hash,
    base: input.base_hash,
    file_paths: input.file_path ? [input.file_path] : undefined,
    files_only: input.files_only,
  });

  if (!fetched.ok) return fetched;

  // Tier 5: write-through cache. files_only payloads are not cached —
  // name-only output is cheap to recompute and the cache key doesn't
  // distinguish files-only from full blobs.
  if (!input.files_only) {
    try {
      cache.putDiff({
        stream_id: stream.stream_id,
        commit_hash: input.commit_hash,
        base_hash: input.base_hash ?? null,
        file_path: input.file_path ?? null,
        diff_blob: fetched.payload.diff,
        files_touched: fetched.payload.files_touched,
      });
    } catch {
      // Non-fatal — return the fresh payload even if cache write fails.
    }
  }

  return fetched;
}

// ============================================================================
// Helpers
// ============================================================================

function checkPresenceAndCapability(
  stream: CascadeStream
): { ok: true } | { ok: false; error: DiffError } {
  const conn = getInbound(stream.source_swarm_id);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
    return {
      ok: false,
      error: {
        code: 'swarm_offline',
        message: `swarm ${stream.source_swarm_id} is not connected`,
      },
    };
  }
  if (!hasCapability(stream.source_swarm_id, CAPABILITY_PATH)) {
    return {
      ok: false,
      error: {
        code: 'capability_missing',
        message: `swarm ${stream.source_swarm_id} does not declare ${CAPABILITY_PATH}`,
      },
    };
  }
  return { ok: true };
}

function err(code: DiffError['code'], message: string): DiffResult {
  return { ok: false, error: { code, message } };
}

// ============================================================================
// Stream-level diff (cumulative across one stream — base_commit..head)
// ============================================================================

export interface ResolveStreamDiffInput {
  /** cascade_streams.id (hub row id), not the runtime stream_id. */
  stream_row_id: string;
  /** Optional path scope. NULL = whole range. */
  file_path?: string;
  /** D17 — skip blob; resolver also bypasses cache when set. */
  files_only?: boolean;
}

/**
 * Resolve the cumulative diff for a single stream — `base_commit..head`,
 * where `head` is the most-recent commit on the stream (derived per Stream
 * 2 D1, no schema denormalization).
 *
 * Errors:
 *   - not_found     stream row doesn't exist
 *   - bad_request   stream has no base_commit or no commits
 */
export async function resolveStreamDiff(
  input: ResolveStreamDiffInput,
): Promise<DiffResult> {
  const stream = getStreamByRowId(input.stream_row_id);
  if (!stream) {
    return err('not_found', `stream ${input.stream_row_id} not found`);
  }
  if (!stream.base_commit) {
    return err(
      'bad_request',
      `stream ${stream.stream_id} has no base_commit — nothing to anchor the diff range`,
    );
  }
  const head = getLatestCommitForStream(stream.id);
  if (!head) {
    return err(
      'bad_request',
      `stream ${stream.stream_id} has no commits — nothing to diff`,
    );
  }

  return rangeDiff({
    stream,
    cacheStreamId: stream.stream_id,
    base: stream.base_commit,
    head: head.commit_hash,
    file_path: input.file_path,
    files_only: input.files_only,
  });
}

// ============================================================================
// Stack-level diff (cumulative across a linear stack — lowest_base..highest_head)
// ============================================================================

export interface ResolveStackDiffInput {
  /** cascade_streams.id (hub row id) of the stack root. */
  stack_root_row_id: string;
  file_path?: string;
  files_only?: boolean;
}

/**
 * Resolve the cumulative diff across a linear active-subset stack rooted
 * at `stack_root_row_id`. Walker rejects branching stacks via
 * `NonLinearStackError`; we translate it to a typed `DiffResult` so the
 * REST surface can map a single error union to HTTP statuses.
 *
 * Cache key uses the **root** stream's `stream_id` so stack-diff rows are
 * collocated with the root and get evicted when the root closes.
 */
export async function resolveStackDiff(
  input: ResolveStackDiffInput,
): Promise<DiffResult & { stack?: LinearStackResult }> {
  let stack: LinearStackResult;
  try {
    stack = resolveLinearStack(input.stack_root_row_id);
  } catch (e) {
    if (e instanceof NonLinearStackError) {
      return {
        ok: false,
        error: {
          code: 'bad_request',
          message: `non_linear_stack: ${e.message}`,
        },
      };
    }
    if (e instanceof StackNotFoundError) {
      return err('not_found', e.message);
    }
    if (e instanceof StackHasNoBaseError || e instanceof StackHasNoCommitsError) {
      return err('bad_request', e.message);
    }
    return err('internal', (e as Error).message);
  }

  // Walker guarantees lowest_base + highest_head are non-null when it returns.
  const rootStream = getStreamByRowId(stack.root.stream_row_id);
  if (!rootStream) {
    return err('not_found', `stack root ${stack.root.stream_row_id} not found`);
  }

  const result = await rangeDiff({
    stream: rootStream,
    cacheStreamId: stack.root.cascade_stream_id,
    base: stack.lowest_base,
    head: stack.highest_head,
    file_path: input.file_path,
    files_only: input.files_only,
  });
  // Surface the linear stack shape so the REST layer can echo it back —
  // useful for the file-tree UI to know which streams contributed.
  return { ...result, stack };
}

// ============================================================================
// Shared range-diff plumbing (used by stream + stack resolvers)
// ============================================================================

interface RangeDiffArgs {
  stream: CascadeStream;
  /** Used as the cache key's stream_id. For stack diffs, the root stream's id. */
  cacheStreamId: string;
  base: string;
  head: string;
  file_path?: string;
  files_only?: boolean;
}

async function rangeDiff(args: RangeDiffArgs): Promise<DiffResult> {
  // Tier 1: cache (skipped for files_only — see D17).
  if (!args.files_only) {
    const cached = cache.getDiff({
      stream_id: args.cacheStreamId,
      commit_hash: args.head,
      base_hash: args.base,
      file_path: args.file_path ?? null,
    });
    if (cached) {
      return {
        ok: true,
        payload: {
          diff: cached.diff_blob,
          files_touched: cached.files_touched,
          truncated: false,
        },
      };
    }
  }

  // Tier 2: presence + capability.
  const gate = checkPresenceAndCapability(args.stream);
  if (!gate.ok) return gate;

  // Tier 3 + 4: fetch via MAP.
  const fetched = await fetcher.fetch({
    swarmId: args.stream.source_swarm_id,
    stream_id: args.stream.stream_id,
    head: args.head,
    base: args.base,
    file_paths: args.file_path ? [args.file_path] : undefined,
    files_only: args.files_only,
  });

  if (!fetched.ok) return fetched;

  // Tier 5: write-through.
  if (!args.files_only) {
    try {
      cache.putDiff({
        stream_id: args.cacheStreamId,
        commit_hash: args.head,
        base_hash: args.base,
        file_path: args.file_path ?? null,
        diff_blob: fetched.payload.diff,
        files_touched: fetched.payload.files_touched,
      });
    } catch {
      // Non-fatal.
    }
  }

  return fetched;
}

/** Re-export for tests that want to assert on the payload shape. */
export type { DiffPayload, DiffError, DiffResult };
export type { LinearStackResult } from './stack-resolver.js';
