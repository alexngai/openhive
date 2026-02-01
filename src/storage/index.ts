import type { StorageAdapter, StorageConfig } from './types.js';
import { LocalStorageAdapter } from './adapters/local.js';
import { S3StorageAdapter } from './adapters/s3.js';

export * from './types.js';

let storageInstance: StorageAdapter | null = null;

export function createStorage(config: StorageConfig): StorageAdapter {
  if (config.type === 'local') {
    return new LocalStorageAdapter(config);
  } else if (config.type === 's3') {
    return new S3StorageAdapter(config);
  }
  throw new Error(`Unknown storage type: ${(config as StorageConfig).type}`);
}

export function initializeStorage(config: StorageConfig): StorageAdapter {
  storageInstance = createStorage(config);
  return storageInstance;
}

export function getStorage(): StorageAdapter {
  if (!storageInstance) {
    throw new Error('Storage not initialized. Call initializeStorage first.');
  }
  return storageInstance;
}

export function isStorageInitialized(): boolean {
  return storageInstance !== null;
}

// Allowed MIME types for upload
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

// Maximum file size (5MB)
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

export function validateUpload(
  mimeType: string,
  size: number
): { valid: boolean; error?: string } {
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return {
      valid: false,
      error: `Invalid file type. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`,
    };
  }

  if (size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
    };
  }

  return { valid: true };
}
