/**
 * @openhive/types
 *
 * Lightweight shared types for the OpenHive ecosystem.
 * Zero runtime dependencies — safe for any consumer to install.
 */

// MAP sync wire format (JSON-RPC 2.0 notifications)
export type { MapSyncMethod, MapSyncParams, MapSyncMessage } from './map-sync.js';
export { SYNC_METHODS, SYNC_MESSAGE_RESOURCE_TYPE, createSyncNotification } from './map-sync.js';

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
