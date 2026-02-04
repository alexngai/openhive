// ============================================================================
// S3 Session Storage Adapter
// Supports AWS S3 and S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
// ============================================================================

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import type {
  SessionStorageAdapter,
  SessionStorageOptions,
  SessionFile,
  SessionStorageResult,
  SessionFileInfo,
  ListOptions,
  ListResult,
  S3StorageConfig,
} from '../types.js';

const DEFAULT_MAX_SIZE = 500 * 1024 * 1024; // 500MB for cloud storage

export class S3SessionStorageAdapter implements SessionStorageAdapter {
  readonly type = 's3' as const;
  private client: S3Client;
  private bucket: string;
  private pathPrefix: string;
  private maxSizeBytes: number;
  private region: string;
  private endpoint?: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.pathPrefix = config.pathPrefix?.replace(/\/$/, '') || 'sessions';
    this.maxSizeBytes = config.maxSizeBytes || DEFAULT_MAX_SIZE;
    this.region = config.region;
    this.endpoint = config.endpoint;

    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint && { endpoint: config.endpoint }),
    });
  }

  private getSessionPrefix(options: SessionStorageOptions): string {
    // Organize: prefix/agents/{agentId}/sessions/{sessionId}/
    return `${this.pathPrefix}/agents/${options.agentId}/sessions/${options.sessionId}`;
  }

  private getObjectKey(options: SessionStorageOptions, filePath: string): string {
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

    // Upload files in parallel (with limit)
    const uploadPromises = files.map(async (file) => {
      const key = this.getObjectKey(options, file.path);
      const body =
        typeof file.content === 'string'
          ? Buffer.from(file.content, 'utf8')
          : file.content;

      const contentType =
        file.contentType || this.inferContentType(file.path);

      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          Metadata: file.metadata,
        })
      );

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
      location: `s3://${this.bucket}/${this.getSessionPrefix(options)}`,
      files: fileInfos,
      totalSize,
    };
  }

  async retrieve(
    options: SessionStorageOptions,
    filePath: string
  ): Promise<string | Buffer | null> {
    const key = this.getObjectKey(options, filePath);

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );

      if (!response.Body) {
        return null;
      }

      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as Readable) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Return as string for text files
      if (this.isTextFile(filePath)) {
        return buffer.toString('utf8');
      }
      return buffer;
    } catch (error) {
      if ((error as Error).name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  async retrieveStream(
    options: SessionStorageOptions,
    filePath: string
  ): Promise<NodeJS.ReadableStream | null> {
    const key = this.getObjectKey(options, filePath);

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );

      return response.Body as NodeJS.ReadableStream;
    } catch (error) {
      if ((error as Error).name === 'NoSuchKey') {
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

    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: listOptions?.maxKeys || 1000,
        ContinuationToken: listOptions?.continuationToken,
      })
    );

    const sessionPrefix = this.getSessionPrefix(options);
    const files: SessionFileInfo[] = (response.Contents || []).map((obj) => ({
      path: obj.Key!.substring(sessionPrefix.length + 1), // Remove prefix
      size: obj.Size || 0,
      lastModified: obj.LastModified?.toISOString() || new Date().toISOString(),
      etag: obj.ETag,
    }));

    return {
      files,
      isTruncated: response.IsTruncated || false,
      continuationToken: response.NextContinuationToken,
    };
  }

  async delete(options: SessionStorageOptions): Promise<boolean> {
    // First, list all objects
    const allFiles: string[] = [];
    let continuationToken: string | undefined;

    do {
      const result = await this.list(options, { continuationToken });
      allFiles.push(
        ...result.files.map((f) => this.getObjectKey(options, f.path))
      );
      continuationToken = result.continuationToken;
    } while (continuationToken);

    if (allFiles.length === 0) {
      return false;
    }

    // Delete in batches of 1000 (S3 limit)
    const batchSize = 1000;
    for (let i = 0; i < allFiles.length; i += batchSize) {
      const batch = allFiles.slice(i, i + batchSize);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
          },
        })
      );
    }

    return true;
  }

  async exists(options: SessionStorageOptions): Promise<boolean> {
    // Check if any file exists in the session prefix
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
    const key = this.getObjectKey(options, filePath);
    if (this.endpoint) {
      return `${this.endpoint}/${this.bucket}/${key}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  async append(
    options: SessionStorageOptions,
    filePath: string,
    content: string | Buffer
  ): Promise<void> {
    // S3 doesn't support append, so we need to read, concatenate, and write
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
