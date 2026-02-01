/**
 * Database Provider Factory
 *
 * Creates the appropriate database provider based on configuration.
 * Supports SQLite (default), PostgreSQL, and Turso (serverless SQLite).
 */

import type { DatabaseProvider, DatabaseProviderConfig, SQLiteProviderConfig, PostgresProviderConfig, TursoProviderConfig } from './types.js';
import { createSQLiteProvider } from './sqlite.js';

// Provider instances (singleton per config)
let currentProvider: DatabaseProvider | null = null;

/**
 * Create a database provider based on configuration
 */
export async function createDatabaseProvider(config: DatabaseProviderConfig): Promise<DatabaseProvider> {
  switch (config.type) {
    case 'sqlite':
      return createSQLiteProvider(config as SQLiteProviderConfig);

    case 'postgres': {
      // Dynamic import to avoid loading pg when not needed
      const { createPostgresProvider } = await import('./postgres.js');
      return createPostgresProvider(config as PostgresProviderConfig);
    }

    case 'turso': {
      // Dynamic import to avoid loading @libsql/client when not needed
      const { createTursoProvider } = await import('./turso.js');
      return createTursoProvider(config as TursoProviderConfig);
    }

    default:
      throw new Error(`Unknown database provider type: ${(config as DatabaseProviderConfig).type}`);
  }
}

/**
 * Initialize and get the global database provider
 */
export async function initializeDatabase(config: DatabaseProviderConfig): Promise<DatabaseProvider> {
  if (currentProvider) {
    await currentProvider.close();
  }

  currentProvider = await createDatabaseProvider(config);
  await currentProvider.initialize();

  return currentProvider;
}

/**
 * Get the current database provider
 * Throws if not initialized
 */
export function getDatabase(): DatabaseProvider {
  if (!currentProvider) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return currentProvider;
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
  if (currentProvider) {
    await currentProvider.close();
    currentProvider = null;
  }
}

// Re-export types
export * from './types.js';
