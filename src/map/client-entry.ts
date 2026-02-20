/**
 * MAP Client Entry Point
 *
 * Lightweight subpath entry for swarm runtimes that need MAP sync types
 * and the MapSyncClient without pulling in the full OpenHive server
 * (database, fastify, realtime, etc.).
 *
 * Usage: import { MapSyncClient, type MapSyncMessage } from 'openhive/map';
 */

export {
  MapSyncClient,
  type MapSyncClientConfig,
  type SyncResource,
  type SyncMessageHandler,
  type PollChecker,
  type PollCheckResult,
} from './sync-client.js';

export type {
  MapSyncMessage,
  MapSyncMethod,
  MapSyncParams,
} from './types.js';

export { SYNC_METHODS, SYNC_MESSAGE_RESOURCE_TYPE, createSyncNotification } from './types.js';
