export interface UploadOptions {
  filename: string;
  mimeType: string;
  agentId: string;
  purpose: 'avatar' | 'banner' | 'post' | 'comment';
}

export interface UploadResult {
  key: string;
  url: string;
  width?: number;
  height?: number;
  size: number;
  mimeType: string;
  thumbnailUrl?: string;
}

export interface StorageAdapter {
  /**
   * Upload a file to storage
   */
  upload(file: Buffer, options: UploadOptions): Promise<UploadResult>;

  /**
   * Delete a file from storage
   */
  delete(key: string): Promise<void>;

  /**
   * Get the public URL for a file
   */
  getUrl(key: string): string;

  /**
   * Check if a file exists
   */
  exists(key: string): Promise<boolean>;
}

export interface LocalStorageConfig {
  type: 'local';
  path: string;
  publicUrl: string;
}

export interface S3StorageConfig {
  type: 's3';
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  publicUrl?: string;
}

export type StorageConfig = LocalStorageConfig | S3StorageConfig;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
  size: number;
}
