/**
 * Event Routing Schema (Migration V19)
 *
 * Three tables:
 * - event_post_rules: which events become posts in which hive
 * - event_subscriptions: which swarms receive which events via MAP
 * - event_delivery_log: observability for MAP dispatches
 */

export const EVENT_ROUTING_SCHEMA = `
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
