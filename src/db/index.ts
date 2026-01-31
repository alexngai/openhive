import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { CREATE_TABLES, SCHEMA_VERSION, SEED_DATA } from './schema.js';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function initDatabase(dbPath: string): Database.Database {
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create or open database
  db = new Database(dbPath);

  // Enable foreign keys and WAL mode for better performance
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  // Run schema creation
  db.exec(CREATE_TABLES);

  // Check and update schema version
  const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;

  if (!versionRow) {
    // First time setup
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    // Seed default data
    db.exec(SEED_DATA);
  } else if (versionRow.version < SCHEMA_VERSION) {
    // Run migrations
    runMigrations(db, versionRow.version, SCHEMA_VERSION);
  }

  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Migration system
function runMigrations(database: Database.Database, fromVersion: number, toVersion: number): void {
  const migrations: Record<number, string> = {
    // Add migrations here as needed
    // 2: `ALTER TABLE agents ADD COLUMN some_new_field TEXT;`,
  };

  for (let v = fromVersion + 1; v <= toVersion; v++) {
    if (migrations[v]) {
      database.exec(migrations[v]);
    }
  }

  database.prepare('UPDATE schema_version SET version = ?').run(toVersion);
}

// Transaction helper
export function transaction<T>(fn: () => T): T {
  const database = getDatabase();
  return database.transaction(fn)();
}
