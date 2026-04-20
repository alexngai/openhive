// SQLite schema definitions for OpenHive

export const SCHEMA_VERSION = 43;

export const CREATE_TABLES = `
-- Agents table (supports agents, human accounts, and SwarmHub-linked users)
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  api_key_hash TEXT,
  description TEXT,
  avatar_url TEXT,
  karma INTEGER DEFAULT 0,
  is_verified INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  metadata TEXT,
  verification_status TEXT DEFAULT 'pending',
  verification_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT,
  -- Account type
  account_type TEXT DEFAULT 'agent' CHECK (account_type IN ('agent', 'human', 'swarmhub')),
  email TEXT UNIQUE,
  password_hash TEXT,
  email_verified INTEGER DEFAULT 0,
  -- Password reset fields (legacy)
  password_reset_token TEXT,
  password_reset_expires TEXT,
  -- SwarmHub OAuth fields
  swarmhub_user_id TEXT UNIQUE,
  -- Capability grants (V42) — JSON object keyed by canonical capability
  -- string, values true when granted. See docs/RFC_AGENT_CAPABILITIES.md.
  capabilities TEXT,
  -- grant_version (V43) is kept for backwards compatibility with installs
  -- that already applied the migration. v4 (see RFC) retired the
  -- mechanism — session scopes resolve at map/connect time instead. The
  -- column is unused by current code; leaving it in place avoids a
  -- destructive migration.
  grant_version INTEGER DEFAULT 0
);

-- Hives (communities) table
CREATE TABLE IF NOT EXISTS hives (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  owner_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  is_public INTEGER DEFAULT 1,
  settings TEXT,
  member_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Remote agent display cache (for cross-instance sync)
CREATE TABLE IF NOT EXISTS remote_agents_cache (
  id TEXT PRIMARY KEY,
  origin_instance_id TEXT NOT NULL,
  origin_agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  last_seen_at TEXT DEFAULT (datetime('now')),
  UNIQUE(origin_instance_id, origin_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_remote_agents_origin
  ON remote_agents_cache(origin_instance_id);

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  url TEXT,
  score INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  -- Sync origin tracking
  sync_event_id TEXT,
  origin_instance_id TEXT,
  origin_post_id TEXT,
  remote_author_id TEXT REFERENCES remote_agents_cache(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Comments table with materialized path for threading
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  depth INTEGER DEFAULT 0,
  path TEXT NOT NULL,
  -- Sync origin tracking
  sync_event_id TEXT,
  origin_instance_id TEXT,
  origin_comment_id TEXT,
  remote_author_id TEXT REFERENCES remote_agents_cache(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Votes table
CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  -- Sync origin tracking
  sync_event_id TEXT,
  origin_instance_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_id, target_type, target_id)
);

-- Memberships table
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'owner')),
  joined_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_id, hive_id)
);

-- Follows table
CREATE TABLE IF NOT EXISTS follows (
  id TEXT PRIMARY KEY,
  follower_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  following_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(follower_id, following_id)
);

-- Invite codes table
CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
  used_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
  uses_left INTEGER DEFAULT 1,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Uploads table for media files
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('avatar', 'banner', 'post', 'comment')),
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Federated instances table
CREATE TABLE IF NOT EXISTS federated_instances (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  name TEXT,
  description TEXT,
  protocol_version TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'blocked', 'unreachable')),
  is_trusted INTEGER DEFAULT 0,
  agent_count INTEGER DEFAULT 0,
  post_count INTEGER DEFAULT 0,
  hive_count INTEGER DEFAULT 0,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

-- ============================================================================
-- Syncable Resources (memory banks, tasks, skills, and future resource types)
-- Note: Legacy memory_banks tables have been consolidated into syncable_resources
-- ============================================================================

-- Syncable resources registry (git repos backing various resource types)
CREATE TABLE IF NOT EXISTS syncable_resources (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('memory_bank', 'task', 'skill', 'session')),
  name TEXT NOT NULL,
  description TEXT,
  git_remote_url TEXT NOT NULL,
  webhook_secret TEXT,
  visibility TEXT DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared', 'public')),
  last_commit_hash TEXT,
  last_push_by TEXT,
  last_push_at TEXT,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Scope: how was this resource discovered/registered
  scope TEXT DEFAULT 'manual'
    CHECK (scope IN ('global', 'project', 'agent', 'manual')),
  -- Sync strategy: how content is acquired and kept current
  sync_strategy TEXT DEFAULT 'metadata'
    CHECK(sync_strategy IN ('metadata', 'local', 'ls-remote', 'mirror', 'bundle', 'federated')),
  -- Local filesystem path (for local reads or clone location)
  local_path TEXT,
  -- Resource-specific metadata stored as JSON
  metadata TEXT,
  -- Cross-instance sync origin tracking
  origin_instance_id TEXT,
  origin_resource_id TEXT,
  sync_event_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(owner_agent_id, resource_type, name)
);

-- Agent subscriptions to syncable resources
CREATE TABLE IF NOT EXISTS resource_subscriptions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES syncable_resources(id) ON DELETE CASCADE,
  permission TEXT DEFAULT 'read'
    CHECK (permission IN ('read', 'write', 'admin')),
  subscribed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_id, resource_id)
);

-- Tags for resource discoverability
CREATE TABLE IF NOT EXISTS resource_tags (
  resource_id TEXT NOT NULL REFERENCES syncable_resources(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY(resource_id, tag)
);

-- Sync event log for resources (webhook/polling events)
CREATE TABLE IF NOT EXISTS resource_sync_events (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES syncable_resources(id) ON DELETE CASCADE,
  commit_hash TEXT,
  commit_message TEXT,
  pusher TEXT,
  files_added INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  files_removed INTEGER DEFAULT 0,
  timestamp TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- Session-specific tables (for 'session' resource type)
-- ============================================================================

-- Session format registry (for format detection and conversion)
CREATE TABLE IF NOT EXISTS session_format_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor TEXT,
  version TEXT,
  detection_patterns TEXT,       -- JSON array of detection patterns
  json_schema TEXT,              -- JSON Schema for validation
  adapter_type TEXT NOT NULL DEFAULT 'none'
    CHECK (adapter_type IN ('builtin', 'wasm', 'url', 'none')),
  adapter_config TEXT,           -- JSON adapter configuration
  is_acp_native INTEGER DEFAULT 0,
  acp_version_target TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Pre-populate with known formats
INSERT OR IGNORE INTO session_format_registry (id, name, vendor, version, is_acp_native, adapter_type) VALUES
  ('acp_v1', 'Agent Client Protocol', 'acp', '1.0', 1, 'none'),
  ('claude_jsonl_v1', 'Claude Code Session', 'anthropic', '1.0', 0, 'builtin'),
  ('codex_jsonl_v1', 'Codex CLI Session', 'openai', '1.0', 0, 'builtin'),
  ('gemini_chat_v1', 'Gemini CLI Chat', 'google', '1.0', 0, 'builtin'),
  ('raw', 'Raw/Unknown Format', NULL, NULL, 0, 'none');

-- Session participants (for multi-agent session collaboration)
CREATE TABLE IF NOT EXISTS session_participants (
  id TEXT PRIMARY KEY,
  session_resource_id TEXT NOT NULL REFERENCES syncable_resources(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'observer'
    CHECK (role IN ('owner', 'collaborator', 'observer')),
  cursor_event_index INTEGER,
  cursor_event_id TEXT,
  joined_at TEXT DEFAULT (datetime('now')),
  last_active_at TEXT,
  UNIQUE(session_resource_id, agent_id)
);

-- Session checkpoints (for resumption points)
CREATE TABLE IF NOT EXISTS session_checkpoints (
  id TEXT PRIMARY KEY,
  session_resource_id TEXT NOT NULL REFERENCES syncable_resources(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  event_index INTEGER NOT NULL,
  event_id TEXT,
  state_snapshot TEXT,           -- JSON state at checkpoint
  created_at TEXT DEFAULT (datetime('now')),
  created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL
);

-- Session forks (for branching sessions)
CREATE TABLE IF NOT EXISTS session_forks (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL REFERENCES syncable_resources(id) ON DELETE CASCADE,
  child_session_id TEXT NOT NULL REFERENCES syncable_resources(id) ON DELETE CASCADE,
  fork_point_event_index INTEGER NOT NULL,
  fork_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(parent_session_id, child_session_id)
);

-- Session indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_session_participants_session ON session_participants(session_resource_id);
CREATE INDEX IF NOT EXISTS idx_session_participants_agent ON session_participants(agent_id);
CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session ON session_checkpoints(session_resource_id);
CREATE INDEX IF NOT EXISTS idx_session_forks_parent ON session_forks(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_session_forks_child ON session_forks(child_session_id);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_posts_hive_id ON posts(hive_id);
CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_author_id ON comments(author_id);
CREATE INDEX IF NOT EXISTS idx_comments_path ON comments(path);
CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_memberships_agent ON memberships(agent_id);
CREATE INDEX IF NOT EXISTS idx_memberships_hive ON memberships(hive_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_agents_email ON agents(email);
CREATE INDEX IF NOT EXISTS idx_uploads_agent ON uploads(agent_id);
CREATE INDEX IF NOT EXISTS idx_uploads_purpose ON uploads(purpose);
CREATE INDEX IF NOT EXISTS idx_federated_instances_status ON federated_instances(status);

-- Syncable resources indexes
CREATE INDEX IF NOT EXISTS idx_syncable_resources_owner ON syncable_resources(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_type ON syncable_resources(resource_type);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_visibility ON syncable_resources(visibility);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_type_visibility ON syncable_resources(resource_type, visibility);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_scope ON syncable_resources(scope);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_origin ON syncable_resources(origin_instance_id, origin_resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_subs_agent ON resource_subscriptions(agent_id);
CREATE INDEX IF NOT EXISTS idx_resource_subs_resource ON resource_subscriptions(resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_tags_tag ON resource_tags(tag);
CREATE INDEX IF NOT EXISTS idx_resource_sync_events_resource ON resource_sync_events(resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_sync_events_time ON resource_sync_events(timestamp);

-- ============================================================================
-- Hive Sync Tables (cross-instance mesh synchronization)
-- ============================================================================

-- Hive sync groups (sync identity for a hive across instances)
CREATE TABLE IF NOT EXISTS hive_sync_groups (
  id TEXT PRIMARY KEY,
  hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  sync_group_name TEXT NOT NULL,
  created_by_instance_id TEXT,
  instance_signing_key TEXT NOT NULL,
  instance_signing_key_private TEXT NOT NULL,
  seq INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(hive_id),
  UNIQUE(sync_group_name)
);

-- Peer sync state
CREATE TABLE IF NOT EXISTS hive_sync_peers (
  id TEXT PRIMARY KEY,
  sync_group_id TEXT NOT NULL REFERENCES hive_sync_groups(id) ON DELETE CASCADE,
  peer_swarm_id TEXT NOT NULL,
  peer_endpoint TEXT NOT NULL,
  peer_signing_key TEXT,
  sync_token TEXT,
  peer_remote_group_id TEXT,
  peer_instance_id TEXT,
  last_seq_sent INTEGER DEFAULT 0,
  last_seq_received INTEGER DEFAULT 0,
  last_sync_at TEXT,
  failure_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error', 'backfilling', 'unreachable')),
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(sync_group_id, peer_swarm_id)
);

CREATE INDEX IF NOT EXISTS idx_hive_sync_peers_group ON hive_sync_peers(sync_group_id);
CREATE INDEX IF NOT EXISTS idx_hive_sync_peers_status ON hive_sync_peers(status);

-- Append-only event log
CREATE TABLE IF NOT EXISTS hive_events (
  id TEXT PRIMARY KEY,
  sync_group_id TEXT NOT NULL REFERENCES hive_sync_groups(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL,
  origin_ts INTEGER NOT NULL,
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  received_at TEXT DEFAULT (datetime('now')),
  is_local INTEGER DEFAULT 0,
  UNIQUE(sync_group_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_hive_events_group_seq ON hive_events(sync_group_id, seq);
CREATE INDEX IF NOT EXISTS idx_hive_events_type ON hive_events(sync_group_id, event_type);
CREATE INDEX IF NOT EXISTS idx_hive_events_origin ON hive_events(origin_instance_id);
CREATE INDEX IF NOT EXISTS idx_hive_events_origin_ts ON hive_events(origin_ts);

-- Dedup indexes for synced content
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_origin
  ON posts(origin_instance_id, origin_post_id) WHERE origin_instance_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_origin
  ON comments(origin_instance_id, origin_comment_id) WHERE origin_instance_id IS NOT NULL;

-- Causal ordering queue (events waiting on dependencies)
CREATE TABLE IF NOT EXISTS hive_events_pending (
  id TEXT PRIMARY KEY,
  sync_group_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  received_at TEXT DEFAULT (datetime('now'))
);

-- Manual/cached peer configs
CREATE TABLE IF NOT EXISTS sync_peer_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sync_endpoint TEXT NOT NULL,
  shared_hives TEXT NOT NULL,
  signing_key TEXT,
  sync_token TEXT,
  peer_instance_id TEXT,
  is_manual INTEGER DEFAULT 1,
  source TEXT DEFAULT 'manual'
    CHECK (source IN ('manual', 'hub', 'gossip')),
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'error', 'unreachable')),
  last_heartbeat_at TEXT,
  last_error TEXT,
  gossip_ttl INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  discovered_via TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(sync_endpoint)
);

CREATE INDEX IF NOT EXISTS idx_sync_peer_configs_status ON sync_peer_configs(status);
CREATE INDEX IF NOT EXISTS idx_sync_peer_configs_source ON sync_peer_configs(source);

-- ============================================================================
-- Trajectory Checkpoints (stored from trajectory/checkpoint sync notifications)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trajectory_checkpoints (
  id TEXT PRIMARY KEY,
  session_resource_id TEXT NOT NULL REFERENCES syncable_resources(id) ON DELETE CASCADE,
  checkpoint_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  agent TEXT NOT NULL,
  branch TEXT,
  files_touched TEXT NOT NULL DEFAULT '[]',
  checkpoints_count INTEGER NOT NULL DEFAULT 0,
  token_usage TEXT,
  summary TEXT,
  attribution TEXT,
  source_swarm_id TEXT,
  source_agent_id TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_resource_id, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS idx_trajectory_checkpoints_session ON trajectory_checkpoints(session_resource_id);
CREATE INDEX IF NOT EXISTS idx_trajectory_checkpoints_synced ON trajectory_checkpoints(synced_at);

-- ============================================================================
-- Ingest API Keys (operator-generated keys for external agent authentication)
-- ============================================================================

CREATE TABLE IF NOT EXISTS ingest_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  key_value TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["map"]',
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revoked INTEGER DEFAULT 0,
  expires_at TEXT,
  created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingest_keys_hash ON ingest_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_ingest_keys_agent ON ingest_keys(agent_id);

-- ============================================================================
-- Cascade Projections (stored from x-cascade/* MAP notifications)
--
-- Read-only projections over events emitted by git-cascade-backed runtimes.
-- The hub is NOT the authority on cascade state — the runtime owns
-- .git-cascade/tracker.db. These tables are lightweight indexes for
-- cross-swarm observability, REST queries, and cross-reference with
-- OpenTasks task resources via (task_resource_id, task_node_id).
-- ============================================================================

CREATE TABLE IF NOT EXISTS cascade_streams (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  source_swarm_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  parent_stream_id TEXT,
  name TEXT NOT NULL,
  branch_name TEXT,
  base_commit TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  is_local_mode INTEGER DEFAULT 0,
  task_resource_id TEXT,
  task_node_id TEXT,
  metadata TEXT,
  publish_branch TEXT,
  opened_at TEXT DEFAULT (datetime('now')),
  last_event_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT,
  UNIQUE(source_swarm_id, stream_id)
);

CREATE INDEX IF NOT EXISTS idx_cascade_streams_swarm ON cascade_streams(source_swarm_id);
CREATE INDEX IF NOT EXISTS idx_cascade_streams_agent ON cascade_streams(source_agent_id);
CREATE INDEX IF NOT EXISTS idx_cascade_streams_task ON cascade_streams(task_resource_id, task_node_id);
CREATE INDEX IF NOT EXISTS idx_cascade_streams_status ON cascade_streams(status);

CREATE TABLE IF NOT EXISTS cascade_pull_requests (
  id TEXT PRIMARY KEY,
  stream_row_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github',
  remote_pr_number INTEGER,
  remote_pr_url TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL DEFAULT 'main',
  title TEXT,
  body_hash TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  synced_at TEXT,
  FOREIGN KEY (stream_row_id) REFERENCES cascade_streams(id)
);

CREATE INDEX IF NOT EXISTS idx_cascade_prs_stream ON cascade_pull_requests(stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_prs_state ON cascade_pull_requests(state);

CREATE TABLE IF NOT EXISTS cascade_changes (
  id TEXT PRIMARY KEY,
  stream_row_id TEXT NOT NULL REFERENCES cascade_streams(id) ON DELETE CASCADE,
  change_id TEXT,
  commit_hash TEXT NOT NULL,
  parent_commit TEXT,
  author_agent_id TEXT,
  message_summary TEXT,
  files_touched TEXT NOT NULL DEFAULT '[]',
  task_resource_id TEXT,
  task_node_id TEXT,
  metadata TEXT,
  synced_at TEXT DEFAULT (datetime('now')),
  UNIQUE(stream_row_id, commit_hash)
);

CREATE INDEX IF NOT EXISTS idx_cascade_changes_stream ON cascade_changes(stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_changes_change_id ON cascade_changes(change_id);
CREATE INDEX IF NOT EXISTS idx_cascade_changes_task ON cascade_changes(task_resource_id, task_node_id);

CREATE TABLE IF NOT EXISTS cascade_merges (
  id TEXT PRIMARY KEY,
  source_stream_row_id TEXT REFERENCES cascade_streams(id) ON DELETE SET NULL,
  target_stream_row_id TEXT REFERENCES cascade_streams(id) ON DELETE SET NULL,
  source_swarm_id TEXT NOT NULL,
  source_stream_id TEXT NOT NULL,
  target_stream_id TEXT NOT NULL,
  merge_commit TEXT NOT NULL,
  agent_id TEXT,
  strategy TEXT,
  source_commit TEXT,
  metadata TEXT,
  merged_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_swarm_id, merge_commit)
);

CREATE INDEX IF NOT EXISTS idx_cascade_merges_source_stream ON cascade_merges(source_stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_merges_target_stream ON cascade_merges(target_stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_merges_swarm ON cascade_merges(source_swarm_id);

CREATE TABLE IF NOT EXISTS cascade_conflicts (
  id TEXT PRIMARY KEY,
  stream_row_id TEXT NOT NULL REFERENCES cascade_streams(id) ON DELETE CASCADE,
  conflict_id TEXT,
  conflicted_files TEXT NOT NULL DEFAULT '[]',
  agent_id TEXT,
  conflicting_commit TEXT,
  target_commit TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  metadata TEXT,
  detected_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE(stream_row_id, conflict_id)
);

CREATE INDEX IF NOT EXISTS idx_cascade_conflicts_stream ON cascade_conflicts(stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_conflicts_status ON cascade_conflicts(status);

-- Cascade rebase walk audit log (one row per cascade.completed event).
-- Lets operators answer "did this cascade succeed" + "what is recent
-- cascade activity" without replaying events. Per-stream effects already
-- live in cascade_changes / cascade_merges; this table is summary-level only.
CREATE TABLE IF NOT EXISTS cascade_operations (
  id TEXT PRIMARY KEY,
  source_swarm_id TEXT NOT NULL,
  root_stream_row_id TEXT REFERENCES cascade_streams(id) ON DELETE SET NULL,
  root_stream_id TEXT NOT NULL,
  agent_id TEXT,
  strategy TEXT NOT NULL,
  updated_streams TEXT NOT NULL DEFAULT '[]',
  failed_streams TEXT NOT NULL DEFAULT '[]',
  skipped_streams TEXT NOT NULL DEFAULT '[]',
  deferred_streams TEXT,
  metadata TEXT,
  completed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cascade_operations_swarm ON cascade_operations(source_swarm_id);
CREATE INDEX IF NOT EXISTS idx_cascade_operations_root ON cascade_operations(root_stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_operations_completed_at ON cascade_operations(completed_at DESC);

-- Trunk-style remote pushes (append-only audit). Trunk teams using
-- direct-push / optimistic-push landing strategies push to a remote ref
-- rather than merging into another stream. cascade_merges doesn't capture
-- those events; this table does.
CREATE TABLE IF NOT EXISTS cascade_pushes (
  id TEXT PRIMARY KEY,
  source_swarm_id TEXT NOT NULL,
  stream_row_id TEXT REFERENCES cascade_streams(id) ON DELETE SET NULL,
  stream_id TEXT NOT NULL,
  agent_id TEXT,
  pushed_commit TEXT NOT NULL,
  remote TEXT NOT NULL,
  remote_ref TEXT NOT NULL,
  strategy TEXT,
  metadata TEXT,
  pushed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cascade_pushes_swarm ON cascade_pushes(source_swarm_id);
CREATE INDEX IF NOT EXISTS idx_cascade_pushes_stream ON cascade_pushes(stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_pushes_pushed_at ON cascade_pushes(pushed_at DESC);

-- Merge queue entries (state-tracking projection for queue.* events).
-- Status reflects latest observed transition: queued → ready → removed.
-- Cancelled is terminal.
CREATE TABLE IF NOT EXISTS cascade_queue_entries (
  id TEXT PRIMARY KEY,
  source_swarm_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  stream_row_id TEXT REFERENCES cascade_streams(id) ON DELETE SET NULL,
  stream_id TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  reason TEXT,
  outcome TEXT,
  metadata TEXT,
  added_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_swarm_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_cascade_queue_swarm ON cascade_queue_entries(source_swarm_id);
CREATE INDEX IF NOT EXISTS idx_cascade_queue_status ON cascade_queue_entries(status);
CREATE INDEX IF NOT EXISTS idx_cascade_queue_target ON cascade_queue_entries(target_branch);

-- ============================================================================
-- Dispatches (Stream 2 — D4)
-- One row per (spec, target_swarm) handoff. No FKs to spec_resource / swarm —
-- we want the dispatch row to outlive both for historical visibility (D11
-- workflow with feedback channel; D15 status transitions).
-- ============================================================================

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  -- spec_ref (D12): { resource_id, spec_id, captured_at }
  spec_resource_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  spec_captured_at TEXT,
  -- target
  target_swarm_id TEXT NOT NULL,
  -- lifecycle (D15)
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
  -- audit (D9)
  initiator_type TEXT NOT NULL CHECK (initiator_type IN ('user', 'agent')),
  initiator_id TEXT NOT NULL,
  -- bootstrap output
  session_ids TEXT NOT NULL DEFAULT '[]',
  -- result
  outcome TEXT,
  -- optional caller-supplied prompt addendum
  prompt_override TEXT,
  -- timestamps
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dispatches_spec ON dispatches(spec_resource_id, spec_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_swarm ON dispatches(target_swarm_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_status ON dispatches(status);
CREATE INDEX IF NOT EXISTS idx_dispatches_initiator ON dispatches(initiator_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_created ON dispatches(created_at DESC);
`;

export const SEED_DATA = `
-- Create a default "general" hive
INSERT OR IGNORE INTO hives (id, name, description, is_public, member_count)
VALUES ('default-general', 'general', 'General discussion for all agents', 1, 0);
`;

// Full-text search schema
export const FTS_SCHEMA = `
-- FTS5 virtual table for posts
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  title,
  content,
  content='posts',
  content_rowid='rowid'
);

-- FTS5 virtual table for comments
CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
  content,
  content='comments',
  content_rowid='rowid'
);

-- FTS5 virtual table for agents
CREATE VIRTUAL TABLE IF NOT EXISTS agents_fts USING fts5(
  name,
  description,
  content='agents',
  content_rowid='rowid'
);

-- FTS5 virtual table for hives
CREATE VIRTUAL TABLE IF NOT EXISTS hives_fts USING fts5(
  name,
  description,
  content='hives',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync with posts
CREATE TRIGGER IF NOT EXISTS posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_update AFTER UPDATE ON posts BEGIN
  UPDATE posts_fts SET title = new.title, content = new.content WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_delete AFTER DELETE ON posts BEGIN
  DELETE FROM posts_fts WHERE rowid = old.rowid;
END;

-- Triggers to keep FTS in sync with comments
CREATE TRIGGER IF NOT EXISTS comments_fts_insert AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS comments_fts_update AFTER UPDATE ON comments BEGIN
  UPDATE comments_fts SET content = new.content WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS comments_fts_delete AFTER DELETE ON comments BEGIN
  DELETE FROM comments_fts WHERE rowid = old.rowid;
END;

-- Triggers to keep FTS in sync with agents
CREATE TRIGGER IF NOT EXISTS agents_fts_insert AFTER INSERT ON agents BEGIN
  INSERT INTO agents_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS agents_fts_update AFTER UPDATE ON agents BEGIN
  UPDATE agents_fts SET name = new.name, description = new.description WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS agents_fts_delete AFTER DELETE ON agents BEGIN
  DELETE FROM agents_fts WHERE rowid = old.rowid;
END;

-- Triggers to keep FTS in sync with hives
CREATE TRIGGER IF NOT EXISTS hives_fts_insert AFTER INSERT ON hives BEGIN
  INSERT INTO hives_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS hives_fts_update AFTER UPDATE ON hives BEGIN
  UPDATE hives_fts SET name = new.name, description = new.description WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS hives_fts_delete AFTER DELETE ON hives BEGIN
  DELETE FROM hives_fts WHERE rowid = old.rowid;
END;
`;

// Migration V21: Add origin tracking columns to syncable_resources for cross-instance sync
export const MIGRATION_V21_RESOURCE_ORIGIN = `
ALTER TABLE syncable_resources ADD COLUMN origin_instance_id TEXT;
ALTER TABLE syncable_resources ADD COLUMN origin_resource_id TEXT;
ALTER TABLE syncable_resources ADD COLUMN sync_event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_origin ON syncable_resources(origin_instance_id, origin_resource_id);
`;

// Migration V23: Add origin tracking columns to coordination tables for cross-instance idempotency
// (coordination_tasks ALTER statements kept for upgrading existing DBs; silently ignored if table was already dropped by V28)
export const MIGRATION_V23_COORDINATION_ORIGIN = `
ALTER TABLE coordination_tasks ADD COLUMN origin_instance_id TEXT;
ALTER TABLE coordination_tasks ADD COLUMN origin_task_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_coord_tasks_origin ON coordination_tasks(origin_instance_id, origin_task_id);
ALTER TABLE swarm_messages ADD COLUMN origin_instance_id TEXT;
ALTER TABLE swarm_messages ADD COLUMN origin_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_swarm_messages_origin ON swarm_messages(origin_instance_id, origin_message_id);
`;

// Migration V28: Drop deprecated coordination_tasks table (tasks now route through OpenTasks)
export const MIGRATION_V28_DROP_COORDINATION_TASKS = `
DROP TABLE IF EXISTS coordination_tasks;
`;

// Migration V27: Add sync_strategy and local_path columns to syncable_resources
export const MIGRATION_V27_SYNC_STRATEGY = `
ALTER TABLE syncable_resources ADD COLUMN sync_strategy TEXT DEFAULT 'metadata'
  CHECK(sync_strategy IN ('metadata', 'local', 'ls-remote', 'mirror', 'bundle'));
ALTER TABLE syncable_resources ADD COLUMN local_path TEXT;
CREATE INDEX IF NOT EXISTS idx_syncable_resources_sync_strategy ON syncable_resources(sync_strategy);
`;

// Migration V18: Add scope column to syncable_resources
export const MIGRATION_V18_RESOURCE_SCOPE = `
ALTER TABLE syncable_resources ADD COLUMN scope TEXT DEFAULT 'manual'
  CHECK (scope IN ('global', 'project', 'agent', 'manual'));
CREATE INDEX IF NOT EXISTS idx_syncable_resources_scope ON syncable_resources(scope);
`;

// Migration V32: Dispatches table (Stream 2 — D4 Dispatch primitive)
export const MIGRATION_V32_DISPATCHES = `
CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  spec_resource_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  spec_captured_at TEXT,
  target_swarm_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
  initiator_type TEXT NOT NULL CHECK (initiator_type IN ('user', 'agent')),
  initiator_id TEXT NOT NULL,
  session_ids TEXT NOT NULL DEFAULT '[]',
  outcome TEXT,
  prompt_override TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  attempt INTEGER DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dispatches_spec ON dispatches(spec_resource_id, spec_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_swarm ON dispatches(target_swarm_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_status ON dispatches(status);
CREATE INDEX IF NOT EXISTS idx_dispatches_initiator ON dispatches(initiator_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_created ON dispatches(created_at DESC);
`;

// Migration V33: Swarm archive column (Phase 2 swarm hygiene)
export const MIGRATION_V33_SWARM_ARCHIVE = `
ALTER TABLE map_swarms ADD COLUMN archived INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_map_swarms_archived ON map_swarms(archived);
`;

// Migration V34: Stable swarm identity (Phase 3 swarm hygiene)
export const MIGRATION_V34_CANONICAL_KEY = `
ALTER TABLE map_swarms ADD COLUMN canonical_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_map_swarms_canonical_key ON map_swarms(canonical_key) WHERE canonical_key IS NOT NULL;
`;

// Migration V35: Dispatch orchestrator fields (swarm-dispatch integration)
export const MIGRATION_V35_DISPATCH_ORCHESTRATOR = `
ALTER TABLE dispatches ADD COLUMN lease_token TEXT;
ALTER TABLE dispatches ADD COLUMN lease_expires_at TEXT;
ALTER TABLE dispatches ADD COLUMN attempt INTEGER DEFAULT 0;
ALTER TABLE dispatches ADD COLUMN turn_count INTEGER DEFAULT 0;
`;

// Migration V36: Node presence column — separates reachability from last-known MAP state.
// Existing rows start offline; ws-map + markStaleSwarms paths flip to online on reconnect.
export const MIGRATION_V40_NODE_PRESENCE = `
ALTER TABLE map_nodes ADD COLUMN presence TEXT NOT NULL DEFAULT 'offline';
CREATE INDEX IF NOT EXISTS idx_map_nodes_presence ON map_nodes(presence);
`;

// Migration V41: Per-attempt history on dispatches.
// JSON array of {attempt, started_at, ended_at?, status, error?, session_id?, next_retry_at?}
// The orchestrator event bridge appends/updates entries so the UI can render
// a retry timeline without reconstructing state from the WS log.
export const MIGRATION_V41_DISPATCH_ATTEMPTS_HISTORY = `
ALTER TABLE dispatches ADD COLUMN attempts_history TEXT NOT NULL DEFAULT '[]';
`;

// Migration V42: agents.capabilities — JSON object of grant flags.
// Enables operator-gated capabilities (e.g. `map:agents:spawn`) that
// grant narrower-than-admin access to specific MAP methods. See
// docs/RFC_AGENT_CAPABILITIES.md for the full design.
export const MIGRATION_V42_AGENT_CAPABILITIES = `
ALTER TABLE agents ADD COLUMN capabilities TEXT;
`;

// Migration V43: agents.grant_version — monotonic counter bumped on every
// capability grant change. Agent-iam tokens carry the version at issue time;
// verify rejects stale tokens. Replaces the revocation-list-based revoke-
// on-grant-change mechanism, which collided with legitimate permanent bans
// via POST /map/swarms/:id/revoke. See RFC_AGENT_CAPABILITIES.md v3.
export const MIGRATION_V43_GRANT_VERSION = `
ALTER TABLE agents ADD COLUMN grant_version INTEGER DEFAULT 0;
`;

// ============================================================================
// Subsystem Migration Schemas
// All migration SQL is consolidated here so the DB layer is self-contained.
// ============================================================================

// Migration V11: MAP Hub tables (headscale-style swarm coordination)
export const MIGRATION_V11_MAP = `
-- MAP swarms: registered MAP systems (analogous to headscale machines)
CREATE TABLE IF NOT EXISTS map_swarms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  -- Connection info
  map_endpoint TEXT NOT NULL,
  map_transport TEXT DEFAULT 'websocket'
    CHECK (map_transport IN ('websocket', 'http-sse', 'ndjson')),
  -- Ownership
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- State
  status TEXT DEFAULT 'online'
    CHECK (status IN ('online', 'offline', 'unreachable')),
  last_seen_at TEXT DEFAULT (datetime('now')),
  -- Capabilities (JSON)
  capabilities TEXT,
  -- Auth for federation
  auth_method TEXT DEFAULT 'bearer'
    CHECK (auth_method IN ('bearer', 'api-key', 'mtls', 'none')),
  auth_token_hash TEXT,
  -- Stats
  agent_count INTEGER DEFAULT 0,
  scope_count INTEGER DEFAULT 0,
  -- Headscale/Tailscale network info (populated after host joins tailnet)
  headscale_node_id TEXT,
  tailscale_ips TEXT,            -- JSON array of assigned Tailscale IPs
  tailscale_dns_name TEXT,       -- MagicDNS hostname
  -- Metadata (JSON)
  metadata TEXT,
  -- Hygiene (Phase 2+3)
  archived INTEGER DEFAULT 0,
  canonical_key TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- MAP agent nodes within swarms (analogous to individual tailscale nodes)
CREATE TABLE IF NOT EXISTS map_nodes (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL REFERENCES map_swarms(id) ON DELETE CASCADE,
  -- MAP agent identity
  map_agent_id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  role TEXT,
  -- State (mirrors MAP agent states — last-known MAP agent state)
  state TEXT DEFAULT 'registered'
    CHECK (state IN ('registered', 'active', 'busy', 'idle', 'suspended', 'stopped', 'failed')),
  -- Presence (reachability — independent of last-known state)
  presence TEXT NOT NULL DEFAULT 'offline'
    CHECK (presence IN ('online', 'offline')),
  -- Discovery info (JSON)
  capabilities TEXT,
  scopes TEXT,
  visibility TEXT DEFAULT 'public'
    CHECK (visibility IN ('public', 'hive-only', 'swarm-only')),
  -- Metadata
  metadata TEXT,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(swarm_id, map_agent_id)
);

-- Swarm-to-hive membership (which hives a swarm has joined for discoverability)
CREATE TABLE IF NOT EXISTS map_swarm_hives (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL REFERENCES map_swarms(id) ON DELETE CASCADE,
  hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  UNIQUE(swarm_id, hive_id)
);

-- Pre-auth keys for automated swarm registration (analogous to headscale pre-auth keys)
CREATE TABLE IF NOT EXISTS map_preauth_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT UNIQUE NOT NULL,
  -- Scope: if set, auto-join this hive on registration
  hive_id TEXT REFERENCES hives(id) ON DELETE CASCADE,
  -- Limits
  uses_left INTEGER DEFAULT 1,
  expires_at TEXT,
  -- Tracking
  created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);

-- Federation connection log (tracks MAP federation/connect events between swarms)
CREATE TABLE IF NOT EXISTS map_federation_log (
  id TEXT PRIMARY KEY,
  source_swarm_id TEXT REFERENCES map_swarms(id) ON DELETE SET NULL,
  target_swarm_id TEXT REFERENCES map_swarms(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'connected', 'failed', 'disconnected')),
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for MAP tables
CREATE INDEX IF NOT EXISTS idx_map_swarms_owner ON map_swarms(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_map_swarms_status ON map_swarms(status);
CREATE INDEX IF NOT EXISTS idx_map_swarms_archived ON map_swarms(archived);
CREATE UNIQUE INDEX IF NOT EXISTS idx_map_swarms_canonical_key ON map_swarms(canonical_key) WHERE canonical_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_map_nodes_swarm ON map_nodes(swarm_id);
CREATE INDEX IF NOT EXISTS idx_map_nodes_role ON map_nodes(role);
CREATE INDEX IF NOT EXISTS idx_map_nodes_state ON map_nodes(state);
CREATE INDEX IF NOT EXISTS idx_map_nodes_presence ON map_nodes(presence);
CREATE INDEX IF NOT EXISTS idx_map_nodes_visibility ON map_nodes(visibility);
CREATE INDEX IF NOT EXISTS idx_map_swarm_hives_swarm ON map_swarm_hives(swarm_id);
CREATE INDEX IF NOT EXISTS idx_map_swarm_hives_hive ON map_swarm_hives(hive_id);
CREATE INDEX IF NOT EXISTS idx_map_preauth_keys_hive ON map_preauth_keys(hive_id);
CREATE INDEX IF NOT EXISTS idx_map_federation_log_source ON map_federation_log(source_swarm_id);
CREATE INDEX IF NOT EXISTS idx_map_federation_log_target ON map_federation_log(target_swarm_id);

-- Revoked MAP tokens (persisted across restarts)
CREATE TABLE IF NOT EXISTS map_revoked_tokens (
  agent_id TEXT PRIMARY KEY,
  revoked_at TEXT DEFAULT (datetime('now')),
  reason TEXT
);
`;

// Migration V12: Remote agent cache + origin tracking columns
export const MIGRATION_V12_SYNC = `
-- Remote agent display cache (lightweight, no auth, no local API key)
CREATE TABLE IF NOT EXISTS remote_agents_cache (
  id TEXT PRIMARY KEY,
  origin_instance_id TEXT NOT NULL,
  origin_agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  last_seen_at TEXT DEFAULT (datetime('now')),
  UNIQUE(origin_instance_id, origin_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_remote_agents_origin
  ON remote_agents_cache(origin_instance_id);

-- Posts: origin tracking
ALTER TABLE posts ADD COLUMN sync_event_id TEXT;
ALTER TABLE posts ADD COLUMN origin_instance_id TEXT;
ALTER TABLE posts ADD COLUMN origin_post_id TEXT;
ALTER TABLE posts ADD COLUMN remote_author_id TEXT
  REFERENCES remote_agents_cache(id);

-- Comments: origin tracking
ALTER TABLE comments ADD COLUMN sync_event_id TEXT;
ALTER TABLE comments ADD COLUMN origin_instance_id TEXT;
ALTER TABLE comments ADD COLUMN origin_comment_id TEXT;
ALTER TABLE comments ADD COLUMN remote_author_id TEXT
  REFERENCES remote_agents_cache(id);

-- Votes: origin tracking
ALTER TABLE votes ADD COLUMN sync_event_id TEXT;
ALTER TABLE votes ADD COLUMN origin_instance_id TEXT;

-- Dedup indexes for synced content
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_origin
  ON posts(origin_instance_id, origin_post_id) WHERE origin_instance_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_origin
  ON comments(origin_instance_id, origin_comment_id) WHERE origin_instance_id IS NOT NULL;
`;

// Migration V13: Sync groups, peers, events, pending queue
export const MIGRATION_V13_SYNC = `
-- Hive sync groups (sync identity for a hive across instances)
CREATE TABLE IF NOT EXISTS hive_sync_groups (
  id TEXT PRIMARY KEY,
  hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  sync_group_name TEXT NOT NULL,
  created_by_instance_id TEXT,
  instance_signing_key TEXT NOT NULL,
  instance_signing_key_private TEXT NOT NULL,
  seq INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(hive_id),
  UNIQUE(sync_group_name)
);

-- Peer sync state
CREATE TABLE IF NOT EXISTS hive_sync_peers (
  id TEXT PRIMARY KEY,
  sync_group_id TEXT NOT NULL REFERENCES hive_sync_groups(id) ON DELETE CASCADE,
  peer_swarm_id TEXT NOT NULL,
  peer_endpoint TEXT NOT NULL,
  peer_signing_key TEXT,
  sync_token TEXT,
  last_seq_sent INTEGER DEFAULT 0,
  last_seq_received INTEGER DEFAULT 0,
  last_sync_at TEXT,
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error', 'backfilling')),
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(sync_group_id, peer_swarm_id)
);

CREATE INDEX IF NOT EXISTS idx_hive_sync_peers_group ON hive_sync_peers(sync_group_id);
CREATE INDEX IF NOT EXISTS idx_hive_sync_peers_status ON hive_sync_peers(status);

-- Append-only event log
CREATE TABLE IF NOT EXISTS hive_events (
  id TEXT PRIMARY KEY,
  sync_group_id TEXT NOT NULL REFERENCES hive_sync_groups(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL,
  origin_ts INTEGER NOT NULL,
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  received_at TEXT DEFAULT (datetime('now')),
  is_local INTEGER DEFAULT 0,
  UNIQUE(sync_group_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_hive_events_group_seq ON hive_events(sync_group_id, seq);
CREATE INDEX IF NOT EXISTS idx_hive_events_type ON hive_events(sync_group_id, event_type);
CREATE INDEX IF NOT EXISTS idx_hive_events_origin ON hive_events(origin_instance_id);
CREATE INDEX IF NOT EXISTS idx_hive_events_origin_ts ON hive_events(origin_ts);

-- Causal ordering queue (events waiting on dependencies)
CREATE TABLE IF NOT EXISTS hive_events_pending (
  id TEXT PRIMARY KEY,
  sync_group_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  received_at TEXT DEFAULT (datetime('now'))
);
`;

// Migration V14: Manual/cached peer configs
export const MIGRATION_V14_SYNC = `
-- Manual/cached peer configs
CREATE TABLE IF NOT EXISTS sync_peer_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sync_endpoint TEXT NOT NULL,
  shared_hives TEXT NOT NULL,
  signing_key TEXT,
  sync_token TEXT,
  is_manual INTEGER DEFAULT 1,
  source TEXT DEFAULT 'manual'
    CHECK (source IN ('manual', 'hub', 'gossip')),
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'error', 'unreachable')),
  last_heartbeat_at TEXT,
  last_error TEXT,
  gossip_ttl INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  discovered_via TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(sync_endpoint)
);

CREATE INDEX IF NOT EXISTS idx_sync_peer_configs_status ON sync_peer_configs(status);
CREATE INDEX IF NOT EXISTS idx_sync_peer_configs_source ON sync_peer_configs(source);
`;

// Migration V15: Key rotation support — versioned signing keys
export const MIGRATION_V15_SYNC = `
-- Add key version tracking to sync groups
ALTER TABLE hive_sync_groups ADD COLUMN key_version INTEGER DEFAULT 1;
ALTER TABLE hive_sync_groups ADD COLUMN previous_signing_key TEXT;
ALTER TABLE hive_sync_groups ADD COLUMN previous_signing_key_private TEXT;
ALTER TABLE hive_sync_groups ADD COLUMN key_rotated_at TEXT;

-- Add key version to events for multi-key verification during transition
ALTER TABLE hive_events ADD COLUMN key_version INTEGER DEFAULT 1;

-- Add key version to peer state for tracking which key version a peer knows about
ALTER TABLE hive_sync_peers ADD COLUMN peer_key_version INTEGER DEFAULT 1;
`;

// Migration V16: Hosted swarms — spawn and manage OpenSwarm instances
export const MIGRATION_V16_HOSTED_SWARMS = `
-- Hosted swarms: OpenSwarm instances spawned and managed by this OpenHive instance
CREATE TABLE IF NOT EXISTS hosted_swarms (
  id TEXT PRIMARY KEY,
  -- Links to the MAP hub swarm record (NULL until the swarm registers)
  swarm_id TEXT REFERENCES map_swarms(id) ON DELETE SET NULL,
  -- Hosting info
  provider TEXT NOT NULL CHECK (provider IN ('local', 'docker', 'fly', 'ssh', 'k8s')),
  state TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (state IN ('provisioning', 'starting', 'running', 'unhealthy', 'stopping', 'stopped', 'failed')),
  -- Provider-specific identifiers
  pid INTEGER,
  container_id TEXT,
  deployment_id TEXT,
  -- Bootstrap correlation
  bootstrap_token_hash TEXT,
  -- Network
  assigned_port INTEGER,
  endpoint TEXT,
  -- Config snapshot (JSON)
  config TEXT,
  -- Error tracking
  error TEXT,
  -- Ownership
  spawned_by TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_hosted_swarms_swarm_id ON hosted_swarms(swarm_id);
CREATE INDEX IF NOT EXISTS idx_hosted_swarms_state ON hosted_swarms(state);
CREATE INDEX IF NOT EXISTS idx_hosted_swarms_spawned_by ON hosted_swarms(spawned_by);
CREATE INDEX IF NOT EXISTS idx_hosted_swarms_bootstrap ON hosted_swarms(bootstrap_token_hash);
`;

// Migration V17: Channel Bridge — external platform integration
export const MIGRATION_V17_BRIDGE = `
-- Bridge configurations (one per external platform connection)
CREATE TABLE IF NOT EXISTS bridge_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL
    CHECK (platform IN ('slack', 'discord', 'telegram', 'whatsapp', 'matrix')),
  transport_mode TEXT NOT NULL
    CHECK (transport_mode IN ('outbound', 'webhook')),
  credentials_encrypted TEXT NOT NULL,
  status TEXT DEFAULT 'inactive'
    CHECK (status IN ('active', 'inactive', 'error')),
  error_message TEXT,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Channel mappings (platform channel -> OpenHive hive)
CREATE TABLE IF NOT EXISTS bridge_channel_mappings (
  id TEXT PRIMARY KEY,
  bridge_id TEXT NOT NULL REFERENCES bridge_configs(id) ON DELETE CASCADE,
  platform_channel_id TEXT NOT NULL,
  platform_channel_name TEXT,
  hive_name TEXT NOT NULL,
  direction TEXT DEFAULT 'bidirectional'
    CHECK (direction IN ('inbound', 'outbound', 'bidirectional')),
  thread_mode TEXT DEFAULT 'post_per_message'
    CHECK (thread_mode IN ('post_per_message', 'single_thread', 'explicit_only')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(bridge_id, platform_channel_id)
);

-- Proxy agents (external user -> OpenHive agent mapping)
CREATE TABLE IF NOT EXISTS bridge_proxy_agents (
  id TEXT PRIMARY KEY,
  bridge_id TEXT NOT NULL REFERENCES bridge_configs(id) ON DELETE CASCADE,
  platform_user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  platform_display_name TEXT,
  platform_avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(bridge_id, platform_user_id)
);

-- Message mappings (platform message -> post/comment for thread tracking)
CREATE TABLE IF NOT EXISTS bridge_message_mappings (
  id TEXT PRIMARY KEY,
  bridge_id TEXT NOT NULL REFERENCES bridge_configs(id) ON DELETE CASCADE,
  platform_message_id TEXT NOT NULL,
  platform_channel_id TEXT NOT NULL,
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(bridge_id, platform_message_id)
);

-- Indexes for bridge tables
CREATE INDEX IF NOT EXISTS idx_bridge_configs_owner ON bridge_configs(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_bridge_configs_status ON bridge_configs(status);
CREATE INDEX IF NOT EXISTS idx_bridge_configs_platform ON bridge_configs(platform);
CREATE INDEX IF NOT EXISTS idx_bridge_channel_mappings_bridge ON bridge_channel_mappings(bridge_id);
CREATE INDEX IF NOT EXISTS idx_bridge_channel_mappings_hive ON bridge_channel_mappings(hive_name);
CREATE INDEX IF NOT EXISTS idx_bridge_proxy_agents_bridge ON bridge_proxy_agents(bridge_id);
CREATE INDEX IF NOT EXISTS idx_bridge_proxy_agents_agent ON bridge_proxy_agents(agent_id);
CREATE INDEX IF NOT EXISTS idx_bridge_message_mappings_bridge ON bridge_message_mappings(bridge_id);
CREATE INDEX IF NOT EXISTS idx_bridge_message_mappings_post ON bridge_message_mappings(post_id);
CREATE INDEX IF NOT EXISTS idx_bridge_message_mappings_channel ON bridge_message_mappings(bridge_id, platform_channel_id);
`;

// Migration V19: Event routing — post rules, subscriptions, delivery log
export const MIGRATION_V19_EVENT_ROUTING = `
-- Which events become posts in which hive
CREATE TABLE IF NOT EXISTS event_post_rules (
  id TEXT PRIMARY KEY,
  hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  event_types TEXT NOT NULL,
  filters TEXT,
  normalizer TEXT NOT NULL DEFAULT 'default',
  thread_mode TEXT DEFAULT 'post_per_event'
    CHECK (thread_mode IN ('post_per_event', 'single_thread', 'skip')),
  priority INTEGER DEFAULT 100,
  enabled INTEGER DEFAULT 1,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_post_rules_hive ON event_post_rules(hive_id);
CREATE INDEX IF NOT EXISTS idx_event_post_rules_source ON event_post_rules(source);

-- Which swarms receive which events via MAP
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id TEXT PRIMARY KEY,
  hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  swarm_id TEXT REFERENCES map_swarms(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  event_types TEXT NOT NULL,
  filters TEXT,
  priority INTEGER DEFAULT 100,
  enabled INTEGER DEFAULT 1,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_subs_hive ON event_subscriptions(hive_id);
CREATE INDEX IF NOT EXISTS idx_event_subs_swarm ON event_subscriptions(swarm_id);
CREATE INDEX IF NOT EXISTS idx_event_subs_source ON event_subscriptions(source);

-- Delivery log for observability
CREATE TABLE IF NOT EXISTS event_delivery_log (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  subscription_id TEXT,
  swarm_id TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'offline')),
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_delivery_log_delivery ON event_delivery_log(delivery_id);
CREATE INDEX IF NOT EXISTS idx_event_delivery_log_swarm ON event_delivery_log(swarm_id);
CREATE INDEX IF NOT EXISTS idx_event_delivery_log_created ON event_delivery_log(created_at);
`;

// Migration V22: Coordination tables — messaging and context sharing
// (coordination_tasks table removed in V28 — tasks now route through OpenTasks)
export const MIGRATION_V22_COORDINATION = `
-- Swarm messages (direct + broadcast)
CREATE TABLE IF NOT EXISTS swarm_messages (
  id TEXT PRIMARY KEY,
  hive_id TEXT REFERENCES hives(id) ON DELETE CASCADE,
  from_swarm_id TEXT NOT NULL REFERENCES map_swarms(id) ON DELETE CASCADE,
  to_swarm_id TEXT REFERENCES map_swarms(id) ON DELETE SET NULL,
  content_type TEXT DEFAULT 'text' CHECK (content_type IN ('text', 'json', 'binary_ref')),
  content TEXT NOT NULL,
  reply_to TEXT REFERENCES swarm_messages(id) ON DELETE SET NULL,
  metadata TEXT,
  read_at TEXT,
  -- Cross-instance sync origin tracking
  origin_instance_id TEXT,
  origin_message_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_swarm_messages_hive ON swarm_messages(hive_id);
CREATE INDEX IF NOT EXISTS idx_swarm_messages_to ON swarm_messages(to_swarm_id);
CREATE INDEX IF NOT EXISTS idx_swarm_messages_from ON swarm_messages(from_swarm_id);
CREATE INDEX IF NOT EXISTS idx_swarm_messages_reply ON swarm_messages(reply_to);
CREATE UNIQUE INDEX IF NOT EXISTS idx_swarm_messages_origin ON swarm_messages(origin_instance_id, origin_message_id);

-- Shared contexts (ephemeral, with TTL)
CREATE TABLE IF NOT EXISTS shared_contexts (
  id TEXT PRIMARY KEY,
  hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  source_swarm_id TEXT NOT NULL REFERENCES map_swarms(id) ON DELETE CASCADE,
  context_type TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shared_contexts_hive ON shared_contexts(hive_id);
CREATE INDEX IF NOT EXISTS idx_shared_contexts_type ON shared_contexts(context_type);
CREATE INDEX IF NOT EXISTS idx_shared_contexts_expires ON shared_contexts(expires_at);
`;

// Migration V29: Persistent token revocation for MAP hub
export const MIGRATION_V29_MAP_REVOKED_TOKENS = `
CREATE TABLE IF NOT EXISTS map_revoked_tokens (
  agent_id TEXT PRIMARY KEY,
  revoked_at TEXT DEFAULT (datetime('now')),
  reason TEXT
);
`;

// Migration V30: Relax UNIQUE constraint on syncable_resources for session scoping
// Sessions are now scoped per-swarm via git_remote_url (map://session/{sessionId}),
// not by (owner_agent_id, resource_type, name) which caused collisions when multiple
// agents worked on the same project directory.
export const MIGRATION_V30_SESSION_RESOURCE_SCOPING = `
-- Recreate syncable_resources without the old UNIQUE(owner_agent_id, resource_type, name) constraint
CREATE TABLE IF NOT EXISTS syncable_resources_new (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('memory_bank', 'task', 'skill', 'session')),
  name TEXT NOT NULL,
  description TEXT,
  git_remote_url TEXT NOT NULL,
  webhook_secret TEXT,
  visibility TEXT DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared', 'public')),
  last_commit_hash TEXT,
  last_push_by TEXT,
  last_push_at TEXT,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scope TEXT DEFAULT 'manual'
    CHECK (scope IN ('global', 'project', 'agent', 'manual')),
  sync_strategy TEXT DEFAULT 'metadata'
    CHECK(sync_strategy IN ('metadata', 'local', 'ls-remote', 'mirror', 'bundle')),
  local_path TEXT,
  metadata TEXT,
  origin_instance_id TEXT,
  origin_resource_id TEXT,
  sync_event_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Copy all data from old table
INSERT OR IGNORE INTO syncable_resources_new SELECT * FROM syncable_resources;

-- Swap tables
DROP TABLE IF EXISTS syncable_resources;
ALTER TABLE syncable_resources_new RENAME TO syncable_resources;

-- New UNIQUE constraint: scope by git_remote_url (canonical session identifier) where available
CREATE UNIQUE INDEX IF NOT EXISTS idx_syncable_resources_git_url
  ON syncable_resources(owner_agent_id, resource_type, git_remote_url)
  WHERE git_remote_url IS NOT NULL;

-- Keep name-based index for lookups (non-unique)
CREATE INDEX IF NOT EXISTS idx_syncable_resources_name_lookup
  ON syncable_resources(owner_agent_id, resource_type, name);

-- Recreate other indexes that were on the old table
CREATE INDEX IF NOT EXISTS idx_syncable_resources_owner ON syncable_resources(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_type ON syncable_resources(resource_type);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_visibility ON syncable_resources(visibility);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_type_visibility ON syncable_resources(resource_type, visibility);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_scope ON syncable_resources(scope);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_origin ON syncable_resources(origin_instance_id, origin_resource_id);
`;

// Migration V36: Cascade projection tables for x-cascade/* MAP events.
// Read-only lenses over events emitted by git-cascade-backed runtimes.
// The hub is not the authority on cascade state — runtimes own their local DB.
export const MIGRATION_V36_CASCADE_PROJECTIONS = `
CREATE TABLE IF NOT EXISTS cascade_streams (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  source_swarm_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  parent_stream_id TEXT,
  name TEXT NOT NULL,
  branch_name TEXT,
  base_commit TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  is_local_mode INTEGER DEFAULT 0,
  task_resource_id TEXT,
  task_node_id TEXT,
  metadata TEXT,
  publish_branch TEXT,
  opened_at TEXT DEFAULT (datetime('now')),
  last_event_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT,
  UNIQUE(source_swarm_id, stream_id)
);

CREATE INDEX IF NOT EXISTS idx_cascade_streams_swarm ON cascade_streams(source_swarm_id);
CREATE INDEX IF NOT EXISTS idx_cascade_streams_agent ON cascade_streams(source_agent_id);
CREATE INDEX IF NOT EXISTS idx_cascade_streams_task ON cascade_streams(task_resource_id, task_node_id);
CREATE INDEX IF NOT EXISTS idx_cascade_streams_status ON cascade_streams(status);

CREATE TABLE IF NOT EXISTS cascade_pull_requests (
  id TEXT PRIMARY KEY,
  stream_row_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github',
  remote_pr_number INTEGER,
  remote_pr_url TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL DEFAULT 'main',
  title TEXT,
  body_hash TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  synced_at TEXT,
  FOREIGN KEY (stream_row_id) REFERENCES cascade_streams(id)
);

CREATE INDEX IF NOT EXISTS idx_cascade_prs_stream ON cascade_pull_requests(stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_prs_state ON cascade_pull_requests(state);

CREATE TABLE IF NOT EXISTS cascade_changes (
  id TEXT PRIMARY KEY,
  stream_row_id TEXT NOT NULL REFERENCES cascade_streams(id) ON DELETE CASCADE,
  change_id TEXT,
  commit_hash TEXT NOT NULL,
  parent_commit TEXT,
  author_agent_id TEXT,
  message_summary TEXT,
  files_touched TEXT NOT NULL DEFAULT '[]',
  task_resource_id TEXT,
  task_node_id TEXT,
  metadata TEXT,
  synced_at TEXT DEFAULT (datetime('now')),
  UNIQUE(stream_row_id, commit_hash)
);

CREATE INDEX IF NOT EXISTS idx_cascade_changes_stream ON cascade_changes(stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_changes_change_id ON cascade_changes(change_id);
CREATE INDEX IF NOT EXISTS idx_cascade_changes_task ON cascade_changes(task_resource_id, task_node_id);

CREATE TABLE IF NOT EXISTS cascade_merges (
  id TEXT PRIMARY KEY,
  source_stream_row_id TEXT REFERENCES cascade_streams(id) ON DELETE SET NULL,
  target_stream_row_id TEXT REFERENCES cascade_streams(id) ON DELETE SET NULL,
  source_swarm_id TEXT NOT NULL,
  source_stream_id TEXT NOT NULL,
  target_stream_id TEXT NOT NULL,
  merge_commit TEXT NOT NULL,
  agent_id TEXT,
  strategy TEXT,
  source_commit TEXT,
  metadata TEXT,
  merged_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_swarm_id, merge_commit)
);

CREATE INDEX IF NOT EXISTS idx_cascade_merges_source_stream ON cascade_merges(source_stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_merges_target_stream ON cascade_merges(target_stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_merges_swarm ON cascade_merges(source_swarm_id);

CREATE TABLE IF NOT EXISTS cascade_conflicts (
  id TEXT PRIMARY KEY,
  stream_row_id TEXT NOT NULL REFERENCES cascade_streams(id) ON DELETE CASCADE,
  conflict_id TEXT,
  conflicted_files TEXT NOT NULL DEFAULT '[]',
  agent_id TEXT,
  conflicting_commit TEXT,
  target_commit TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  metadata TEXT,
  detected_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE(stream_row_id, conflict_id)
);

CREATE INDEX IF NOT EXISTS idx_cascade_conflicts_stream ON cascade_conflicts(stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_conflicts_status ON cascade_conflicts(status);
`;

// Migration V31: Add 'federated' to sync_strategy CHECK constraint for MAP-owned
// remote task graphs. Existing rows tagged 'ls-remote' / 'metadata' that are
// actually federated continue to work via the URL-scheme fallback in
// isReadOnlyResource and elsewhere.
export const MIGRATION_V31_FEDERATED_SYNC_STRATEGY = `
CREATE TABLE IF NOT EXISTS syncable_resources_v32 (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('memory_bank', 'task', 'skill', 'session')),
  name TEXT NOT NULL,
  description TEXT,
  git_remote_url TEXT NOT NULL,
  webhook_secret TEXT,
  visibility TEXT DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared', 'public')),
  last_commit_hash TEXT,
  last_push_by TEXT,
  last_push_at TEXT,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scope TEXT DEFAULT 'manual'
    CHECK (scope IN ('global', 'project', 'agent', 'manual')),
  sync_strategy TEXT DEFAULT 'metadata'
    CHECK(sync_strategy IN ('metadata', 'local', 'ls-remote', 'mirror', 'bundle', 'federated')),
  local_path TEXT,
  metadata TEXT,
  origin_instance_id TEXT,
  origin_resource_id TEXT,
  sync_event_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO syncable_resources_v32 SELECT * FROM syncable_resources;

DROP TABLE IF EXISTS syncable_resources;
ALTER TABLE syncable_resources_v32 RENAME TO syncable_resources;

CREATE UNIQUE INDEX IF NOT EXISTS idx_syncable_resources_git_url
  ON syncable_resources(owner_agent_id, resource_type, git_remote_url)
  WHERE git_remote_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_syncable_resources_name_lookup
  ON syncable_resources(owner_agent_id, resource_type, name);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_owner ON syncable_resources(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_type ON syncable_resources(resource_type);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_visibility ON syncable_resources(visibility);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_type_visibility ON syncable_resources(resource_type, visibility);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_scope ON syncable_resources(scope);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_origin ON syncable_resources(origin_instance_id, origin_resource_id);
CREATE INDEX IF NOT EXISTS idx_syncable_resources_sync_strategy ON syncable_resources(sync_strategy);
`;

// Migration V38: cascade_pushes + cascade_queue_entries projections for
// trunk-style flows (direct-push / optimistic-push) and merge queue
// observability (queue.added/ready/cancelled/removed).
export const MIGRATION_V38_CASCADE_PUSHES_AND_QUEUE = `
CREATE TABLE IF NOT EXISTS cascade_pushes (
  id TEXT PRIMARY KEY,
  source_swarm_id TEXT NOT NULL,
  stream_row_id TEXT REFERENCES cascade_streams(id) ON DELETE SET NULL,
  stream_id TEXT NOT NULL,
  agent_id TEXT,
  pushed_commit TEXT NOT NULL,
  remote TEXT NOT NULL,
  remote_ref TEXT NOT NULL,
  strategy TEXT,
  metadata TEXT,
  pushed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cascade_pushes_swarm ON cascade_pushes(source_swarm_id);
CREATE INDEX IF NOT EXISTS idx_cascade_pushes_stream ON cascade_pushes(stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_pushes_pushed_at ON cascade_pushes(pushed_at DESC);

CREATE TABLE IF NOT EXISTS cascade_queue_entries (
  id TEXT PRIMARY KEY,
  source_swarm_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  stream_row_id TEXT REFERENCES cascade_streams(id) ON DELETE SET NULL,
  stream_id TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  reason TEXT,
  outcome TEXT,
  metadata TEXT,
  added_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_swarm_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_cascade_queue_swarm ON cascade_queue_entries(source_swarm_id);
CREATE INDEX IF NOT EXISTS idx_cascade_queue_status ON cascade_queue_entries(status);
CREATE INDEX IF NOT EXISTS idx_cascade_queue_target ON cascade_queue_entries(target_branch);
`;

// Migration V37: cascade_operations audit log for cascade.completed events.
// Stores one row per cascadeRebase walk so operators can answer "did this
// cascade succeed", "what's the recent cascade activity", etc.
export const MIGRATION_V37_CASCADE_OPERATIONS = `
CREATE TABLE IF NOT EXISTS cascade_operations (
  id TEXT PRIMARY KEY,
  source_swarm_id TEXT NOT NULL,
  root_stream_row_id TEXT REFERENCES cascade_streams(id) ON DELETE SET NULL,
  root_stream_id TEXT NOT NULL,
  agent_id TEXT,
  strategy TEXT NOT NULL,
  updated_streams TEXT NOT NULL DEFAULT '[]',
  failed_streams TEXT NOT NULL DEFAULT '[]',
  skipped_streams TEXT NOT NULL DEFAULT '[]',
  deferred_streams TEXT,
  metadata TEXT,
  completed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cascade_operations_swarm ON cascade_operations(source_swarm_id);
CREATE INDEX IF NOT EXISTS idx_cascade_operations_root ON cascade_operations(root_stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_operations_completed_at ON cascade_operations(completed_at DESC);
`;

// Migration V39: publish_branch on cascade_streams + cascade_pull_requests table
// for hub-side GitHub PR management.
export const MIGRATION_V39_CASCADE_PR = `
-- Add publish_branch column for branch aliasing (stream/<id> → human-readable name)
ALTER TABLE cascade_streams ADD COLUMN publish_branch TEXT;

-- PR tracking table for hub-side GitHub API integration
CREATE TABLE IF NOT EXISTS cascade_pull_requests (
  id TEXT PRIMARY KEY,
  stream_row_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github',
  remote_pr_number INTEGER,
  remote_pr_url TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL DEFAULT 'main',
  title TEXT,
  body_hash TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  synced_at TEXT,
  FOREIGN KEY (stream_row_id) REFERENCES cascade_streams(id)
);

CREATE INDEX IF NOT EXISTS idx_cascade_prs_stream ON cascade_pull_requests(stream_row_id);
CREATE INDEX IF NOT EXISTS idx_cascade_prs_state ON cascade_pull_requests(state);
`;

// Populate FTS tables from existing data
export const FTS_POPULATE = `
-- Populate posts FTS
INSERT INTO posts_fts(rowid, title, content)
SELECT rowid, title, content FROM posts WHERE true
ON CONFLICT DO NOTHING;

-- Populate comments FTS
INSERT INTO comments_fts(rowid, content)
SELECT rowid, content FROM comments WHERE true
ON CONFLICT DO NOTHING;

-- Populate agents FTS
INSERT INTO agents_fts(rowid, name, description)
SELECT rowid, name, description FROM agents WHERE true
ON CONFLICT DO NOTHING;

-- Populate hives FTS
INSERT INTO hives_fts(rowid, name, description)
SELECT rowid, name, description FROM hives WHERE true
ON CONFLICT DO NOTHING;
`;
