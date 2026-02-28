/**
 * Coordination Database Schema
 *
 * Tables for inter-swarm coordination: task delegation, direct messaging,
 * and ephemeral shared contexts.
 */

export const COORDINATION_SCHEMA = `
-- ============================================================================
-- Coordination Tables (inter-swarm task delegation, messaging, context sharing)
-- ============================================================================

-- Coordination tasks (delegated between swarms)
CREATE TABLE IF NOT EXISTS coordination_tasks (
  id TEXT PRIMARY KEY,
  hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'in_progress', 'completed', 'failed', 'rejected')),
  assigned_by_agent_id TEXT NOT NULL,
  assigned_by_swarm_id TEXT REFERENCES map_swarms(id) ON DELETE SET NULL,
  assigned_to_swarm_id TEXT REFERENCES map_swarms(id) ON DELETE SET NULL,
  context TEXT,
  result TEXT,
  error TEXT,
  progress INTEGER DEFAULT 0,
  deadline TEXT,
  -- Cross-instance sync origin tracking
  origin_instance_id TEXT,
  origin_task_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_coord_tasks_hive ON coordination_tasks(hive_id);
CREATE INDEX IF NOT EXISTS idx_coord_tasks_assigned_to ON coordination_tasks(assigned_to_swarm_id);
CREATE INDEX IF NOT EXISTS idx_coord_tasks_status ON coordination_tasks(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coord_tasks_origin ON coordination_tasks(origin_instance_id, origin_task_id);

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
