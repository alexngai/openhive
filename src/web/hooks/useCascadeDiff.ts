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
