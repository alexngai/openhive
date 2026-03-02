/**
 * Shared OpenHive types
 *
 * Wire format types for MAP sync, session sync, and coordination notifications.
 */

// MAP sync wire format (JSON-RPC 2.0 notifications)
export type { MapSyncMethod, MapSyncParams, MapSyncMessage } from './map-sync.js';
export { SYNC_METHODS, SYNC_MESSAGE_RESOURCE_TYPE, createSyncNotification } from './map-sync.js';

// MAP session sync wire format (JSON-RPC 2.0 notifications + request/response)
export type {
  SessionSyncParams,
  SessionSyncMessage,
  SessionContentField,
  SessionContentRequest,
  SessionContentResultInline,
  SessionContentResultStreaming,
  SessionContentResult,
  SessionContentResponse,
  SessionContentErrorResponse,
  SessionContentChunkParams,
  SessionContentChunkMessage,
} from './map-session-sync.js';
export {
  createSessionSyncNotification,
  SESSION_SYNC_METHOD,
  SESSION_CONTENT_METHOD,
  SESSION_CONTENT_CHUNK_METHOD,
  INLINE_TRANSCRIPT_THRESHOLD,
  STREAM_CHUNK_SIZE,
  CONTENT_REQUEST_TIMEOUT_MS,
} from './map-session-sync.js';

// MAP coordination wire format (JSON-RPC 2.0 notifications)
export type {
  MapCoordinationMethod,
  MapCoordinationParams,
  MapCoordinationMessage,
  TaskAssignParams,
  TaskStatusParams,
  ContextShareParams,
  MessageSendParams,
} from './map-coordination.js';
export { COORDINATION_METHODS, createCoordinationNotification } from './map-coordination.js';
