/**
 * openhive-types
 *
 * Lightweight shared types for the OpenHive ecosystem.
 * Zero runtime dependencies — safe for any consumer to install.
 *
 * Trajectory protocol types → @multi-agent-protocol/sdk
 * Checkpoint metadata types → sessionlog
 * OpenHive vendor extensions → this package
 */

// MAP sync wire format (JSON-RPC 2.0 notifications)
export type { MapSyncMethod, MapSyncParams, MapSyncMessage } from './map-sync.js';
export { SYNC_METHODS, SYNC_MESSAGE_RESOURCE_TYPE, createSyncNotification } from './map-sync.js';

// Session sync notification (OpenHive envelope for trajectory/checkpoint)
export type {
  SessionSyncParams,
  SessionSyncMessage,
} from './map-session-sync.js';
export {
  createSessionSyncNotification,
  SESSION_SYNC_METHOD,
} from './map-session-sync.js';

// MAP coordination types removed — task events now use MAP scope messages,
// context/messaging uses agent-inbox. See coordination/listener.ts.
