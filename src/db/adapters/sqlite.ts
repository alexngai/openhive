import Database from 'better-sqlite3';
import type { DatabaseAdapter, Statement, RunResult, SQLiteConfig } from './types.js';

/**
 * SQLite adapter using better-sqlite3
 * This is the default and recommended database for small to medium instances
 */
export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database;
  readonly type = 'sqlite' as const;

  constructor(config: SQLiteConfig) {
    this.db = new Database(config.path);
    // Enable WAL mode for better concurrent performance
    this.db.pragma('journal_mode = WAL');
  }

  prepare<T = unknown>(sql: string): Statement<T> {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]): RunResult => {
        const result = stmt.run(...params);
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      },
      get: (...params: unknown[]): T | undefined => {
        return stmt.get(...params) as T | undefined;
      },
      all: (...params: unknown[]): T[] => {
        return stmt.all(...params) as T[];
      },
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Get the underlying better-sqlite3 database instance
   * Use only for advanced operations not covered by the adapter
   */
  getRawDatabase(): Database.Database {
    return this.db;
  }
}
