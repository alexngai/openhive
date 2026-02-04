// ============================================================================
// Session Storage Module
// Factory and management for pluggable session storage backends
// ============================================================================

import type {
  SessionStorageAdapter,
  SessionStorageConfig,
  LocalStorageConfig,
  S3StorageConfig,
  GCSStorageConfig,
} from './types.js';
import { LocalSessionStorageAdapter } from './adapters/local.js';

export * from './types.js';
export { LocalSessionStorageAdapter } from './adapters/local.js';

// Re-export cloud adapters lazily loaded functions
// This avoids requiring @aws-sdk/client-s3 and @google-cloud/storage at import time
export async function loadS3Adapter(): Promise<typeof import('./adapters/s3.js')> {
  return import('./adapters/s3.js');
}

export async function loadGCSAdapter(): Promise<typeof import('./adapters/gcs.js')> {
  return import('./adapters/gcs.js');
}

// ============================================================================
// Storage Factory
// ============================================================================

/**
 * Create a session storage adapter from configuration
 * Note: Cloud adapters (S3, GCS) require their dependencies to be installed
 */
export async function createSessionStorage(
  config: SessionStorageConfig
): Promise<SessionStorageAdapter> {
  switch (config.type) {
    case 'local':
      return new LocalSessionStorageAdapter(config as LocalStorageConfig);
    case 's3': {
      const { S3SessionStorageAdapter } = await loadS3Adapter();
      return new S3SessionStorageAdapter(config as S3StorageConfig);
    }
    case 'gcs': {
      const { GCSSessionStorageAdapter } = await loadGCSAdapter();
      return new GCSSessionStorageAdapter(config as GCSStorageConfig);
    }
    default:
      throw new Error(`Unknown storage type: ${(config as SessionStorageConfig).type}`);
  }
}

// ============================================================================
// Global Storage Instance
// ============================================================================

let defaultStorageInstance: SessionStorageAdapter | null = null;
const storageInstances: Map<string, SessionStorageAdapter> = new Map();

/**
 * Initialize the default session storage
 */
export async function initializeSessionStorage(
  config: SessionStorageConfig
): Promise<SessionStorageAdapter> {
  defaultStorageInstance = await createSessionStorage(config);
  return defaultStorageInstance;
}

/**
 * Initialize local session storage synchronously (no external dependencies)
 */
export function initializeLocalSessionStorage(
  config: LocalStorageConfig
): SessionStorageAdapter {
  defaultStorageInstance = new LocalSessionStorageAdapter(config);
  return defaultStorageInstance;
}

/**
 * Get the default session storage instance
 */
export function getSessionStorage(): SessionStorageAdapter {
  if (!defaultStorageInstance) {
    throw new Error(
      'Session storage not initialized. Call initializeSessionStorage first.'
    );
  }
  return defaultStorageInstance;
}

/**
 * Check if session storage is initialized
 */
export function isSessionStorageInitialized(): boolean {
  return defaultStorageInstance !== null;
}

/**
 * Register a named storage backend (for multi-backend support)
 */
export async function registerSessionStorage(
  name: string,
  config: SessionStorageConfig
): Promise<SessionStorageAdapter> {
  const adapter = await createSessionStorage(config);
  storageInstances.set(name, adapter);
  return adapter;
}

/**
 * Get a named storage backend
 */
export function getNamedSessionStorage(name: string): SessionStorageAdapter | null {
  return storageInstances.get(name) || null;
}

/**
 * Get or create storage for a specific backend type
 * Useful when sessions specify their storage backend
 */
export function getStorageByType(
  type: 'local' | 's3' | 'gcs',
  fallbackConfig?: SessionStorageConfig
): SessionStorageAdapter | null {
  // Check named instances first
  for (const [, adapter] of storageInstances) {
    if (adapter.type === type) {
      return adapter;
    }
  }

  // Check default instance
  if (defaultStorageInstance?.type === type) {
    return defaultStorageInstance;
  }

  // Create from fallback config if provided
  if (fallbackConfig && fallbackConfig.type === type) {
    return createSessionStorage(fallbackConfig);
  }

  return null;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse a storage location URL to determine the backend type
 * Supports: file://, s3://, gs://
 */
export function parseStorageLocation(location: string): {
  type: 'local' | 's3' | 'gcs';
  bucket?: string;
  path: string;
} | null {
  if (location.startsWith('file://')) {
    return {
      type: 'local',
      path: location.substring(7),
    };
  }

  if (location.startsWith('s3://')) {
    const parts = location.substring(5).split('/');
    const bucket = parts[0];
    const path = parts.slice(1).join('/');
    return {
      type: 's3',
      bucket,
      path,
    };
  }

  if (location.startsWith('gs://')) {
    const parts = location.substring(5).split('/');
    const bucket = parts[0];
    const path = parts.slice(1).join('/');
    return {
      type: 'gcs',
      bucket,
      path,
    };
  }

  // Assume local path if no protocol
  if (!location.includes('://')) {
    return {
      type: 'local',
      path: location,
    };
  }

  return null;
}

/**
 * Calculate the SHA-256 hash of content
 */
export async function calculateChecksum(
  content: string | Buffer
): Promise<string> {
  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

/**
 * Estimate storage cost (rough approximation)
 * Returns cost per month in USD
 */
export function estimateStorageCost(
  type: 'local' | 's3' | 'gcs',
  sizeBytes: number
): number {
  const sizeGB = sizeBytes / (1024 * 1024 * 1024);

  // Rough pricing (as of 2024, varies by region)
  const pricesPerGBMonth: Record<string, number> = {
    local: 0, // Free (your own storage)
    s3: 0.023, // S3 Standard
    gcs: 0.02, // GCS Standard
  };

  return sizeGB * (pricesPerGBMonth[type] || 0);
}
