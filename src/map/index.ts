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

// MAP Task Hub
export { MAPTaskStore, getMapTaskStore, resetMapTaskStore } from './task-store.js';
export { handleTaskRequest, MAPTaskRequestError } from './task-handler.js';
export { initTaskBroadcaster, stopTaskBroadcaster } from './task-broadcaster.js';
export { MAP_TASK_METHODS, MAP_TASK_METHOD_SET } from './task-types.js';
export type {
  MAPTask,
  MAPTaskStatus,
  MAPTaskEvent,
  MAPTaskEventType,
  MAPTaskMethod,
  TasksCreateParams,
  TasksAssignParams,
  TasksUpdateParams,
  TasksListParams,
  TasksCreateResult,
  TasksAssignResult,
  TasksUpdateResult,
  TasksListResult,
} from './task-types.js';

// MAP OpenTasks (remote access to local OpenTasks graphs)
export { handleOpenTasksRequest, OpenTasksRequestError } from './opentasks-handler.js';
export { MAP_OPENTASKS_METHODS, MAP_OPENTASKS_METHOD_SET } from './opentasks-types.js';
export type {
  MAPOpenTasksMethod,
  OpenTasksSummaryParams,
  OpenTasksReadyParams,
  OpenTasksQueryParams,
  OpenTasksStatusParams,
  OpenTasksSummaryResult,
  OpenTasksReadyResult,
  OpenTasksQueryResult,
  OpenTasksStatusResult,
} from './opentasks-types.js';
