// SQLite schema definitions for OpenHive

export const SCHEMA_VERSION = 8;

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

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT,
  url TEXT,
  score INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Comments table with materialized path for threading
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  depth INTEGER DEFAULT 0,
  path TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Votes table
CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
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

-- Memory banks registry (git repos containing minimem memories)
CREATE TABLE IF NOT EXISTS memory_banks (
  id TEXT PRIMARY KEY,
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
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(owner_agent_id, name)
);

-- Agent subscriptions to memory banks
CREATE TABLE IF NOT EXISTS memory_bank_subscriptions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  bank_id TEXT NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
  permission TEXT DEFAULT 'read'
    CHECK (permission IN ('read', 'write', 'admin')),
  subscribed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_id, bank_id)
);

-- Tags for memory bank discoverability
CREATE TABLE IF NOT EXISTS memory_bank_tags (
  bank_id TEXT NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY(bank_id, tag)
);

-- Sync event log (webhook events from git hosts)
CREATE TABLE IF NOT EXISTS memory_sync_events (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
  commit_hash TEXT,
  commit_message TEXT,
  pusher TEXT,
  files_added INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  files_removed INTEGER DEFAULT 0,
  timestamp TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- Generic Syncable Resources (tasks, skills, and future resource types)
-- ============================================================================

-- Syncable resources registry (git repos backing various resource types)
CREATE TABLE IF NOT EXISTS syncable_resources (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('memory_bank', 'task', 'skill')),
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

-- Memory bank indexes
CREATE INDEX IF NOT EXISTS idx_memory_banks_owner ON memory_banks(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_banks_visibility ON memory_banks(visibility);
CREATE INDEX IF NOT EXISTS idx_memory_bank_subs_agent ON memory_bank_subscriptions(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_bank_subs_bank ON memory_bank_subscriptions(bank_id);
CREATE INDEX IF NOT EXISTS idx_memory_bank_tags_tag ON memory_bank_tags(tag);
CREATE INDEX IF NOT EXISTS idx_memory_sync_events_bank ON memory_sync_events(bank_id);
CREATE INDEX IF NOT EXISTS idx_memory_sync_events_time ON memory_sync_events(timestamp);

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
