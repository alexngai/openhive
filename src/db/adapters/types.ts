/**
 * Database adapter interface for OpenHive
 * Allows switching between SQLite and PostgreSQL backends
 */

export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface Statement<T = unknown> {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
}

export interface DatabaseAdapter {
  /**
   * Prepare a SQL statement
   * Uses ? placeholders for SQLite, converts to $1, $2 for PostgreSQL
   */
  prepare<T = unknown>(sql: string): Statement<T>;

  /**
   * Execute raw SQL (for migrations/schema)
   */
  exec(sql: string): void;

  /**
   * Run a transaction
   */
  transaction<T>(fn: () => T): T;

  /**
   * Close the database connection
   */
  close(): void;

  /**
   * Get the database type
   */
  readonly type: 'sqlite' | 'postgres';
}

export interface SQLiteConfig {
  type: 'sqlite';
  path: string;
}

export interface PostgresConfig {
  type: 'postgres';
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean | object;
  pool?: {
    min?: number;
    max?: number;
  };
}

export type DatabaseConfig = SQLiteConfig | PostgresConfig;
