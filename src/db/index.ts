import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { CREATE_TABLES, SCHEMA_VERSION, SEED_DATA, FTS_SCHEMA, FTS_POPULATE, MIGRATION_V18_RESOURCE_SCOPE, MIGRATION_V21_RESOURCE_ORIGIN, MIGRATION_V23_COORDINATION_ORIGIN } from './schema.js';
import { MAP_SCHEMA } from '../map/schema.js';
import { SYNC_SCHEMA_V12, SYNC_SCHEMA_V13, SYNC_SCHEMA_V14, SYNC_SCHEMA_V15 } from '../sync/schema.js';
import { HOSTED_SWARM_SCHEMA } from '../swarm/schema.js';
import { BRIDGE_SCHEMA } from '../bridge/schema.js';
import { EVENT_ROUTING_SCHEMA } from '../events/schema.js';
import { COORDINATION_SCHEMA } from '../coordination/schema.js';
import type { DatabaseConfig } from './adapters/types.js';
import { SQLiteAdapter } from './adapters/sqlite.js';

let db: Database.Database | null = null;
let adapter: SQLiteAdapter | null = null;
let dbConfig: DatabaseConfig | null = null;

/**
 * Get the raw better-sqlite3 database instance
 * For backward compatibility with existing DAL code
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Get the database adapter
 * Prefer using this for new code
 */
export function getAdapter(): SQLiteAdapter {
  if (!adapter) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return adapter;
}

/**
 * Get the current database configuration
 */
export function getDatabaseConfig(): DatabaseConfig | null {
  return dbConfig;
}

/**
 * Initialize the database
 * @param config - Either a string path (SQLite) or a DatabaseConfig object
 */
export function initDatabase(config: string | DatabaseConfig): Database.Database {
  // Normalize config
  if (typeof config === 'string') {
    dbConfig = { type: 'sqlite', path: config };
  } else {
    dbConfig = config;
  }

  if (dbConfig.type === 'postgres') {
    throw new Error(
      'PostgreSQL is not supported via initDatabase(). ' +
      'Use the async provider system in db/providers/ instead.'
    );
  }

  // For SQLite, ensure directory exists
  const dbPath = dbConfig.path;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create the SQLite adapter
  adapter = new SQLiteAdapter(dbConfig);

  // Also keep the raw database reference for backward compatibility
  db = adapter.getRawDatabase();

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Run schema creation
  db.exec(CREATE_TABLES);

  // Check and update schema version
  const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;

  if (!versionRow) {
    // First time setup
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    // Create FTS tables
    db.exec(FTS_SCHEMA);
    // Create MAP Hub tables
    db.exec(MAP_SCHEMA);
    // Create hosted swarms table
    db.exec(HOSTED_SWARM_SCHEMA);
    // Create bridge tables
    db.exec(BRIDGE_SCHEMA);
    // Create event routing tables
    db.exec(EVENT_ROUTING_SCHEMA);
    // Create coordination tables
    db.exec(COORDINATION_SCHEMA);
    // Seed default data
    db.exec(SEED_DATA);
  } else if (versionRow.version < SCHEMA_VERSION) {
    // Run migrations
    runMigrations(db, versionRow.version, SCHEMA_VERSION);
  }

  // Repair any columns that were lost to silently-swallowed migration errors
  repairSchema(db);

  return db;
}

export function closeDatabase(): void {
  if (adapter) {
    adapter.close();
    adapter = null;
    db = null;
    dbConfig = null;
  }
}

// ── Migration System ─────────────────────────────────────────────
// NEW-12: Migration registry is exported so providers (Postgres/Turso) can
// consume the same version->SQL mapping via getMigrationSQL().

/** Canonical migration map keyed by target version number.
 *  These are SQLite dialect — Postgres/Turso providers may need dialect-specific
 *  translations but can use this as the source of truth for *what* changes. */
const MIGRATION_REGISTRY: Record<number, string> = {
  // Version 2: Add full-text search
  2: FTS_SCHEMA,
  // Version 3: Add uploads table (handled in CREATE_TABLES)
  3: '',
  // Version 4: Add human account fields (handled in CREATE_TABLES)
  4: `
    -- Add human account columns if they don't exist
    -- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we use a workaround
  `,
  // Version 5: Already applied
  5: '',
  // Version 6: Add password reset fields
  6: `
    ALTER TABLE agents ADD COLUMN password_reset_token TEXT;
    ALTER TABLE agents ADD COLUMN password_reset_expires TEXT;
  `,
  // Versions 7-10: handled in CREATE_TABLES
  7: '', 8: '', 9: '', 10: '',
  // Version 11: MAP Hub tables (headscale-style swarm coordination)
  11: MAP_SCHEMA,
  // Version 12: Remote agent cache + origin tracking columns
  12: SYNC_SCHEMA_V12,
  // Version 13: Sync groups, peers, events, pending queue
  13: SYNC_SCHEMA_V13,
  // Version 14: Manual/cached peer configs
  14: SYNC_SCHEMA_V14,
  // Version 15: Key rotation support — versioned signing keys
  15: SYNC_SCHEMA_V15,
  // Version 16: Hosted swarms — spawn and manage OpenSwarm instances
  16: HOSTED_SWARM_SCHEMA,
  // Version 17: Channel Bridge — external platform integration
  17: BRIDGE_SCHEMA,
  // Version 18: Resource scope column for discovery
  18: MIGRATION_V18_RESOURCE_SCOPE,
  // Version 19: Event routing — post rules, subscriptions, delivery log
  19: EVENT_ROUTING_SCHEMA,
  // Version 20: SwarmHub OAuth — add swarmhub_user_id for linked accounts
  20: `ALTER TABLE agents ADD COLUMN swarmhub_user_id TEXT UNIQUE;`,
  // Version 21: Resource origin tracking for cross-instance sync
  21: MIGRATION_V21_RESOURCE_ORIGIN,
  // Version 22: Coordination tables — inter-swarm task delegation, messaging, context sharing
  22: COORDINATION_SCHEMA,
  // Version 23: Origin tracking for coordination tables (cross-instance idempotency)
  23: MIGRATION_V23_COORDINATION_ORIGIN,
  // Version 24: Trajectory checkpoints table (stored from trajectory/checkpoint sync notifications)
  24: `
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
  `,
  // Version 25: Ingest API keys for external agent authentication
  25: `
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
  `,
  // Version 26: Add key_value and scopes columns to ingest_keys (added mid-development)
  26: `
ALTER TABLE ingest_keys ADD COLUMN key_value TEXT NOT NULL DEFAULT '';
ALTER TABLE ingest_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["map"]';
  `,
};

/** Get the SQL for a specific migration version.
 *  Providers can call this to get the canonical migration content and
 *  translate it to their own dialect if needed. */
export function getMigrationSQL(version: number): string | null {
  return MIGRATION_REGISTRY[version] ?? null;
}

/** Get all migration versions that need to run between two schema versions. */
export function getMigrationRange(fromVersion: number, toVersion: number): Array<{ version: number; sql: string }> {
  const result: Array<{ version: number; sql: string }> = [];
  for (let v = fromVersion + 1; v <= toVersion; v++) {
    const sql = MIGRATION_REGISTRY[v];
    if (sql && sql.trim()) {
      result.push({ version: v, sql });
    }
  }
  return result;
}

/** The current target schema version — re-exported for providers */
export { SCHEMA_VERSION } from './schema.js';

function runMigrations(database: Database.Database, fromVersion: number, toVersion: number): void {
  const migrations = getMigrationRange(fromVersion, toVersion);

  for (const { version, sql } of migrations) {
    // Execute each SQL statement independently so one failure doesn't block the rest.
    // This is important for ALTER TABLE migrations where individual columns
    // may already exist but others still need to be added.
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      try {
        database.exec(stmt);
      } catch {
        // Ignore errors (e.g. column/table already exists)
      }
    }

    // Special handling for FTS migration - populate existing data
    if (version === 2) {
      try {
        database.exec(FTS_POPULATE);
      } catch {
        // Ignore errors if tables are empty
      }
    }
  }

  database.prepare('UPDATE schema_version SET version = ?').run(toVersion);
}

/**
 * Ensure critical columns exist regardless of schema version.
 * Repairs tables where migrations were silently swallowed by the old catch-all.
 */
function repairSchema(database: Database.Database): void {
  const repairs = [
    "ALTER TABLE ingest_keys ADD COLUMN key_value TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE ingest_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '[\"map\"]'",
  ];
  for (const sql of repairs) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }
}

// Transaction helper
export function transaction<T>(fn: () => T): T {
  const database = getDatabase();
  return database.transaction(fn)();
}
