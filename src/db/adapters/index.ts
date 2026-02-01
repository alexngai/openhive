export * from './types.js';
export { SQLiteAdapter } from './sqlite.js';
export { PostgresAdapter } from './postgres.js';

import type { DatabaseAdapter, DatabaseConfig } from './types.js';
import { SQLiteAdapter } from './sqlite.js';
import { PostgresAdapter } from './postgres.js';

/**
 * Create a database adapter based on configuration
 */
export function createAdapter(config: DatabaseConfig): DatabaseAdapter {
  switch (config.type) {
    case 'sqlite':
      return new SQLiteAdapter(config);
    case 'postgres':
      return new PostgresAdapter(config);
    default:
      throw new Error(`Unknown database type: ${(config as DatabaseConfig).type}`);
  }
}
