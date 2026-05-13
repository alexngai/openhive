/**
 * Hub-side wire protocol for `cascade/diff.request` / `cascade/diff.response`
 * / `cascade/diff.chunk`. Mirrors `src/map/trajectory-content.ts` in shape:
 * the hub sends a JSON-RPC notification with a `request_id`, the sidecar
 * answers with a notification carrying either inline data or a streamed
 * chunk announcement, and chunk notifications follow until `final` arrives.
 *
 *   pendingRequests   keyed on request_id
 *   chunkStreams      keyed on chunk_stream_id → request_id
 *
 * Plug-in point: `installAsResolverFetcher()` registers `sendDiffRequest`
 * as the on-demand `MapDiffFetcher` on the diff resolver. Called once at
 * server bootstrap (see `src/server.ts`).
 *
 * The chunk reassembly never accumulates more than `DIFF_MAX_RAW_BYTES`
 * (50 MB) per request — defends against a runaway sidecar.
 */

import WebSocket from 'ws';
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import { getInbound } from './connection-registry.js';
import {
  CASCADE_DIFF_METHODS,
  DIFF_REQUEST_TIMEOUT_MS,
  DIFF_MAX_RAW_BYTES,
  type CascadeDiffChunkParams,
  type CascadeDiffResponseParams,
  type DiffResult,
  isStreamingResponse,
  isErrorResponse,
} from '../cascade/diff-types.js';
import {
  setMapDiffFetcher,
  type MapDiffFetchArgs,
} from '../cascade/diff-resolver.js';

interface PendingState {
  resolve: (r: DiffResult) => void;
  timer: ReturnType<typeof setTimeout>;
  // Populated only after a streaming `cascade/diff.response` arrives.
  chunkStreamId?: string;
  parts?: Array<Buffer | null>;   // sparse — parts[seq] = chunk bytes
  expectedTotal?: number;
  filesTouched?: string[];
  receivedBytes?: number;
}

const pendingRequests = new Map<string, PendingState>();
const chunkStreamToRequest = new Map<string, string>();

// ============================================================================
// Public API
// ============================================================================

/**
 * Send a `cascade/diff.request` notification to the swarm that owns the
 * stream and await a response. Returns a DiffResult on either path.
 */
export async function sendDiffRequest(
  args: MapDiffFetchArgs
): Promise<DiffResult> {
  const conn = getInbound(args.swarmId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
    return {
      ok: false,
      error: { code: 'swarm_offline', message: `swarm ${args.swarmId} not connected` },
    };
  }

  const requestId = `cascade-diff-${nanoid(10)}`;

  const notification = {
    jsonrpc: '2.0' as const,
    method: CASCADE_DIFF_METHODS.REQUEST,
    params: {
      request_id: requestId,
      stream_id: args.stream_id,
      head: args.head,
      base: args.base,
      file_paths: args.file_paths,
      files_only: args.files_only,
      format: 'unified' as const,
    },
  };

  try {
    conn.ws.send(JSON.stringify(notification));
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'internal',
        message: `failed to send cascade/diff.request: ${(err as Error).message}`,
      },
    };
  }

  return await new Promise<DiffResult>((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      pendingRequests.delete(requestId);
      if (pending.chunkStreamId) chunkStreamToRequest.delete(pending.chunkStreamId);
      resolve({
        ok: false,
        error: {
          code: 'timeout',
          message: `cascade/diff.request timed out after ${DIFF_REQUEST_TIMEOUT_MS}ms`,
        },
      });
    }, DIFF_REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, timer });
  });
}

/**
 * Handle an inbound `cascade/diff.response` notification.
 *
 * Inline payloads resolve the request immediately. Streaming payloads
 * record `chunk_stream_id → request_id` and wait for chunk notifications
 * to arrive.
 */
export function handleDiffResponse(params: CascadeDiffResponseParams): void {
  const requestId = params.request_id;
  const pending = pendingRequests.get(requestId);
  if (!pending) return; // unknown / already timed out

  if (isErrorResponse(params)) {
    pendingRequests.delete(requestId);
    if (pending.chunkStreamId) chunkStreamToRequest.delete(pending.chunkStreamId);
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: params.error });
    return;
  }

  if (!isStreamingResponse(params)) {
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({
      ok: true,
      payload: {
        diff: params.diff,
        files_touched: params.files_touched,
        truncated: params.truncated,
      },
    });
    return;
  }

  // Streaming: stash assembly state and wait for chunks.
  if (params.total_size > DIFF_MAX_RAW_BYTES) {
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({
      ok: false,
      error: {
        code: 'bad_request',
        message: `sidecar announced ${params.total_size} bytes, exceeds ${DIFF_MAX_RAW_BYTES} cap`,
      },
    });
    return;
  }

  pending.chunkStreamId = params.chunk_stream_id;
  pending.parts = [];
  pending.expectedTotal = params.total_size;
  pending.filesTouched = params.files_touched;
  pending.receivedBytes = 0;
  chunkStreamToRequest.set(params.chunk_stream_id, requestId);
}

/**
 * Handle an inbound `cascade/diff.chunk` notification. Buffers by `seq`;
 * on `final: true`, verifies sha256 and resolves.
 */
export function handleDiffChunk(params: CascadeDiffChunkParams): void {
  const requestId = chunkStreamToRequest.get(params.chunk_stream_id);
  if (!requestId) return;
  const pending = pendingRequests.get(requestId);
  if (!pending || !pending.parts) return;

  let chunk: Buffer;
  try {
    chunk = Buffer.from(params.data, 'base64');
  } catch {
    finishWithError(requestId, {
      code: 'integrity_failed',
      message: `bad base64 on chunk seq=${params.seq}`,
    });
    return;
  }

  pending.parts[params.seq] = chunk;
  pending.receivedBytes = (pending.receivedBytes ?? 0) + chunk.length;

  if (pending.receivedBytes > DIFF_MAX_RAW_BYTES) {
    finishWithError(requestId, {
      code: 'bad_request',
      message: `chunk stream exceeded ${DIFF_MAX_RAW_BYTES} bytes`,
    });
    return;
  }

  if (!params.final) return;

  // Final chunk: assemble in seq order, verify sha256, resolve.
  const ordered: Buffer[] = [];
  for (let i = 0; i < pending.parts.length; i++) {
    const part = pending.parts[i];
    if (!part) {
      finishWithError(requestId, {
        code: 'integrity_failed',
        message: `missing chunk seq=${i}`,
      });
      return;
    }
    ordered.push(part);
  }

  const assembled = Buffer.concat(ordered);
  if (params.sha256) {
    const got = createHash('sha256').update(assembled).digest('hex');
    if (got !== params.sha256) {
      finishWithError(requestId, {
        code: 'integrity_failed',
        message: `sha256 mismatch (got ${got}, expected ${params.sha256})`,
      });
      return;
    }
  }

  pendingRequests.delete(requestId);
  chunkStreamToRequest.delete(params.chunk_stream_id);
  clearTimeout(pending.timer);
  pending.resolve({
    ok: true,
    payload: {
      diff: assembled.toString('utf-8'),
      files_touched: pending.filesTouched ?? [],
      truncated: params.truncated === true,
    },
  });
}

// ============================================================================
// Bootstrap
// ============================================================================

let installed = false;

/**
 * Register `sendDiffRequest` as the resolver's on-demand fetcher. Idempotent.
 */
export function installAsResolverFetcher(): void {
  if (installed) return;
  installed = true;
  setMapDiffFetcher({ fetch: sendDiffRequest });
}

// ============================================================================
// Helpers
// ============================================================================

function finishWithError(
  requestId: string,
  error: { code: 'integrity_failed' | 'bad_request' | 'internal' | 'timeout'; message: string },
): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  if (pending.chunkStreamId) chunkStreamToRequest.delete(pending.chunkStreamId);
  clearTimeout(pending.timer);
  pending.resolve({ ok: false, error });
}

// ============================================================================
// Test helpers — exported only for the protocol test suite (S1.9)
// ============================================================================

/** Test-only: clear all in-flight requests (between tests). */
export function __resetPendingForTests(): void {
  for (const [, pending] of pendingRequests) clearTimeout(pending.timer);
  pendingRequests.clear();
  chunkStreamToRequest.clear();
}

/** Test-only: count in-flight requests for assertions. */
export function __pendingCountForTests(): number {
  return pendingRequests.size;
}
