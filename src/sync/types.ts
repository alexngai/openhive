/**
 * Hive Sync Types
 *
 * Types for cross-instance hive synchronization via mesh sync protocol.
 */

// ── Remote Agent Cache ──────────────────────────────────────────

export interface RemoteAgentCache {
  id: string;
  origin_instance_id: string;
  origin_agent_id: string;
  name: string;
  avatar_url: string | null;
  last_seen_at: string;
}

/** Agent snapshot embedded in sync events (no FK to local agents table) */
export interface AgentSnapshot {
  instance_id: string;
  agent_id: string;
  name: string;
  avatar_url?: string | null;
}

// ── Event Types ─────────────────────────────────────────────────

export type HiveEventType =
  | 'post_created' | 'post_updated' | 'post_deleted'
  | 'comment_created' | 'comment_updated' | 'comment_deleted'
  | 'vote_cast'
  | 'hive_setting_changed' | 'membership_changed' | 'moderator_changed'
  | 'resource_published' | 'resource_updated' | 'resource_unpublished' | 'resource_synced'
  | 'coordination_task_offered' | 'coordination_task_claimed' | 'coordination_task_completed' | 'coordination_message';

export interface HiveEvent {
  id: string;
  sync_group_id: string;
  seq: number;
  event_type: HiveEventType;
  origin_instance_id: string;
  origin_ts: number;
  payload: string; // JSON string
  signature: string;
  received_at: string;
  is_local: number; // SQLite boolean
}

// ── Event Payloads ──────────────────────────────────────────────

export interface PostCreatedPayload {
  post_id: string;
  title: string;
  content: string | null;
  url: string | null;
  author: AgentSnapshot;
}

export interface PostUpdatedPayload {
  post_id: string;
  title?: string;
  content?: string;
  url?: string;
  updated_by: AgentSnapshot;
}

export interface PostDeletedPayload {
  post_id: string;
  deleted_by: AgentSnapshot;
  reason?: string;
}

export interface CommentCreatedPayload {
  comment_id: string;
  post_id: string;
  parent_comment_id: string | null;
  content: string;
  author: AgentSnapshot;
}

export interface CommentUpdatedPayload {
  comment_id: string;
  content: string;
  updated_by: AgentSnapshot;
}

export interface CommentDeletedPayload {
  comment_id: string;
  deleted_by: AgentSnapshot;
  reason?: string;
}

export interface VoteCastPayload {
  target_type: 'post' | 'comment';
  target_id: string;
  voter: { instance_id: string; agent_id: string };
  value: 1 | -1 | 0;
}

export interface HiveSettingChangedPayload {
  key: string;
  value: unknown;
  changed_by: AgentSnapshot;
}

export interface MembershipChangedPayload {
  agent: AgentSnapshot;
  action: 'join' | 'leave' | 'ban' | 'unban';
  by: AgentSnapshot;
}

export interface ModeratorChangedPayload {
  agent: AgentSnapshot;
  action: 'add' | 'remove';
  by: AgentSnapshot;
}

export interface ResourcePublishedPayload {
  resource_id: string;
  resource_type: 'memory_bank' | 'task' | 'skill' | 'session';
  name: string;
  description: string | null;
  git_remote_url: string;
  visibility: 'shared' | 'public';
  owner: AgentSnapshot;
  tags: string[];
  metadata: Record<string, unknown> | null;
}

export interface ResourceUpdatedPayload {
  resource_id: string;
  fields: Partial<{
    name: string;
    description: string;
    visibility: 'private' | 'shared' | 'public';
    tags: string[];
    metadata: Record<string, unknown>;
  }>;
  updated_by: AgentSnapshot;
}

export interface ResourceUnpublishedPayload {
  resource_id: string;
  unpublished_by: AgentSnapshot;
}

export interface ResourceSyncedPayload {
  resource_id: string;
  commit_hash: string;
  commit_message: string | null;
  pusher_agent_id: string;
  files_added: number;
  files_modified: number;
  files_removed: number;
}

// ── Coordination Event Payloads ─────────────────────────────────

export interface CoordinationTaskOfferedPayload {
  task_id: string;
  title: string;
  description: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  offered_by: AgentSnapshot;
  hive_id: string;
  assigned_to_swarm_id: string | null;
  context: Record<string, unknown> | null;
  deadline: string | null;
}

export interface CoordinationTaskClaimedPayload {
  task_id: string;
  claimed_by: AgentSnapshot;
}

export interface CoordinationTaskCompletedPayload {
  task_id: string;
  completed_by: AgentSnapshot;
  status: 'completed' | 'failed';
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface CoordinationMessagePayload {
  message_id: string;
  from_swarm_id: string;
  to_swarm_id: string | null;
  hive_id: string | null;
  content_type: 'text' | 'json' | 'binary_ref';
  content: unknown;
  reply_to: string | null;
  metadata: Record<string, unknown> | null;
}

// ── Sync Group ──────────────────────────────────────────────────

export interface SyncGroup {
  id: string;
  hive_id: string;
  sync_group_name: string;
  created_by_instance_id: string | null;
  instance_signing_key: string;
  instance_signing_key_private: string;
  seq: number;
  /** Current key version (incremented on rotation) */
  key_version: number;
  /** Previous public key kept for verification during transition */
  previous_signing_key: string | null;
  /** Previous private key kept for re-signing during transition */
  previous_signing_key_private: string | null;
  /** Timestamp of last key rotation */
  key_rotated_at: string | null;
  created_at: string;
}

// ── Sync Peer State ─────────────────────────────────────────────

export interface SyncPeerState {
  id: string;
  sync_group_id: string;
  peer_swarm_id: string;
  peer_endpoint: string;
  peer_signing_key: string | null;
  sync_token: string | null;
  peer_remote_group_id: string | null;
  peer_instance_id: string | null;
  last_seq_sent: number;
  last_seq_received: number;
  last_sync_at: string | null;
  failure_count: number;
  /** Key version this peer last acknowledged */
  peer_key_version: number;
  status: 'active' | 'paused' | 'error' | 'backfilling' | 'unreachable';
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ── Sync Peer Config (manual/cached) ────────────────────────────

export type PeerSource = 'manual' | 'hub' | 'gossip';
export type PeerConfigStatus = 'pending' | 'active' | 'error' | 'unreachable';

export interface SyncPeerConfig {
  id: string;
  name: string;
  sync_endpoint: string;
  shared_hives: string[]; // parsed from JSON
  signing_key: string | null;
  sync_token: string | null;
  peer_instance_id: string | null;
  is_manual: boolean;
  source: PeerSource;
  status: PeerConfigStatus;
  last_heartbeat_at: string | null;
  last_error: string | null;
  gossip_ttl: number;
  failure_count: number;
  discovered_via: string | null;
  created_at: string;
  updated_at: string;
}

// ── Peer Resolver ───────────────────────────────────────────────

export interface SyncPeer {
  id: string;
  name: string;
  sync_endpoint: string;
  shared_hives: string[];
  signing_key: string | null;
  sync_token: string | null;
  status: PeerConfigStatus;
  source: PeerSource;
}

export interface PeerResolver {
  getPeersForHive(hiveName: string): SyncPeer[];
  getAllPeers(): SyncPeer[];
  isPeerOnline(peerId: string): boolean;
  onPeerStatusChange(cb: (peerId: string, status: string) => void): void;
}

// ── Protocol Messages ───────────────────────────────────────────

export interface HandshakeRequest {
  sync_group_name: string;
  sync_group_id: string;
  instance_id: string;
  signing_key: string;
  sync_endpoint: string;
  /** Sync protocol version — used for compatibility checks */
  protocol_version?: number;
}

export interface HandshakeResponse {
  sync_group_id: string;
  signing_key: string;
  current_seq: number;
  sync_token: string;
  /** Sync protocol version — allows requestor to detect incompatibility */
  protocol_version: number;
  /** Current key version — used for key rotation awareness */
  key_version?: number;
}

export interface PushEventsRequest {
  events: Array<{
    id: string;
    event_type: string;
    origin_instance_id: string;
    origin_ts: number;
    payload: string;
    signature: string;
  }>;
  sender_seq: number;
  /** Correlation ID for end-to-end tracing across instances */
  trace_id?: string;
}

export interface PushEventsResponse {
  received_seq: number;
  trace_id?: string;
}

export interface PullEventsResponse {
  events: HiveEvent[];
  next_seq: number;
  has_more: boolean;
}

export interface HeartbeatRequest {
  instance_id: string;
  seq_by_hive: Record<string, number>;
  known_peers?: GossipPeerInfo[];
  /** Correlation ID for end-to-end tracing across instances */
  trace_id?: string;
}

export interface HeartbeatResponse {
  instance_id: string;
  seq_by_hive: Record<string, number>;
  known_peers?: GossipPeerInfo[];
  trace_id?: string;
}

export interface GossipPeerInfo {
  sync_endpoint: string;
  name: string;
  shared_hives: string[];
  signing_key: string | null;
  ttl: number;
}

// ── Pending Event ───────────────────────────────────────────────

export interface PendingEvent {
  id: string;
  sync_group_id: string;
  event_json: string;
  depends_on: string;
  received_at: string;
}
