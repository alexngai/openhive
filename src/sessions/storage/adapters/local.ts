// ============================================================================
// Local Filesystem Session Storage Adapter
// ============================================================================

import { mkdir, writeFile, readFile, readdir, stat, rm, access } from 'fs/promises';
import { createReadStream } from 'fs';
import { join, dirname } from 'path';
import type {
  SessionStorageAdapter,
  SessionStorageOptions,
  SessionFile,
  SessionStorageResult,
  SessionFileInfo,
  ListOptions,
  ListResult,
  LocalStorageConfig,
} from '../types.js';

const DEFAULT_MAX_SIZE = 100 * 1024 * 1024; // 100MB

export class LocalSessionStorageAdapter implements SessionStorageAdapter {
  readonly type = 'local' as const;
  private basePath: string;
  private maxSizeBytes: number;

  constructor(config: LocalStorageConfig) {
    this.basePath = config.basePath;
    this.maxSizeBytes = config.maxSizeBytes || DEFAULT_MAX_SIZE;
  }

  private getSessionPath(options: SessionStorageOptions): string {
    // Organize by agent and session: basePath/agents/{agentId}/sessions/{sessionId}/
    return join(this.basePath, 'agents', options.agentId, 'sessions', options.sessionId);
  }

  private getFilePath(options: SessionStorageOptions, filePath: string): string {
    return join(this.getSessionPath(options), filePath);
  }

  async store(
    options: SessionStorageOptions,
    files: SessionFile[]
  ): Promise<SessionStorageResult> {
    const sessionPath = this.getSessionPath(options);

    // Check total size
    let totalSize = 0;
    for (const file of files) {
      const size = typeof file.content === 'string'
        ? Buffer.byteLength(file.content, 'utf8')
        : file.content.length;
      totalSize += size;
    }

    if (totalSize > this.maxSizeBytes) {
      throw new Error(
        `Session size ${totalSize} exceeds maximum ${this.maxSizeBytes} bytes`
      );
    }

    // Create session directory
    await mkdir(sessionPath, { recursive: true });

    const fileInfos: SessionFileInfo[] = [];

    for (const file of files) {
      const fullPath = this.getFilePath(options, file.path);

      // Ensure parent directory exists
      await mkdir(dirname(fullPath), { recursive: true });

      // Write file
      await writeFile(fullPath, file.content);

      const stats = await stat(fullPath);
      fileInfos.push({
        path: file.path,
        size: stats.size,
        contentType: file.contentType,
        lastModified: stats.mtime.toISOString(),
      });
    }

    return {
      location: sessionPath,
      files: fileInfos,
      totalSize,
    };
  }

  async retrieve(
    options: SessionStorageOptions,
    filePath: string
  ): Promise<string | Buffer | null> {
    const fullPath = this.getFilePath(options, filePath);

    try {
      const content = await readFile(fullPath);
      // Return as string for text files, buffer otherwise
      if (filePath.endsWith('.json') || filePath.endsWith('.jsonl') || filePath.endsWith('.txt')) {
        return content.toString('utf8');
      }
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async retrieveStream(
    options: SessionStorageOptions,
    filePath: string
  ): Promise<NodeJS.ReadableStream | null> {
    const fullPath = this.getFilePath(options, filePath);

    try {
      await access(fullPath);
      return createReadStream(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async list(
    options: SessionStorageOptions,
    listOptions?: ListOptions
  ): Promise<ListResult> {
    const sessionPath = this.getSessionPath(options);
    const files: SessionFileInfo[] = [];

    try {
      await this.listRecursive(sessionPath, '', files, listOptions?.prefix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { files: [], isTruncated: false };
      }
      throw error;
    }

    // Apply maxKeys limit
    const maxKeys = listOptions?.maxKeys || 1000;
    const isTruncated = files.length > maxKeys;
    const resultFiles = files.slice(0, maxKeys);

    return {
      files: resultFiles,
      isTruncated,
      continuationToken: isTruncated ? String(maxKeys) : undefined,
    };
  }

  private async listRecursive(
    basePath: string,
    relativePath: string,
    files: SessionFileInfo[],
    prefix?: string
  ): Promise<void> {
    const currentPath = relativePath ? join(basePath, relativePath) : basePath;
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryRelativePath = relativePath
        ? join(relativePath, entry.name)
        : entry.name;

      if (prefix && !entryRelativePath.startsWith(prefix)) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.listRecursive(basePath, entryRelativePath, files, prefix);
      } else {
        const fullPath = join(basePath, entryRelativePath);
        const stats = await stat(fullPath);
        files.push({
          path: entryRelativePath,
          size: stats.size,
          lastModified: stats.mtime.toISOString(),
        });
      }
    }
  }

  async delete(options: SessionStorageOptions): Promise<boolean> {
    const sessionPath = this.getSessionPath(options);

    try {
      // Check if session exists first
      await access(sessionPath);
      await rm(sessionPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async exists(options: SessionStorageOptions): Promise<boolean> {
    const sessionPath = this.getSessionPath(options);

    try {
      await access(sessionPath);
      return true;
    } catch {
      return false;
    }
  }

  async getSize(options: SessionStorageOptions): Promise<number> {
    const result = await this.list(options);
    return result.files.reduce((sum, file) => sum + file.size, 0);
  }

  getUrl(options: SessionStorageOptions, filePath: string): string {
    // For local storage, return the file path
    return this.getFilePath(options, filePath);
  }

  async append(
    options: SessionStorageOptions,
    filePath: string,
    content: string | Buffer
  ): Promise<void> {
    const fullPath = this.getFilePath(options, filePath);

    // Ensure parent directory exists
    await mkdir(dirname(fullPath), { recursive: true });

    // Append to file
    const { appendFile } = await import('fs/promises');
    await appendFile(fullPath, content);
  }
}
