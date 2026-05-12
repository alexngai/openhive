import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface CascadeDiffPayload {
  diff: string;
  files_touched: string[];
  truncated: boolean;
}

export interface CascadeDiffErrorEnvelope {
  /** Typed error code (matches src/cascade/diff-types.ts DiffErrorCode). */
  error: string;
  message: string;
}

export interface UseCascadeDiffOptions {
  /** Restrict the diff to a single file path. */
  file?: string;
  /** Explicit base SHA for ranged diffs. Defaults to single-commit (`HEAD^..HEAD`). */
  base?: string;
  /**
   * D17: skip the diff blob and return only `files_touched`. Useful for
   * stack file-tree rendering where the body is fetched lazily per file.
   */
  files_only?: boolean;
  /** Disable the query (e.g., until the user clicks a commit). */
  enabled?: boolean;
}

/**
 * Fetch the unified diff for a (stream_row_id, commit_hash) pair from the hub.
 *
 * Resolves transparently against the hub's five-tier cache (cache → MAP →
 * sidecar git). Errors land on `error.message` with `error.code` mirroring
 * `DiffErrorCode` from the backend, so callers can branch on `swarm_offline`
 * vs `not_found` vs `internal` and render the right UX.
 *
 * @param streamRowId — `cascade_streams.id` (hub row id), not the runtime
 *                      `stream_id`.
 * @param commitHash — head commit SHA.
 */
export function useCascadeDiff(
  streamRowId: string | null,
  commitHash: string | null,
  options: UseCascadeDiffOptions = {},
) {
  const { file, base, files_only, enabled = true } = options;

  const qs = new URLSearchParams();
  if (file) qs.set('file', file);
  if (base) qs.set('base', base);
  if (files_only) qs.set('files_only', 'true');
  const query = qs.toString();

  return useQuery({
    queryKey: ['cascade-diff', streamRowId, commitHash, file ?? null, base ?? null, !!files_only],
    queryFn: () =>
      api.get<{ data: CascadeDiffPayload }>(
        `/cascade/streams/${encodeURIComponent(streamRowId!)}/commits/${encodeURIComponent(commitHash!)}/diff${query ? `?${query}` : ''}`,
      ),
    enabled: enabled && !!streamRowId && !!commitHash,
    // Content-addressed — once a hit lands, it's immutable for that key.
    // staleTime "forever" lets the hub's cache do its job; component
    // unmount/remount won't refetch.
    staleTime: Infinity,
    // Don't retry on 4xx (not_found, bad_request) — those won't fix themselves.
    // Retry once on transient 5xx (timeout, swarm_offline) since the user
    // can immediately reconnect their sidecar.
    retry: (failureCount, err) => {
      const status =
        (err as { status?: number } | undefined)?.status ??
        (err as { response?: { status?: number } } | undefined)?.response?.status;
      if (status && status >= 400 && status < 500) return false;
      return failureCount < 1;
    },
  });
}

// ============================================================================
// Stream 2 — stream-level + stack-level diff hooks
// ============================================================================

export interface UseCascadeRangeDiffOptions {
  file?: string;
  files_only?: boolean;
  enabled?: boolean;
}

/**
 * Combined-result variant: tries `files_only=true` first (cheap, the
 * sidecar's `git diff --name-only` path) and falls back to a full-diff
 * request when files_only errors out with a 5xx (typically
 * `swarm_offline` — sidecar offline, cache-only operation).
 *
 * Returns a unified result with `files_touched` from whichever request
 * succeeded, plus `fullDiff` (the cached blob) when the fallback fired
 * — callers can slice it in-memory for per-file rendering without
 * issuing additional per-file requests.
 *
 * Design tension: D17 deliberately bypasses cache on `files_only=true`
 * because sidecar-recomputation of names is cheap. But in cache-only
 * mode (no sidecar reachable) that bypass leaves us stranded. The
 * fallback closes that gap without changing D17 — it's strictly a
 * read-path tier-1 fallback when tier 2-3 can't serve.
 */
export interface CascadeRangeSmartResult {
  /** Always populated when either query succeeded. */
  files_touched: string[];
  /** The full diff blob when the fallback path fired. null in the happy files-only path. */
  fullDiff: string | null;
  truncated: boolean;
  /** True iff we used the cached full-diff fallback (sidecar offline). */
  usedFallback: boolean;
}

/** Linear-stack echo block returned by the stack-diff endpoint. */
export interface CascadeLinearStack {
  entries: Array<{
    stream_row_id: string;
    cascade_stream_id: string;
    name: string;
    status: string;
    base_commit: string | null;
    head_commit: string | null;
  }>;
  lowest_base: string;
  highest_head: string;
  root: CascadeLinearStack['entries'][number];
  leaf: CascadeLinearStack['entries'][number];
}

/**
 * Fetch the cumulative diff for one stream — `stream.base_commit..head`.
 * Use `files_only: true` to render a file tree without loading the blob.
 */
export function useCascadeStreamDiff(
  streamRowId: string | null,
  options: UseCascadeRangeDiffOptions = {},
) {
  const { file, files_only, enabled = true } = options;
  const qs = new URLSearchParams();
  if (file) qs.set('file', file);
  if (files_only) qs.set('files_only', 'true');
  const query = qs.toString();

  return useQuery({
    queryKey: ['cascade-stream-diff', streamRowId, file ?? null, !!files_only],
    queryFn: () =>
      api.get<{ data: CascadeDiffPayload }>(
        `/cascade/streams/${encodeURIComponent(streamRowId!)}/diff${query ? `?${query}` : ''}`,
      ),
    enabled: enabled && !!streamRowId,
    staleTime: Infinity,
    retry: (failureCount, err) => {
      const status = (err as { status?: number } | undefined)?.status;
      if (status && status >= 400 && status < 500) return false;
      return failureCount < 1;
    },
  });
}

/**
 * Smart variant: tries `files_only=true` first; on 5xx error falls back to
 * a cached full-diff fetch and synthesizes the same `{ files_touched }`
 * shape. Use for the file-tree panel where the user's intent is "show me
 * which files this stream changed", which both endpoints answer.
 */
export function useCascadeStreamDiffSmart(
  streamRowId: string | null,
  options: { enabled?: boolean } = {},
): {
  data: CascadeRangeSmartResult | null;
  isLoading: boolean;
  error: unknown;
} {
  const { enabled = true } = options;
  const filesOnly = useCascadeStreamDiff(streamRowId, {
    files_only: true,
    enabled,
  });
  // Only fire the fallback once files_only has actually failed (saves a
  // round-trip in the happy live-sidecar path).
  const status =
    (filesOnly.error as { status?: number } | undefined)?.status ?? 0;
  const shouldFallback = !!filesOnly.error && status >= 500;
  const fallback = useCascadeStreamDiff(streamRowId, {
    files_only: false,
    enabled: enabled && shouldFallback,
  });

  return composeSmart(filesOnly, fallback, shouldFallback);
}

/**
 * Fetch the cumulative diff across a linear active-subset stack rooted at
 * `stackRootRowId`. Returns `data` (the diff payload) plus `stack` (the
 * linear chain echo block) when the request succeeds.
 *
 * If the stack is non-linear, the route returns 400 with
 * `error: 'non_linear_stack'`. The hook surfaces that via the React Query
 * `error` field — callers should branch on `(err as any).body?.error` to
 * render the "view individual streams instead" notice.
 */
export function useCascadeStackDiff(
  stackRootRowId: string | null,
  options: UseCascadeRangeDiffOptions = {},
) {
  const { file, files_only, enabled = true } = options;
  const qs = new URLSearchParams();
  if (file) qs.set('file', file);
  if (files_only) qs.set('files_only', 'true');
  const query = qs.toString();

  return useQuery({
    queryKey: ['cascade-stack-diff', stackRootRowId, file ?? null, !!files_only],
    queryFn: () =>
      api.get<{ data: CascadeDiffPayload; stack: CascadeLinearStack | null }>(
        `/cascade/streams/${encodeURIComponent(stackRootRowId!)}/stack/diff${query ? `?${query}` : ''}`,
      ),
    enabled: enabled && !!stackRootRowId,
    staleTime: Infinity,
    retry: (failureCount, err) => {
      const status = (err as { status?: number } | undefined)?.status;
      if (status && status >= 400 && status < 500) return false;
      return failureCount < 1;
    },
  });
}

/**
 * Smart variant for stack-level (mirrors `useCascadeStreamDiffSmart`).
 * Also surfaces the `stack` echo block via the fallback when present.
 */
export function useCascadeStackDiffSmart(
  stackRootRowId: string | null,
  options: { enabled?: boolean } = {},
): {
  data: (CascadeRangeSmartResult & { stack: CascadeLinearStack | null }) | null;
  isLoading: boolean;
  error: unknown;
} {
  const { enabled = true } = options;
  const filesOnly = useCascadeStackDiff(stackRootRowId, {
    files_only: true,
    enabled,
  });
  const status =
    (filesOnly.error as { status?: number } | undefined)?.status ?? 0;
  // 400s (e.g. non_linear_stack) are NOT recoverable — let those surface.
  const shouldFallback = !!filesOnly.error && status >= 500;
  const fallback = useCascadeStackDiff(stackRootRowId, {
    files_only: false,
    enabled: enabled && shouldFallback,
  });

  const composed = composeSmart(filesOnly, fallback, shouldFallback);
  if (!composed.data) return composed as never;
  // Pull the stack block from whichever query succeeded.
  const stack =
    (filesOnly.data?.stack as CascadeLinearStack | null | undefined) ??
    (fallback.data?.stack as CascadeLinearStack | null | undefined) ??
    null;
  return {
    ...composed,
    data: { ...composed.data, stack },
  };
}

// ============================================================================
// Internals
// ============================================================================

type RangeQueryShape = ReturnType<typeof useCascadeStreamDiff>;

/**
 * Merge a "primary" files_only query with its fallback into a single
 * `CascadeRangeSmartResult`. Pulls `files_touched` from whichever
 * succeeded; exposes the fallback's blob when it fired so callers can
 * slice in-memory for per-file rendering.
 */
function composeSmart(
  primary: RangeQueryShape,
  fallback: RangeQueryShape,
  fallbackActive: boolean,
): {
  data: CascadeRangeSmartResult | null;
  isLoading: boolean;
  error: unknown;
} {
  // Primary still loading or hasn't errored yet — pass through its state.
  if (primary.isLoading) {
    return { data: null, isLoading: true, error: null };
  }
  if (primary.data && !primary.error) {
    return {
      data: {
        files_touched: primary.data.data?.files_touched ?? [],
        fullDiff: null,
        truncated: primary.data.data?.truncated ?? false,
        usedFallback: false,
      },
      isLoading: false,
      error: null,
    };
  }
  // Primary errored. Did we trigger fallback?
  if (!fallbackActive) {
    return { data: null, isLoading: false, error: primary.error };
  }
  if (fallback.isLoading) {
    return { data: null, isLoading: true, error: null };
  }
  if (fallback.data && !fallback.error) {
    return {
      data: {
        files_touched: fallback.data.data?.files_touched ?? [],
        fullDiff: fallback.data.data?.diff ?? '',
        truncated: fallback.data.data?.truncated ?? false,
        usedFallback: true,
      },
      isLoading: false,
      error: null,
    };
  }
  // Fallback also failed — surface the deeper error (it's more recent).
  return { data: null, isLoading: false, error: fallback.error ?? primary.error };
}

/**
 * Slice one file's chunk out of a multi-file unified diff blob. Splits
 * on `^diff --git ` boundaries, then matches by the `b/<path>` side of
 * the per-file header (handles renames by also accepting `a/<path>`).
 * Returns null if no matching chunk is found.
 */
export function extractFileFromUnifiedDiff(
  blob: string,
  filePath: string,
): string | null {
  if (!blob) return null;
  // Split into per-file chunks; preserve the `diff --git` header line.
  const chunks = blob.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.startsWith('diff --git ')) continue;
    // Look at the first `+++ b/<path>` or `--- a/<path>` line.
    const headerMatch =
      chunk.match(/^\+\+\+ b\/(.+)$/m) ?? chunk.match(/^--- a\/(.+)$/m);
    if (headerMatch && headerMatch[1] === filePath) {
      return chunk.trimEnd();
    }
  }
  return null;
}
