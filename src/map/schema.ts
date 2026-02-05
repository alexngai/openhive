/**
 * MAP Hub Database Schema
 *
 * Tables for managing MAP swarm registration, agent node discovery,
 * pre-auth keys, and federation connection logging.
 */

export const MAP_SCHEMA = `
-- ============================================================================
-- MAP Hub Tables (headscale-style coordination for MAP swarms)
-- ============================================================================

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
  -- State (mirrors MAP agent states)
  state TEXT DEFAULT 'registered'
    CHECK (state IN ('registered', 'active', 'busy', 'idle', 'suspended', 'stopped', 'failed')),
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
CREATE INDEX IF NOT EXISTS idx_map_nodes_swarm ON map_nodes(swarm_id);
CREATE INDEX IF NOT EXISTS idx_map_nodes_role ON map_nodes(role);
CREATE INDEX IF NOT EXISTS idx_map_nodes_state ON map_nodes(state);
CREATE INDEX IF NOT EXISTS idx_map_nodes_visibility ON map_nodes(visibility);
CREATE INDEX IF NOT EXISTS idx_map_swarm_hives_swarm ON map_swarm_hives(swarm_id);
CREATE INDEX IF NOT EXISTS idx_map_swarm_hives_hive ON map_swarm_hives(hive_id);
CREATE INDEX IF NOT EXISTS idx_map_preauth_keys_hive ON map_preauth_keys(hive_id);
CREATE INDEX IF NOT EXISTS idx_map_federation_log_source ON map_federation_log(source_swarm_id);
CREATE INDEX IF NOT EXISTS idx_map_federation_log_target ON map_federation_log(target_swarm_id);
`;
