import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/index.js';
import { CREATE_TABLES, SCHEMA_VERSION } from '../db/schema.js';

const TEST_ROOT = testRoot('migrations');

// We test the migration system by simulating what initDatabase() does internally,
// using raw better-sqlite3 so we can set up partial/broken schemas.

// Minimal schema: just the version table + agents (needed by ingest_keys FK)
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  api_key_hash TEXT,
  description TEXT,
  karma INTEGER DEFAULT 0,
  is_verified INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO agents (id, name) VALUES ('agent-1', 'test-agent');
`;

// Old ingest_keys DDL (missing key_value and scopes — the bug scenario)
const OLD_INGEST_KEYS_DDL = `
CREATE TABLE IF NOT EXISTS ingest_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revoked INTEGER DEFAULT 0,
  expires_at TEXT,
  created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);
`;

function getColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map(r => r.name);
}

function createTestDb(name: string, schemaVersion: number, extraSql?: string): Database.Database {
  const dbPath = testDbPath(TEST_ROOT, name);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(BASE_SCHEMA);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(schemaVersion);
  if (extraSql) db.exec(extraSql);
  return db;
}

afterEach(() => {
  cleanTestRoot(TEST_ROOT);
});

describe('Migration System', () => {
  describe('runMigrations splits statements independently', () => {
    it('should add all columns even if one ALTER TABLE fails', () => {
      // Simulate: ingest_keys exists with key_value but NOT scopes.
      // A multi-statement migration where the first ALTER fails (duplicate)
      // should still apply the second ALTER.
      const db = createTestDb('split-stmts.db', 25, OLD_INGEST_KEYS_DDL);

      // Manually add key_value (so the first ALTER will fail as "duplicate column")
      db.exec("ALTER TABLE ingest_keys ADD COLUMN key_value TEXT NOT NULL DEFAULT ''");

      const columns = getColumns(db, 'ingest_keys');
      expect(columns).toContain('key_value');
      expect(columns).not.toContain('scopes');

      // Now simulate the split-statement migration approach
      const migrationSql = `
ALTER TABLE ingest_keys ADD COLUMN key_value TEXT NOT NULL DEFAULT '';
ALTER TABLE ingest_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["map"]';
      `;

      const statements = migrationSql.split(';').map(s => s.trim()).filter(s => s.length > 0);
      for (const stmt of statements) {
        try {
          db.exec(stmt);
        } catch {
          // Ignore (e.g. column already exists)
        }
      }

      const updatedColumns = getColumns(db, 'ingest_keys');
      expect(updatedColumns).toContain('key_value');
      expect(updatedColumns).toContain('scopes');

      db.close();
    });

    it('old exec() approach would fail to add second column if first fails', () => {
      // Documents the original bug: better-sqlite3 exec() stops on first error
      const db = createTestDb('old-approach.db', 25, OLD_INGEST_KEYS_DDL);

      // Add key_value so the first ALTER will fail
      db.exec("ALTER TABLE ingest_keys ADD COLUMN key_value TEXT NOT NULL DEFAULT ''");

      const migrationSql = `
ALTER TABLE ingest_keys ADD COLUMN key_value TEXT NOT NULL DEFAULT '';
ALTER TABLE ingest_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["map"]';
      `;

      // Old approach: single exec() call — first failure stops everything
      try {
        db.exec(migrationSql);
      } catch {
        // Error swallowed like the old code did
      }

      const columns = getColumns(db, 'ingest_keys');
      expect(columns).toContain('key_value');
      // scopes was NEVER added — this is the bug
      expect(columns).not.toContain('scopes');

      db.close();
    });
  });

  describe('repairSchema', () => {
    it('should add missing key_value and scopes to existing ingest_keys table', () => {
      // Simulate: DB at version 26 but columns missing (the exact bug scenario)
      const db = createTestDb('repair-missing.db', 26, OLD_INGEST_KEYS_DDL);

      const before = getColumns(db, 'ingest_keys');
      expect(before).not.toContain('key_value');
      expect(before).not.toContain('scopes');

      // Run repair (same logic as repairSchema)
      const repairs = [
        "ALTER TABLE ingest_keys ADD COLUMN key_value TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE ingest_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '[\"map\"]'",
      ];
      for (const sql of repairs) {
        try { db.exec(sql); } catch { /* column already exists */ }
      }

      const after = getColumns(db, 'ingest_keys');
      expect(after).toContain('key_value');
      expect(after).toContain('scopes');

      db.close();
    });

    it('should be idempotent when columns already exist', () => {
      // Full ingest_keys DDL (columns already present)
      const fullDdl = `
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
);`;
      const db = createTestDb('repair-noop.db', 26, fullDdl);

      const before = getColumns(db, 'ingest_keys');
      expect(before).toContain('key_value');
      expect(before).toContain('scopes');

      // Running repair again should not throw or duplicate columns
      const repairs = [
        "ALTER TABLE ingest_keys ADD COLUMN key_value TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE ingest_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '[\"map\"]'",
      ];
      for (const sql of repairs) {
        try { db.exec(sql); } catch { /* column already exists */ }
      }

      const after = getColumns(db, 'ingest_keys');
      expect(after).toContain('key_value');
      expect(after).toContain('scopes');
      // Column count should not change
      expect(after.length).toBe(before.length);

      db.close();
    });

    it('should not fail when ingest_keys table does not exist yet', () => {
      // Fresh DB before migration 25 — no ingest_keys table
      const db = createTestDb('repair-no-table.db', 20);

      const repairs = [
        "ALTER TABLE ingest_keys ADD COLUMN key_value TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE ingest_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '[\"map\"]'",
      ];

      // Should not throw — errors are caught
      for (const sql of repairs) {
        try { db.exec(sql); } catch { /* table doesn't exist yet */ }
      }

      db.close();
    });
  });

  describe('initDatabase end-to-end', () => {
    it('should produce a working ingest_keys table on fresh DB', () => {
      const dbPath = testDbPath(TEST_ROOT, 'fresh-e2e.db');

      initDatabase(dbPath);
      const db = getDatabase();

      const columns = getColumns(db, 'ingest_keys');
      expect(columns).toContain('id');
      expect(columns).toContain('label');
      expect(columns).toContain('key_hash');
      expect(columns).toContain('key_value');
      expect(columns).toContain('scopes');
      expect(columns).toContain('agent_id');

      closeDatabase();
    });

    it('should repair columns on existing DB with version 26 but missing columns', () => {
      // Pre-create a DB that looks like the broken state:
      // version 26, ingest_keys exists but missing key_value + scopes
      const dbPath = testDbPath(TEST_ROOT, 'repair-e2e.db');
      const rawDb = new Database(dbPath);
      rawDb.pragma('foreign_keys = ON');

      // Set up full schema but with the OLD ingest_keys (missing columns)
      rawDb.exec(CREATE_TABLES);
      rawDb.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);

      // Drop the correct table and recreate with missing columns
      rawDb.exec('DROP TABLE IF EXISTS ingest_keys');
      rawDb.exec(OLD_INGEST_KEYS_DDL);

      const beforeCols = getColumns(rawDb, 'ingest_keys');
      expect(beforeCols).not.toContain('key_value');
      expect(beforeCols).not.toContain('scopes');
      rawDb.close();

      // Now open via initDatabase — repairSchema should fix it
      initDatabase(dbPath);
      const db = getDatabase();

      const afterCols = getColumns(db, 'ingest_keys');
      expect(afterCols).toContain('key_value');
      expect(afterCols).toContain('scopes');

      closeDatabase();
    });
  });
});
