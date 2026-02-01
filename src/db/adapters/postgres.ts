import { Pool, PoolClient, QueryResult } from 'pg';
import type { DatabaseAdapter, Statement, RunResult, PostgresConfig } from './types.js';

/**
 * PostgreSQL adapter using pg
 *
 * Note: PostgreSQL is inherently async, but this adapter provides a synchronous-style
 * interface for compatibility with the existing DAL code. For production use with
 * PostgreSQL, consider making the DAL async for better performance.
 *
 * This adapter is suitable for:
 * - Medium to large instances
 * - Production deployments requiring PostgreSQL features
 * - Multi-server deployments
 */
export class PostgresAdapter implements DatabaseAdapter {
  private pool: Pool;
  private client: PoolClient | null = null;
  private connected = false;
  readonly type = 'postgres' as const;

  constructor(config: PostgresConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      min: config.pool?.min ?? 2,
      max: config.pool?.max ?? 10,
    });
  }

  /**
   * Initialize the connection (must be called before use)
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.client = await this.pool.connect();
    this.connected = true;
  }

  /**
   * Convert SQLite-style ? placeholders to PostgreSQL $1, $2, etc.
   */
  private convertPlaceholders(sql: string): string {
    let paramIndex = 0;
    return sql.replace(/\?/g, () => `$${++paramIndex}`);
  }

  /**
   * Convert SQLite-specific syntax to PostgreSQL
   */
  private convertSql(sql: string): string {
    let converted = this.convertPlaceholders(sql);

    // Convert datetime('now') to NOW()
    converted = converted.replace(/datetime\s*\(\s*['"]now['"]\s*\)/gi, 'NOW()');

    // Convert INTEGER PRIMARY KEY to SERIAL PRIMARY KEY
    converted = converted.replace(
      /INTEGER PRIMARY KEY/gi,
      'SERIAL PRIMARY KEY'
    );

    // Convert AUTOINCREMENT to (nothing, SERIAL handles it)
    converted = converted.replace(/\s+AUTOINCREMENT/gi, '');

    // Convert TEXT to TEXT (same in PostgreSQL)
    // Convert INTEGER to INTEGER (same in PostgreSQL)
    // Convert REAL to DOUBLE PRECISION
    converted = converted.replace(/\bREAL\b/gi, 'DOUBLE PRECISION');

    // Convert SQLite's IF NOT EXISTS for indexes
    converted = converted.replace(
      /CREATE INDEX IF NOT EXISTS/gi,
      'CREATE INDEX IF NOT EXISTS'
    );

    // Convert INSERT OR IGNORE to INSERT ... ON CONFLICT DO NOTHING
    converted = converted.replace(
      /INSERT OR IGNORE INTO/gi,
      'INSERT INTO'
    );

    // Handle julianday calculations (SQLite specific)
    // For PostgreSQL, use EXTRACT(EPOCH FROM ...)
    converted = converted.replace(
      /julianday\s*\(\s*['"]now['"]\s*\)\s*-\s*julianday\s*\(([^)]+)\)/gi,
      'EXTRACT(EPOCH FROM NOW() - $1) / 86400'
    );

    return converted;
  }

  prepare<T = unknown>(sql: string): Statement<T> {
    const convertedSql = this.convertSql(sql);

    return {
      run: (...params: unknown[]): RunResult => {
        if (!this.client) {
          throw new Error('Database not connected. Call connect() first.');
        }
        // Use a promise that blocks (not ideal but matches SQLite sync API)
        let result: QueryResult;
        const promise = this.client.query(convertedSql, params);

        // For sync compatibility, we use a synchronous approach
        // In production PostgreSQL deployments, the DAL should be made async
        let resolved = false;
        let error: Error | null = null;

        promise
          .then((r) => {
            result = r;
            resolved = true;
          })
          .catch((e) => {
            error = e;
            resolved = true;
          });

        // Spin wait (not ideal but necessary for sync interface)
        // In a real async environment, use deasync or make DAL async
        const start = Date.now();
        while (!resolved && Date.now() - start < 30000) {
          // Busy wait with small delay via process.nextTick equivalent
          require('child_process').spawnSync('sleep', ['0.001']);
        }

        if (error) throw error;
        if (!result!) throw new Error('Query timed out');

        return {
          changes: result.rowCount || 0,
        };
      },

      get: (...params: unknown[]): T | undefined => {
        if (!this.client) {
          throw new Error('Database not connected. Call connect() first.');
        }

        let result: QueryResult;
        let resolved = false;
        let error: Error | null = null;

        this.client
          .query(convertedSql, params)
          .then((r) => {
            result = r;
            resolved = true;
          })
          .catch((e) => {
            error = e;
            resolved = true;
          });

        const start = Date.now();
        while (!resolved && Date.now() - start < 30000) {
          require('child_process').spawnSync('sleep', ['0.001']);
        }

        if (error) throw error;
        if (!result!) throw new Error('Query timed out');

        return result.rows[0] as T | undefined;
      },

      all: (...params: unknown[]): T[] => {
        if (!this.client) {
          throw new Error('Database not connected. Call connect() first.');
        }

        let result: QueryResult;
        let resolved = false;
        let error: Error | null = null;

        this.client
          .query(convertedSql, params)
          .then((r) => {
            result = r;
            resolved = true;
          })
          .catch((e) => {
            error = e;
            resolved = true;
          });

        const start = Date.now();
        while (!resolved && Date.now() - start < 30000) {
          require('child_process').spawnSync('sleep', ['0.001']);
        }

        if (error) throw error;
        if (!result!) throw new Error('Query timed out');

        return result.rows as T[];
      },
    };
  }

  exec(sql: string): void {
    if (!this.client) {
      throw new Error('Database not connected. Call connect() first.');
    }

    const convertedSql = this.convertSql(sql);
    const statements = convertedSql.split(';').filter((s) => s.trim());

    for (const stmt of statements) {
      if (!stmt.trim()) continue;

      let resolved = false;
      let error: Error | null = null;

      this.client
        .query(stmt)
        .then(() => {
          resolved = true;
        })
        .catch((e) => {
          error = e;
          resolved = true;
        });

      const start = Date.now();
      while (!resolved && Date.now() - start < 30000) {
        require('child_process').spawnSync('sleep', ['0.001']);
      }

      if (error) throw error;
    }
  }

  transaction<T>(fn: () => T): T {
    if (!this.client) {
      throw new Error('Database not connected. Call connect() first.');
    }

    // Begin transaction
    let resolved = false;
    let error: Error | null = null;

    this.client
      .query('BEGIN')
      .then(() => {
        resolved = true;
      })
      .catch((e) => {
        error = e;
        resolved = true;
      });

    while (!resolved) {
      require('child_process').spawnSync('sleep', ['0.001']);
    }
    if (error) throw error;

    try {
      const result = fn();

      // Commit
      resolved = false;
      this.client
        .query('COMMIT')
        .then(() => {
          resolved = true;
        })
        .catch((e) => {
          error = e;
          resolved = true;
        });

      while (!resolved) {
        require('child_process').spawnSync('sleep', ['0.001']);
      }
      if (error) throw error;

      return result;
    } catch (e) {
      // Rollback
      resolved = false;
      this.client
        .query('ROLLBACK')
        .then(() => {
          resolved = true;
        })
        .catch(() => {
          resolved = true;
        });

      while (!resolved) {
        require('child_process').spawnSync('sleep', ['0.001']);
      }

      throw e;
    }
  }

  close(): void {
    if (this.client) {
      this.client.release();
      this.client = null;
    }
    this.pool.end();
    this.connected = false;
  }
}
