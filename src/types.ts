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
  created_at: string;
  updated_at: string;
}

export interface HiveSettings {
  require_verification?: boolean;
  allow_anonymous_read?: boolean;
}

// Post / Comment / Vote / Membership interfaces were removed with the
// social layer (SCHEMA_VERSION 42). `Hive` remains as a namespace tag.

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

// API response types
export interface AgentPublic {
  id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  karma: number;
  is_verified: boolean;
  is_admin: boolean;
  created_at: string;
  account_type: 'agent' | 'human';
}

// PostWithAuthor / CommentWithAuthor removed with the social layer.

// WebSocket event types
export type WSEventType =
  | 'agent_online'
  | 'agent_offline'
  | 'memory_bank_updated'
  | 'memory_bank_created'
  | 'resource_updated'
  | 'resource_created'
  // MAP Hub events
  | 'swarm_registered'
  | 'swarm_offline'
  | 'swarm.status_changed'
  // OpenTasks broadcast events (see api/routes/resource-content.ts).
  | 'task.created'
  | 'task.status'
  | 'task.assigned'
  | 'task.deleted'
  | 'task.linked'
  | 'task.unlinked'
  // Spec broadcast events (see api/routes/specs.ts and map/spec-handler.ts)
  | 'spec.created'
  | 'spec.updated'
  | 'spec.deleted'
  // Dispatch broadcast events (see api/routes/specs.ts dispatch endpoint, api/routes/dispatches.ts, map/dispatch-handler.ts)
  | 'dispatch.created'
  | 'dispatch.status_changed'
  | 'dispatch.completed'
  | 'dispatch.cancelled'
  | 'dispatch.materialization_failed'
  | 'node_registered'
  | 'node_state_changed'
  | 'swarm_heartbeat'
  | 'swarm_joined_hive'
  | 'swarm_left_hive'
  | 'agent_unregistered'
  | 'connection_degraded'
  | 'connection_recovered'
  // Swarm hosting events
  | 'swarm_spawned'
  | 'swarm_stopped'
  // Programmatic-mode hosted-swarm chat events. Fanned out per-swarm on
  // channel `hosted-chat:<hosted_swarm_id>`. The data carries a
  // NORMALIZED event shape (kind: 'message.start' | 'message.delta' |
  // 'message.complete' | 'turn.started' | 'turn.completed' | 'error' |
  // 'raw') so the frontend chat adapter is provider-agnostic.
  // Provider-specific protocol details (codex JSON-RPC, future
  // alternatives) get translated to this shape inside the manager bridge.
  | 'hosted-chat.event'
  // MAP sync events (relayed from swarms)
  | 'memory:sync'
  | 'skill:sync'
  | 'trajectory:sync'
  // Cross-instance resource replication events
  | 'resource_published'
  | 'resource_unpublished'
  | 'resource_replicated'
  | 'resource_synced'
  // Mesh-level lifecycle events (slice 5b — RESOURCE_MESH_EVENTS receivers)
  | 'resource_redacted'
  | 'resource_archived'
  | 'resource_merged'
  // Coordination events
  | 'task_assigned'
  | 'task_status_updated'
  | 'context_shared'
  | 'swarm_message_received'
  // MAP task events (from connected agents)
  | 'task.created'
  | 'task.assigned'
  | 'task.status'
  | 'task.completed'
  // Mail events (MAP agent inbox)
  | 'mail.created'
  | 'mail.turn.added'
  | 'mail.participant.joined'
  | 'mail.closed'
  // Learning engine events
  | 'learning:instant'
  | 'learning:batch'
  | 'learning:maintenance'
  // Cascade projection events (from x-cascade/* MAP notifications).
  // Mirrors the CascadeWSEventType union in src/map/cascade-handler.ts —
  // keep both lists in sync. The paused / resumed / rolled_back entries
  // correspond to the hub-side extensions in src/map/cascade-types.ts
  // that aren't yet shipped in the upstream git-cascade package.
  | 'cascade:stream_opened'
  | 'cascade:stream_committed'
  | 'cascade:stream_merged'
  | 'cascade:stream_conflicted'
  | 'cascade:stream_conflict_resolved'
  | 'cascade:stream_abandoned'
  | 'cascade:stream_paused'
  | 'cascade:stream_resumed'
  | 'cascade:stream_rolled_back'
  | 'cascade:stream_rebased'
  | 'cascade:stream_pushed'
  | 'cascade:completed'
  | 'cascade:queue_queued'
  | 'cascade:queue_ready'
  | 'cascade:queue_cancelled'
  | 'cascade:queue_removed'
  // Team template + loadout resource events (see api/routes/teams.ts, loadouts.ts)
  | 'team_template:created'
  | 'team_template:updated'
  | 'team_template:deleted'
  | 'loadout:created'
  | 'loadout:updated'
  | 'loadout:deleted'
  // Repo / workspace lifecycle events (see realtime/workspace-events.ts).
  // `workspace_*` are per-binding (per-agent instance); `repo_*` are at the
  // federated repo-resource level.
  | 'workspace_added'
  | 'workspace_changed'
  | 'workspace_deactivated'
  | 'repo_visibility_changed'
  | 'repo_archived'
  | 'repo_updated';

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

export type SyncableResourceType = 'memory_bank' | 'task' | 'skill' | 'session' | 'playbook' | 'team_template' | 'loadout' | 'repo';

// Workspace bindings — local-only, per-agent instance of a federated repo
// resource. See CLAUDE.md "Repos and Workspaces".
export interface Workspace {
  id: string;
  repo_id: string;       // FK syncable_resources(id) where resource_type='repo'
  agent_id: string;      // FK map_nodes(id)
  swarm_id: string;      // FK map_swarms(id)
  local_path: string;
  current_branch: string | null;
  head_sha: string | null;
  dirty: number;          // 0 | 1 (SQLite-friendly boolean)
  instance_label: string | null;
  visibility: 'private' | 'hub_local' | 'federated';
  is_active: number;      // 0 | 1
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}
export type ResourceVisibility = 'private' | 'shared' | 'public';
export type ResourcePermission = 'read' | 'write' | 'admin';
export type ResourceScope = 'global' | 'project' | 'agent' | 'manual';
export type SyncStrategy = 'metadata' | 'local' | 'ls-remote' | 'mirror' | 'bundle' | 'federated';

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
  sync_strategy: SyncStrategy;
  local_path: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  /**
   * Lifecycle status (V51). `'active'` is the default; the other values
   * are set by the slice 5b mesh lifecycle handlers + the corresponding
   * REST surface.
   */
  status: 'active' | 'redacted_remote' | 'archived' | 'merged_into';
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

// Playbook-specific metadata (learning engine output)
export interface PlaybookResourceMetadata {
  /** Number of playbooks in this resource */
  playbook_count?: number;
  /** Domains covered by playbooks */
  domains?: string[];
  /** Average confidence across playbooks */
  avg_confidence?: number;
  /** When the last batch learning run produced playbooks */
  last_batch_at?: string;
  /** Source hive instance ID if imported via sync */
  source_hive_id?: string;
  /** Provenance: 'local' if extracted locally, 'imported' if from peer hive */
  provenance?: 'local' | 'imported';
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

// Per-swarm workspace policy. Lives here (not in `src/swarm/types.ts`)
// because it's read by `src/db/dal/map.ts` and `src/map/workspace-policy.ts`,
// neither of which should import upward from the swarm hosting layer.
//
// Persisted as JSON in `map_swarms.workspace_policy`. See
// `src/map/CLAUDE.md` "Repos and Workspaces" for the four-gate
// enforcement model.
export interface WorkspacePolicy {
  mode: 'open' | 'allow_listed' | 'pinned';
  /** Canonical URLs (used when mode='allow_listed'). */
  allowed_repos?: string[];
  /** Canonical URL (used when mode='pinned'). */
  pinned_repo?: string;
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
