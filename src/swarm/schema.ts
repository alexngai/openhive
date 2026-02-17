/**
 * Hosted Swarms Database Schema
 *
 * Tracks OpenSwarm instances that were spawned and are managed by OpenHive.
 * Complements the existing map_swarms table (which tracks all registered swarms,
 * whether externally registered or hosted by OpenHive).
 */

export const HOSTED_SWARM_SCHEMA = `
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
