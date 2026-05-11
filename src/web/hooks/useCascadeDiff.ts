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
