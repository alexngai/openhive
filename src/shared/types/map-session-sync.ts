/**
 * MAP Trajectory Sync Types (JSON-RPC 2.0)
 *
 * Wire format types for session trajectory sync between swarms and the hub.
 * Uses MAP-native trajectory/* method names as defined in the MAP protocol
 * trajectory extension (see multi-agent-protocol/docs/11-trajectory-protocol.md).
 *
 * Type ownership:
 *   - Checkpoint metadata (SessionSyncCheckpoint, etc.) → canonical in sessionlog/wire-types.ts
 *   - Trajectory content wire types → canonical in @multi-agent-protocol/sdk
 *   - OpenHive notification envelope (SessionSyncParams, etc.) → canonical in openhive-types
 *   - This file keeps local copies to avoid adding MAP SDK / sessionlog as runtime deps.
 *
 * Message flow:
 *   - trajectory/checkpoint notification (swarm → hub) carries checkpoint metadata inline
 *   - trajectory/content request/response (hub → swarm → hub) for on-demand transcript
 *   - trajectory/content.chunk notification (swarm → hub) for large transcript streaming
 */

import type { MapSyncParams } from './map-sync.js';

// ============================================================================
// Checkpoint Notification (swarm → hub)
// ============================================================================

/**
 * Extended sync params for session notifications.
 * Carries the base sync fields (resource_id, agent_id, commit_hash, timestamp)
 * plus inline checkpoint metadata.
 *
 * The `checkpoint` value should conform to sessionlog's `SessionSyncCheckpoint`
 * type. Import it from the `sessionlog` package for full typing.
 */
export interface SessionSyncParams extends MapSyncParams {
  /** Inline checkpoint metadata (see sessionlog's SessionSyncCheckpoint) */
  checkpoint: Record<string, unknown>;
}

/** Session sync notification message (swarm → hub) — uses MAP trajectory/checkpoint method */
export interface SessionSyncMessage {
  jsonrpc: '2.0';
  method: 'trajectory/checkpoint';
  params: SessionSyncParams;
}

/** Create a well-formed session sync notification */
export function createSessionSyncNotification(
  params: SessionSyncParams,
): SessionSyncMessage {
  return { jsonrpc: '2.0', method: 'trajectory/checkpoint', params };
}

// ============================================================================
// Content Request (hub → swarm)
// ============================================================================

/** Content types that can be requested */
export type SessionContentField = 'metadata' | 'transcript' | 'prompts' | 'context';

/** JSON-RPC request for checkpoint content — uses MAP trajectory/content method */
export interface SessionContentRequest {
  jsonrpc: '2.0';
  /** JSON-RPC request ID — response must echo this */
  id: string;
  method: 'trajectory/content';
  params: {
    /** The checkpoint ID to retrieve content for */
    checkpoint_id: string;
    /** Which content fields to include (default: all) */
    include?: SessionContentField[];
  };
}

// ============================================================================
// Content Response (swarm → hub)
// ============================================================================

/** Base fields common to both inline and streaming responses */
interface SessionContentResultBase {
  checkpoint_id: string;
  /** Named content artifacts — small payloads delivered inline */
  artifacts: Record<string, unknown>;
}

/** Inline response — all artifacts fit in a single message */
export interface SessionContentResultInline extends SessionContentResultBase {
  streaming: false;
}

/** Streaming response — one large artifact will arrive as chunks */
export interface SessionContentResultStreaming extends SessionContentResultBase {
  streaming: true;
  /** Unique ID for correlating chunks to this request */
  stream_id: string;
  /** Which artifact key is being streamed */
  stream_artifact: string;
  /** Info about the upcoming stream */
  stream_info: {
    total_bytes: number;
    total_chunks: number;
    encoding: 'base64';
  };
}

export type SessionContentResult = SessionContentResultInline | SessionContentResultStreaming;

/** JSON-RPC response wrapping content result */
export interface SessionContentResponse {
  jsonrpc: '2.0';
  /** Echoed from the request */
  id: string;
  result: SessionContentResult;
}

/** JSON-RPC error response for content requests */
export interface SessionContentErrorResponse {
  jsonrpc: '2.0';
  id: string;
  error: {
    code: number;
    message: string;
  };
}

// ============================================================================
// Content Chunk (swarm → hub, notification)
// ============================================================================

/** Chunk params for streaming transcript data */
export interface SessionContentChunkParams {
  /** Correlates to the stream_id from the streaming response */
  stream_id: string;
  /** 0-based chunk index */
  index: number;
  /** Base64-encoded JSONL chunk data */
  data: string;
  /** True on the last chunk */
  final?: boolean;
  /** SHA-256 checksum of the full transcript (only on final chunk) */
  checksum?: string;
}

/** Content chunk notification message — uses MAP trajectory/content.chunk method */
export interface SessionContentChunkMessage {
  jsonrpc: '2.0';
  method: 'trajectory/content.chunk';
  params: SessionContentChunkParams;
}

// ============================================================================
// Constants (MAP-native method names)
// ============================================================================

/** Method name for session sync notifications (MAP: trajectory/checkpoint) */
export const SESSION_SYNC_METHOD = 'trajectory/checkpoint' as const;

/** Method name for content requests (MAP: trajectory/content) */
export const SESSION_CONTENT_METHOD = 'trajectory/content' as const;

/** Method name for content chunk notifications (MAP: trajectory/content.chunk) */
export const SESSION_CONTENT_CHUNK_METHOD = 'trajectory/content.chunk' as const;

/** Default threshold (bytes) below which transcript is sent inline vs streamed */
export const INLINE_TRANSCRIPT_THRESHOLD = 512 * 1024; // 512KB

/** Default chunk size for streaming transcripts */
export const STREAM_CHUNK_SIZE = 1 * 1024 * 1024; // 1MB

/** Default timeout for content requests (ms) */
export const CONTENT_REQUEST_TIMEOUT_MS = 60_000;
