import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { CREATE_TABLES, SCHEMA_VERSION, SEED_DATA, FTS_SCHEMA, FTS_POPULATE } from './schema.js';
import { MAP_SCHEMA } from '../map/schema.js';
import { SYNC_SCHEMA_V12, SYNC_SCHEMA_V13, SYNC_SCHEMA_V14, SYNC_SCHEMA_V15 } from '../sync/schema.js';
import { HOSTED_SWARM_SCHEMA } from '../swarm/schema.js';
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
      'PostgreSQL support is currently experimental. ' +
      'For production PostgreSQL deployments, the DAL needs to be made async. ' +
      'Use SQLite for now, which is recommended for small to medium instances.'
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
    // Seed default data
    db.exec(SEED_DATA);
  } else if (versionRow.version < SCHEMA_VERSION) {
    // Run migrations
    runMigrations(db, versionRow.version, SCHEMA_VERSION);
  }

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
    try {
      database.exec(sql);
    } catch {
      // Ignore migration errors (column may already exist)
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

// Transaction helper
export function transaction<T>(fn: () => T): T {
  const database = getDatabase();
  return database.transaction(fn)();
}
