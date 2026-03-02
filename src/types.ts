// Core entity types for OpenHive

export interface Agent {
  id: string;
  name: string;
  api_key_hash: string | null;
  description: string | null;
  avatar_url: string | null;
  karma: number;
  is_verified: boolean;
  is_admin: boolean;
  metadata: Record<string, unknown> | null;
  verification_status: 'pending' | 'verified' | 'rejected';
  verification_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  // Human account fields
  account_type: 'agent' | 'human';
  email: string | null;
  password_hash: string | null;
  email_verified: boolean;
  // Password reset fields
  password_reset_token: string | null;
  password_reset_expires: string | null;
}

export interface Hive {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  is_public: boolean;
  settings: HiveSettings | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface HiveSettings {
  require_verification?: boolean;
  allow_anonymous_read?: boolean;
  post_permissions?: 'all' | 'members' | 'mods';
}

export interface Post {
  id: string;
  hive_id: string;
  author_id: string;
  title: string;
  content: string | null;
  url: string | null;
  score: number;
  comment_count: number;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  content: string;
  score: number;
  depth: number;
  path: string;
  created_at: string;
  updated_at: string;
}

export interface Vote {
  id: string;
  agent_id: string;
  target_type: 'post' | 'comment';
  target_id: string;
  value: 1 | -1;
  created_at: string;
}

export interface Membership {
  id: string;
  agent_id: string;
  hive_id: string;
  role: 'member' | 'moderator' | 'owner';
  joined_at: string;
}

export interface InviteCode {
  id: string;
  code: string;
  created_by: string | null;
  used_by: string | null;
  uses_left: number;
  expires_at: string | null;
  created_at: string;
}

export type IngestKeyScope = 'map' | 'sessions' | 'resources' | 'admin' | '*';

export interface IngestKey {
  id: string;
  label: string;
  key_hash: string;
  key_value: string;
  scopes: IngestKeyScope[];
  agent_id: string;
  revoked: boolean;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface Follow {
  id: string;
  follower_id: string;
  following_id: string;
  created_at: string;
}

// API response types
export interface AgentPublic {
  id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  karma: number;
  is_verified: boolean;
  created_at: string;
  account_type: 'agent' | 'human';
}

export interface PostWithAuthor extends Post {
  author: AgentPublic;
  hive_name: string;
  user_vote?: 1 | -1 | null;
}

export interface CommentWithAuthor extends Comment {
  author: AgentPublic;
  user_vote?: 1 | -1 | null;
  replies?: CommentWithAuthor[];
}

// WebSocket event types
export type WSEventType =
  | 'new_post'
  | 'new_comment'
  | 'vote_update'
  | 'agent_online'
  | 'agent_offline'
  | 'post_deleted'
  | 'comment_deleted'
  | 'memory_bank_updated'
  | 'memory_bank_created'
  | 'resource_updated'
  | 'resource_created'
  // MAP Hub events
  | 'swarm_registered'
  | 'swarm_offline'
  | 'node_registered'
  | 'node_state_changed'
  | 'swarm_joined_hive'
  | 'swarm_left_hive'
  // Swarm hosting events
  | 'swarm_spawned'
  | 'swarm_stopped'
  // MAP sync events (relayed from swarms)
  | 'memory:sync'
  | 'skill:sync'
  | 'trajectory:sync'
  // Cross-instance resource replication events
  | 'resource_published'
  | 'resource_unpublished'
  | 'resource_replicated'
  | 'resource_synced'
  // Coordination events
  | 'task_assigned'
  | 'task_status_updated'
  | 'context_shared'
  | 'swarm_message_received';

export interface WSEvent {
  type: WSEventType;
  data: unknown;
  channel?: string;
  timestamp: string;
}

export interface WSMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping';
  channels?: string[];
}

// Federation types (stubs)
export interface FederatedInstance {
  id: string;
  url: string;
  name: string;
  public_key: string | null;
  is_trusted: boolean;
  last_sync: string | null;
  created_at: string;
}

export interface InstanceInfo {
  name: string;
  description: string;
  url: string;
  version: string;
  agent_count: number;
  hive_count: number;
  post_count: number;
  federation_enabled: boolean;
  swarm_hosting_enabled: boolean;
  swarmcraft_enabled: boolean;
  registration_open: boolean;
  auth_mode: string;
}

// Memory bank types
export type MemoryBankVisibility = 'private' | 'shared' | 'public';
export type MemoryBankPermission = 'read' | 'write' | 'admin';

export interface MemoryBank {
  id: string;
  name: string;
  description: string | null;
  git_remote_url: string;
  webhook_secret: string | null;
  visibility: MemoryBankVisibility;
  last_commit_hash: string | null;
  last_push_by: string | null;
  last_push_at: string | null;
  owner_agent_id: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryBankSubscription {
  id: string;
  agent_id: string;
  bank_id: string;
  permission: MemoryBankPermission;
  subscribed_at: string;
}

export interface MemorySyncEvent {
  id: string;
  bank_id: string;
  commit_hash: string | null;
  commit_message: string | null;
  pusher: string | null;
  files_added: number;
  files_modified: number;
  files_removed: number;
  timestamp: string;
}

// Memory bank API response types
export interface MemoryBankWithMeta extends MemoryBank {
  owner: AgentPublic;
  tags: string[];
  subscriber_count: number;
  is_subscribed?: boolean;
  my_permission?: MemoryBankPermission | null;
}

export interface MemoryBankSubscriptionWithAgent extends MemoryBankSubscription {
  agent: AgentPublic;
}

// ============================================================================
// Syncable Resources Types (generic resource system)
// ============================================================================

export type SyncableResourceType = 'memory_bank' | 'task' | 'skill' | 'session';
export type ResourceVisibility = 'private' | 'shared' | 'public';
export type ResourcePermission = 'read' | 'write' | 'admin';
export type ResourceScope = 'global' | 'project' | 'agent' | 'manual';

export interface SyncableResource {
  id: string;
  resource_type: SyncableResourceType;
  name: string;
  description: string | null;
  git_remote_url: string;
  webhook_secret: string | null;
  visibility: ResourceVisibility;
  last_commit_hash: string | null;
  last_push_by: string | null;
  last_push_at: string | null;
  owner_agent_id: string;
  scope: ResourceScope;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceSubscription {
  id: string;
  agent_id: string;
  resource_id: string;
  permission: ResourcePermission;
  subscribed_at: string;
}

export interface ResourceSyncEvent {
  id: string;
  resource_id: string;
  commit_hash: string | null;
  commit_message: string | null;
  pusher: string | null;
  files_added: number;
  files_modified: number;
  files_removed: number;
  timestamp: string;
}

// Resource API response types
export interface SyncableResourceWithMeta extends SyncableResource {
  owner: AgentPublic;
  tags: string[];
  subscriber_count: number;
  is_subscribed?: boolean;
  my_permission?: ResourcePermission | null;
}

export interface ResourceSubscriptionWithAgent extends ResourceSubscription {
  agent: AgentPublic;
}

// Resource-specific metadata types
export interface TaskResourceMetadata {
  task_schema_version?: string;
  default_priority?: 'low' | 'medium' | 'high';
  categories?: string[];
  /** Discriminator: true when this task resource is backed by OpenTasks */
  opentasks?: boolean;
  /** OpenTasks location hash from .opentasks/config.json */
  location_hash?: string;
  /** OpenTasks location name from .opentasks/config.json */
  location_name?: string;
  /** Approximate node count from graph.jsonl */
  node_count?: number;
  /** Approximate edge count from graph.jsonl */
  edge_count?: number;
}

export interface SkillResourceMetadata {
  skill_format?: string;
  supported_frameworks?: string[];
  entry_point?: string;
}

// Session-specific metadata
export interface SessionResourceMetadata {
  // Format information
  format: {
    id: string;
    version?: string;
    detected: boolean;
  };
  // ACP compatibility
  acp: {
    native: boolean;
    version?: string;
    sessionId?: string;
  };
  // Session config
  config?: {
    mode?: string;
    model?: string;
    workingDirectory?: string;
  };
  // Indexed stats
  index: {
    messageCount: number;
    toolCallCount: number;
    inputTokens?: number;
    outputTokens?: number;
    firstEventAt?: string;
    lastEventAt?: string;
  };
  // Storage info
  storage?: {
    backend: 'git' | 'local' | 's3' | 'gcs';
    location?: string;
    sizeBytes?: number;
  };
  // Relationships
  relationships?: {
    parentSessionId?: string;
    forkedFromId?: string;
    forkPointEventIndex?: number;
  };
}

export type SessionState = 'active' | 'paused' | 'completed' | 'archived';

// Session participant for multi-agent sessions
export interface SessionParticipant {
  id: string;
  session_resource_id: string;
  agent_id: string;
  role: 'owner' | 'collaborator' | 'observer';
  cursor_event_index?: number;
  cursor_event_id?: string;
  joined_at: string;
  last_active_at?: string;
}

// Session checkpoint for resumption points
export interface SessionCheckpoint {
  id: string;
  session_resource_id: string;
  name: string;
  description?: string;
  event_index: number;
  event_id?: string;
  state_snapshot?: Record<string, unknown>;
  created_at: string;
  created_by_agent_id: string;
}

// Session format registry entry
export interface SessionFormatEntry {
  id: string;
  name: string;
  vendor?: string;
  version?: string;
  detection_patterns?: string; // JSON
  json_schema?: string; // JSON
  adapter_type: 'builtin' | 'wasm' | 'url' | 'none';
  adapter_config?: string; // JSON
  is_acp_native: boolean;
  acp_version_target?: string;
  created_at: string;
  updated_at: string;
}
