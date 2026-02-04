// ============================================================================
// Session Storage Types
// Pluggable storage backends for session data (local, S3, GCS)
// ============================================================================

export interface SessionStorageOptions {
  sessionId: string;
  agentId: string;
}

export interface SessionFile {
  path: string; // Relative path within session (e.g., 'session.jsonl', 'raw/original.jsonl')
  content: string | Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface SessionFileInfo {
  path: string;
  size: number;
  contentType?: string;
  lastModified: string;
  etag?: string;
}

export interface SessionStorageResult {
  location: string; // Full path/URL to the stored session
  files: SessionFileInfo[];
  totalSize: number;
}

export interface ListOptions {
  prefix?: string;
  maxKeys?: number;
  continuationToken?: string;
}

export interface ListResult {
  files: SessionFileInfo[];
  continuationToken?: string;
  isTruncated: boolean;
}

/**
 * Session Storage Adapter Interface
 * Implementations handle the actual storage of session data
 */
export interface SessionStorageAdapter {
  readonly type: 'local' | 's3' | 'gcs';

  /**
   * Store a session's files
   */
  store(
    options: SessionStorageOptions,
    files: SessionFile[]
  ): Promise<SessionStorageResult>;

  /**
   * Retrieve a specific file from a session
   */
  retrieve(
    options: SessionStorageOptions,
    filePath: string
  ): Promise<string | Buffer | null>;

  /**
   * Retrieve session content as a stream (for large files)
   */
  retrieveStream?(
    options: SessionStorageOptions,
    filePath: string
  ): Promise<NodeJS.ReadableStream | null>;

  /**
   * List files in a session
   */
  list(
    options: SessionStorageOptions,
    listOptions?: ListOptions
  ): Promise<ListResult>;

  /**
   * Delete a session and all its files
   */
  delete(options: SessionStorageOptions): Promise<boolean>;

  /**
   * Check if a session exists
   */
  exists(options: SessionStorageOptions): Promise<boolean>;

  /**
   * Get total size of a session's storage
   */
  getSize(options: SessionStorageOptions): Promise<number>;

  /**
   * Get the public/accessible URL for a file (if applicable)
   */
  getUrl?(options: SessionStorageOptions, filePath: string): string;

  /**
   * Append content to a file (useful for streaming session logs)
   */
  append?(
    options: SessionStorageOptions,
    filePath: string,
    content: string | Buffer
  ): Promise<void>;
}

// ============================================================================
// Storage Configuration Types
// ============================================================================

export interface LocalStorageConfig {
  type: 'local';
  basePath: string; // Base directory for session storage
  maxSizeBytes?: number; // Max size per session (default: 100MB)
}

export interface S3StorageConfig {
  type: 's3';
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string; // For S3-compatible services (MinIO, etc.)
  pathPrefix?: string; // e.g., 'sessions/'
  maxSizeBytes?: number;
}

export interface GCSStorageConfig {
  type: 'gcs';
  bucket: string;
  projectId: string;
  keyFilePath?: string; // Path to service account JSON
  credentials?: {
    client_email: string;
    private_key: string;
  };
  pathPrefix?: string;
  maxSizeBytes?: number;
}

export type SessionStorageConfig =
  | LocalStorageConfig
  | S3StorageConfig
  | GCSStorageConfig;

// ============================================================================
// Session Manifest (stored with each session)
// ============================================================================

export interface SessionManifest {
  version: '1.0';
  sessionId: string;
  createdAt: string;
  updatedAt: string;

  // Format info
  format: {
    id: string;
    version?: string;
    detected: boolean;
  };

  // Files in this session storage
  files: {
    primary: string; // Main session file (e.g., 'session.jsonl')
    raw?: string; // Original file if converted
    index?: string; // Index file if generated
    artifacts?: string[]; // Additional files
  };

  // Checksums for integrity
  checksums: {
    [filePath: string]: string; // SHA-256
  };

  // Quick stats (duplicated from DB for offline access)
  stats: {
    messageCount: number;
    toolCallCount: number;
    sizeBytes: number;
    eventCount?: number;
  };
}
