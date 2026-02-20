/**
 * MAP Hub Module
 *
 * OpenHive as a headscale-style coordination plane for MAP (Multi-Agent Protocol) swarms.
 * Provides swarm registration, agent node discovery, peer coordination,
 * and pre-auth key management.
 */

export {
  registerSwarm,
  registerNode,
  getPeerList,
  joinHive,
  leaveHive,
  markStaleSwarms,
  getWellKnownMapInfo,
  MapHubError,
  type MapHubErrorCode,
  type RegisterSwarmResult,
} from './service.js';

export { MAP_SCHEMA } from './schema.js';

export {
  initMapSyncListener,
  stopMapSyncListener,
  handleSyncMessage,
  getSyncListenerStatus,
} from './sync-listener.js';

export {
  MapSyncClient,
  type MapSyncClientConfig,
  type SyncResource,
  type SyncMessageHandler,
  type PollChecker,
  type PollCheckResult,
} from './sync-client.js';

export type {
  // Swarm types
  MapSwarm,
  MapSwarmPublic,
  MapSwarmCapabilities,
  MapTransport,
  MapAuthMethod,
  SwarmStatus,
  // Node types
  MapNode,
  MapNodePublic,
  MapNodeState,
  MapNodeVisibility,
  // Membership
  MapSwarmHive,
  // Pre-auth keys
  MapPreauthKey,
  // Federation log
  MapFederationLogEntry,
  FederationConnectionStatus,
  // API input types
  RegisterSwarmInput,
  UpdateSwarmInput,
  RegisterNodeInput,
  UpdateNodeInput,
  DiscoverNodesOptions,
  CreatePreauthKeyInput,
  // Peer list
  SwarmPeer,
  PeerList,
  // Sync messages (JSON-RPC 2.0)
  MapSyncMessage,
  MapSyncMethod,
  MapSyncParams,
} from './types.js';

export { SYNC_METHODS, SYNC_MESSAGE_RESOURCE_TYPE, createSyncNotification } from './types.js';
