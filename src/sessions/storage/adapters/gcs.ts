// ============================================================================
// Google Cloud Storage Session Storage Adapter
// ============================================================================

import { Storage, Bucket } from '@google-cloud/storage';
import type {
  SessionStorageAdapter,
  SessionStorageOptions,
  SessionFile,
  SessionStorageResult,
  SessionFileInfo,
  ListOptions,
  ListResult,
  GCSStorageConfig,
} from '../types.js';

const DEFAULT_MAX_SIZE = 500 * 1024 * 1024; // 500MB for cloud storage

export class GCSSessionStorageAdapter implements SessionStorageAdapter {
  readonly type = 'gcs' as const;
  private storage: Storage;
  private bucket: Bucket;
  private bucketName: string;
  private pathPrefix: string;
  private maxSizeBytes: number;

  constructor(config: GCSStorageConfig) {
    this.bucketName = config.bucket;
    this.pathPrefix = config.pathPrefix?.replace(/\/$/, '') || 'sessions';
    this.maxSizeBytes = config.maxSizeBytes || DEFAULT_MAX_SIZE;

    // Initialize GCS client
    const storageOptions: ConstructorParameters<typeof Storage>[0] = {
      projectId: config.projectId,
    };

    if (config.keyFilePath) {
      storageOptions.keyFilename = config.keyFilePath;
    } else if (config.credentials) {
      storageOptions.credentials = config.credentials;
    }
    // If neither is provided, uses Application Default Credentials

    this.storage = new Storage(storageOptions);
    this.bucket = this.storage.bucket(config.bucket);
  }

  private getSessionPrefix(options: SessionStorageOptions): string {
    return `${this.pathPrefix}/agents/${options.agentId}/sessions/${options.sessionId}`;
  }

  private getObjectName(options: SessionStorageOptions, filePath: string): string {
    return `${this.getSessionPrefix(options)}/${filePath}`;
  }

  async store(
    options: SessionStorageOptions,
    files: SessionFile[]
  ): Promise<SessionStorageResult> {
    // Check total size
    let totalSize = 0;
    for (const file of files) {
      const size =
        typeof file.content === 'string'
          ? Buffer.byteLength(file.content, 'utf8')
          : file.content.length;
      totalSize += size;
    }

    if (totalSize > this.maxSizeBytes) {
      throw new Error(
        `Session size ${totalSize} exceeds maximum ${this.maxSizeBytes} bytes`
      );
    }

    const fileInfos: SessionFileInfo[] = [];

    // Upload files in parallel
    const uploadPromises = files.map(async (file) => {
      const objectName = this.getObjectName(options, file.path);
      const blob = this.bucket.file(objectName);
      const body =
        typeof file.content === 'string'
          ? Buffer.from(file.content, 'utf8')
          : file.content;

      const contentType = file.contentType || this.inferContentType(file.path);

      await blob.save(body, {
        contentType,
        metadata: file.metadata,
      });

      return {
        path: file.path,
        size: body.length,
        contentType,
        lastModified: new Date().toISOString(),
      };
    });

    const results = await Promise.all(uploadPromises);
    fileInfos.push(...results);

    return {
      location: `gs://${this.bucketName}/${this.getSessionPrefix(options)}`,
      files: fileInfos,
      totalSize,
    };
  }

  async retrieve(
    options: SessionStorageOptions,
    filePath: string
  ): Promise<string | Buffer | null> {
    const objectName = this.getObjectName(options, filePath);
    const blob = this.bucket.file(objectName);

    try {
      const [exists] = await blob.exists();
      if (!exists) {
        return null;
      }

      const [content] = await blob.download();

      // Return as string for text files
      if (this.isTextFile(filePath)) {
        return content.toString('utf8');
      }
      return content;
    } catch (error) {
      if ((error as Error).message?.includes('No such object')) {
        return null;
      }
      throw error;
    }
  }

  async retrieveStream(
    options: SessionStorageOptions,
    filePath: string
  ): Promise<NodeJS.ReadableStream | null> {
    const objectName = this.getObjectName(options, filePath);
    const blob = this.bucket.file(objectName);

    try {
      const [exists] = await blob.exists();
      if (!exists) {
        return null;
      }

      return blob.createReadStream();
    } catch (error) {
      if ((error as Error).message?.includes('No such object')) {
        return null;
      }
      throw error;
    }
  }

  async list(
    options: SessionStorageOptions,
    listOptions?: ListOptions
  ): Promise<ListResult> {
    const prefix = listOptions?.prefix
      ? `${this.getSessionPrefix(options)}/${listOptions.prefix}`
      : `${this.getSessionPrefix(options)}/`;

    const [files, , apiResponse] = await this.bucket.getFiles({
      prefix,
      maxResults: listOptions?.maxKeys || 1000,
      pageToken: listOptions?.continuationToken,
    });

    const sessionPrefix = this.getSessionPrefix(options);
    const fileInfos: SessionFileInfo[] = files.map((file) => ({
      path: file.name.substring(sessionPrefix.length + 1),
      size: parseInt(file.metadata.size as string, 10) || 0,
      lastModified:
        (file.metadata.updated as string) || new Date().toISOString(),
      etag: file.metadata.etag as string,
    }));

    return {
      files: fileInfos,
      isTruncated: !!apiResponse?.nextPageToken,
      continuationToken: apiResponse?.nextPageToken,
    };
  }

  async delete(options: SessionStorageOptions): Promise<boolean> {
    const prefix = `${this.getSessionPrefix(options)}/`;

    try {
      // Delete all files with the prefix
      await this.bucket.deleteFiles({
        prefix,
        force: true,
      });
      return true;
    } catch (error) {
      // Check if nothing to delete
      if ((error as Error).message?.includes('No such object')) {
        return false;
      }
      throw error;
    }
  }

  async exists(options: SessionStorageOptions): Promise<boolean> {
    const result = await this.list(options, { maxKeys: 1 });
    return result.files.length > 0;
  }

  async getSize(options: SessionStorageOptions): Promise<number> {
    let totalSize = 0;
    let continuationToken: string | undefined;

    do {
      const result = await this.list(options, { continuationToken });
      totalSize += result.files.reduce((sum, file) => sum + file.size, 0);
      continuationToken = result.continuationToken;
    } while (continuationToken);

    return totalSize;
  }

  getUrl(options: SessionStorageOptions, filePath: string): string {
    const objectName = this.getObjectName(options, filePath);
    return `https://storage.googleapis.com/${this.bucketName}/${objectName}`;
  }

  async append(
    options: SessionStorageOptions,
    filePath: string,
    content: string | Buffer
  ): Promise<void> {
    // GCS doesn't support append, so read, concatenate, and write
    const existing = await this.retrieve(options, filePath);
    const newContent =
      typeof content === 'string'
        ? (existing || '') + content
        : Buffer.concat([
            existing ? Buffer.from(existing as string) : Buffer.alloc(0),
            content,
          ]);

    await this.store(options, [
      {
        path: filePath,
        content: newContent,
        contentType: this.inferContentType(filePath),
      },
    ]);
  }

  private inferContentType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = {
      json: 'application/json',
      jsonl: 'application/x-ndjson',
      txt: 'text/plain',
      md: 'text/markdown',
      html: 'text/html',
      xml: 'application/xml',
    };
    return types[ext || ''] || 'application/octet-stream';
  }

  private isTextFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ['json', 'jsonl', 'txt', 'md', 'html', 'xml', 'csv'].includes(
      ext || ''
    );
  }
}
