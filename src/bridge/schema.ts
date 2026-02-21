/**
 * Channel Bridge Database Schema
 *
 * Tables for managing bridge configurations, channel mappings,
 * proxy agents, and message mappings for external platform integration.
 */

export const BRIDGE_SCHEMA = `
-- ============================================================================
-- Channel Bridge Tables (external platform integration)
-- ============================================================================

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

-- Channel mappings (platform channel → OpenHive hive)
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

-- Proxy agents (external user → OpenHive agent mapping)
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

-- Message mappings (platform message → post/comment for thread tracking)
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
