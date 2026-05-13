/**
 * Type & method-name constants for the cascade diff protocol.
 *
 * Wire shapes (hub ↔ sidecar) mirror `src/map/trajectory-content.ts`:
 *   1. Hub sends `cascade/diff.request` as a JSON-RPC notification with a
 *      `request_id`.
 *   2. Runtime answers with one `cascade/diff.response` notification —
 *      either inline (`streaming: false`) for blobs ≤ 512 KB raw, or
 *      streaming (`streaming: true`) with a `chunk_stream_id` for larger.
 *   3. For streaming responses, N `cascade/diff.chunk` notifications follow,
 *      each carrying base64-encoded data, ordered by `seq`, terminated by
 *      `final: true` + `sha256`.
 *
 * No runtime logic lives here — pure types + constants. See
 * docs/design/cascade-diff-and-stacked-prs.md for the full protocol.
 */

// ============================================================================
// Method names
// ============================================================================

export const CASCADE_DIFF_METHODS = {
  REQUEST: 'cascade/diff.request',
  RESPONSE: 'cascade/diff.response',
  CHUNK: 'cascade/diff.chunk',
} as const;

export type CascadeDiffMethod =
  (typeof CASCADE_DIFF_METHODS)[keyof typeof CASCADE_DIFF_METHODS];

// ============================================================================
// Tuning constants
// ============================================================================

/**
 * Raw-byte threshold for inline vs streamed responses. ≤ this size, the
 * sidecar packs the diff into a single `cascade/diff.response` notification.
 * Mirrors `INLINE_TRANSCRIPT_THRESHOLD` in `src/map/sync-client.ts`.
 */
export const DIFF_INLINE_THRESHOLD_BYTES = 512 * 1024;

/** Per-chunk size when streaming. Matches trajectory protocol. */
export const DIFF_CHUNK_SIZE_BYTES = 1024 * 1024;

/**
 * Hub-side wait for the initial `cascade/diff.response`. Bumped vs
 * trajectory's 10s per D5 — git can be slow on cold worktrees + large diffs.
 */
export const DIFF_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Hard cap on raw diff output produced by the sidecar. Above this, the
 * sidecar truncates and sets `truncated: true`.
 */
export const DIFF_MAX_RAW_BYTES = 50 * 1024 * 1024;

// ============================================================================
// Request (hub → sidecar)
// ============================================================================

export interface CascadeDiffRequestParams {
  request_id: string;
  stream_id: string;
  /** Head commit SHA. Required. */
  head: string;
  /**
   * Base SHA — defines the diff range `base..head`. Omit for a single-commit
   * diff (sidecar uses `git show`, i.e. `head^..head`).
   */
  base?: string;
  /** Restrict to these paths. Omit for the full commit/range. */
  file_paths?: string[];
  /**
   * D17: when true, sidecar runs `git diff --name-only` (or `git show`-style
   * name-only) and returns just `files_touched`. Skips the blob entirely.
   * Resolver also bypasses the cache when set — name-only is cheap.
   */
  files_only?: boolean;
  /** Diff format. Only 'unified' is defined; reserved for future. */
  format: 'unified';
}

// ============================================================================
// Response (sidecar → hub)
// ============================================================================

interface DiffResponseBase {
  request_id: string;
  files_touched: string[];
}

export interface CascadeDiffInlineResponse extends DiffResponseBase {
  streaming: false;
  /** Unified diff text. Empty string when `files_only: true`. */
  diff: string;
  truncated: boolean;
}

export interface CascadeDiffStreamingResponse extends DiffResponseBase {
  streaming: true;
  chunk_stream_id: string;
  total_size: number;
  /** truncated reported on the final chunk for streamed responses. */
}

/**
 * Error path on the same wire method, mirroring trajectory-content.ts.
 * Sidecar emits when it can't produce a diff (missing worktree, git
 * shell-out failed, bad input). `files_touched` is omitted on this shape.
 */
export interface CascadeDiffErrorResponse {
  request_id: string;
  error: { code: DiffErrorCode; message: string };
}

export type CascadeDiffResponseParams =
  | CascadeDiffInlineResponse
  | CascadeDiffStreamingResponse
  | CascadeDiffErrorResponse;

// ============================================================================
// Chunk (sidecar → hub, post-streaming-response)
// ============================================================================

export interface CascadeDiffChunkParams {
  chunk_stream_id: string;
  seq: number;
  /** Base64-encoded raw bytes for this chunk. */
  data: string;
  /** True on the last chunk in the stream. */
  final?: boolean;
  /** Hex-encoded sha256 of the full assembled blob. Present iff `final`. */
  sha256?: string;
  /** True if the sidecar hit `DIFF_MAX_RAW_BYTES`. Present iff `final`. */
  truncated?: boolean;
}

// ============================================================================
// Resolver-level payload + error union (REST + internal)
// ============================================================================

/**
 * What the resolver returns on success. `truncated` mirrors the sidecar's
 * truncation flag (50 MB cap exceeded). When the caller asked for
 * `files_only`, `diff` is the empty string and `truncated` is false.
 */
export interface DiffPayload {
  diff: string;
  files_touched: string[];
  truncated: boolean;
}

export type DiffErrorCode =
  | 'swarm_offline'
  | 'capability_missing'
  | 'timeout'
  | 'integrity_failed'
  | 'not_found'
  | 'bad_request'
  | 'internal';

export interface DiffError {
  code: DiffErrorCode;
  message: string;
}

export type DiffResult =
  | { ok: true; payload: DiffPayload }
  | { ok: false; error: DiffError };

// ============================================================================
// Type guards
// ============================================================================

export function isErrorResponse(
  r: CascadeDiffResponseParams
): r is CascadeDiffErrorResponse {
  return 'error' in r && r.error != null;
}

export function isStreamingResponse(
  r: CascadeDiffResponseParams
): r is CascadeDiffStreamingResponse {
  return !isErrorResponse(r) && (r as CascadeDiffStreamingResponse).streaming === true;
}

export function isInlineResponse(
  r: CascadeDiffResponseParams
): r is CascadeDiffInlineResponse {
  return !isErrorResponse(r) && (r as CascadeDiffInlineResponse).streaming === false;
}
