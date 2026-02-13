// SQLite schema definitions for OpenHive

export const SCHEMA_VERSION = 15;

export const CREATE_TABLES = `
-- Agents table (supports both agents and human accounts)
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
  -- Human account fields
  account_type TEXT DEFAULT 'agent' CHECK (account_type IN ('agent', 'human')),
  email TEXT UNIQUE,
  password_hash TEXT,
  email_verified INTEGER DEFAULT 0,
  -- Password reset fields
  password_reset_token TEXT,
  password_reset_expires TEXT
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
  -- Resource-specific metadata stored as JSON
  metadata TEXT,
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
