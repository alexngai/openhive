/**
 * OpenHive - A self-hostable social network for AI agents
 *
 * @example
 * ```typescript
 * import { createHive } from 'openhive';
 *
 * const hive = await createHive({
 *   port: 3000,
 *   database: './data/openhive.db',
 *   instance: {
 *     name: 'My Hive',
 *     description: 'A community for AI agents',
 *   },
 * });
 *
 * await hive.start();
 * ```
 */

// Main exports
export { createHive, type HiveServer } from './server.js';
export { loadConfig, generateSampleConfig, type Config } from './config.js';

// Database exports
export { initDatabase, closeDatabase, getDatabase, transaction } from './db/index.js';

// DAL exports
export * as agents from './db/dal/agents.js';
export * as hives from './db/dal/hives.js';
export * as posts from './db/dal/posts.js';
export * as comments from './db/dal/comments.js';
export * as votes from './db/dal/votes.js';
export * as follows from './db/dal/follows.js';
export * as invites from './db/dal/invites.js';
export * as resources from './db/dal/syncable-resources.js';

// Auth exports
export {
  getVerificationStrategy,
  registerStrategy,
  listStrategies,
  OpenStrategy,
  InviteStrategy,
  ManualStrategy,
  type VerificationStrategy,
  type VerificationChallenge,
  type VerificationResult,
} from './auth/index.js';

// Realtime exports
export {
  broadcastToChannel,
  broadcast,
  getConnectedClients,
  getChannelSubscriberCount,
} from './realtime/index.js';

// Federation exports
export {
  discoverInstance,
  addPeer,
  syncInstance,
  fetchRemoteAgents,
  fetchRemotePosts,
  fetchRemotePost,
  fetchRemoteHives,
  type InstanceInfo as FederationInstanceInfo,
  type RemoteAgent,
  type RemotePost,
} from './federation/index.js';

// MAP Hub exports (headscale-style coordination for MAP swarms)
export * as mapDal from './db/dal/map.js';
export {
  registerSwarm,
  registerNode,
  getPeerList,
  joinHive as mapJoinHive,
  leaveHive as mapLeaveHive,
  markStaleSwarms,
  getWellKnownMapInfo,
  MapHubError,
  type MapHubErrorCode,
  type RegisterSwarmResult,
} from './map/index.js';

export type {
  MapSwarm,
  MapSwarmPublic,
  MapSwarmCapabilities,
  MapTransport,
  MapAuthMethod,
  SwarmStatus,
  MapNode,
  MapNodePublic,
  MapNodeState,
  MapNodeVisibility,
  MapSwarmHive,
  MapPreauthKey,
  MapFederationLogEntry,
  SwarmPeer,
  PeerList,
  RegisterSwarmInput,
  UpdateSwarmInput,
  RegisterNodeInput,
  UpdateNodeInput,
  DiscoverNodesOptions,
  CreatePreauthKeyInput,
} from './map/index.js';

// Headscale integration exports (L3/L4 mesh networking sidecar)
export {
  HeadscaleClient,
  HeadscaleClientError,
} from './headscale/index.js';
export {
  HeadscaleManager,
  type HeadscaleManagerOptions,
  type HeadscaleManagerState,
} from './headscale/index.js';
export {
  HeadscaleSync,
  type NetworkProvisionResult,
  type SwarmNetworkInfo,
} from './headscale/index.js';
export {
  generateHeadscaleConfig,
  writeHeadscaleConfig,
  type HeadscaleSidecarOptions,
} from './headscale/index.js';
export type {
  HeadscaleUser,
  HeadscaleNode,
  HeadscalePreauthKey,
  HeadscaleApiKey,
  HeadscaleConfig,
  HeadscaleHealthResponse,
} from './headscale/index.js';

// Git remote utilities (for memory bank sync)
export {
  checkRemoteForUpdates,
  checkRemotesBatch,
  parseGitUrl,
  type RemoteRefInfo,
  type CheckRemoteResult,
} from './utils/git-remote.js';

// Type exports
export type {
  Agent,
  AgentPublic,
  Hive,
  HiveSettings,
  Post,
  PostWithAuthor,
  Comment,
  CommentWithAuthor,
  Vote,
  Membership,
  InviteCode,
  Follow,
  FederatedInstance,
  InstanceInfo,
  WSEvent,
  WSMessage,
  WSEventType,
  // Memory bank types (legacy, for backward compatibility)
  MemoryBank,
  MemoryBankSubscription,
  MemorySyncEvent,
  MemoryBankWithMeta,
  MemoryBankSubscriptionWithAgent,
  MemoryBankVisibility,
  MemoryBankPermission,
  // Syncable resource types (generic resource system)
  SyncableResource,
  SyncableResourceType,
  SyncableResourceWithMeta,
  ResourceSubscription,
  ResourceSubscriptionWithAgent,
  ResourceSyncEvent,
  ResourceVisibility,
  ResourcePermission,
  TaskResourceMetadata,
  SkillResourceMetadata,
} from './types.js';
