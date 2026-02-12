/**
 * Hive Sync Database Schema
 *
 * Migration schemas for cross-instance hive synchronization.
 */

// Version 12: Remote agent cache + origin tracking columns
export const SYNC_SCHEMA_V12 = `
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
`;

// Version 13: Sync groups, peers, events, pending queue
export const SYNC_SCHEMA_V13 = `
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

-- Causal ordering queue (events waiting on dependencies)
CREATE TABLE IF NOT EXISTS hive_events_pending (
  id TEXT PRIMARY KEY,
  sync_group_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  received_at TEXT DEFAULT (datetime('now'))
);
`;

// Version 14: Manual/cached peer configs
export const SYNC_SCHEMA_V14 = `
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
  discovered_via TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(sync_endpoint)
);

CREATE INDEX IF NOT EXISTS idx_sync_peer_configs_status ON sync_peer_configs(status);
CREATE INDEX IF NOT EXISTS idx_sync_peer_configs_source ON sync_peer_configs(source);
`;
