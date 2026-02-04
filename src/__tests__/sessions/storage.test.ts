import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  LocalSessionStorageAdapter,
  createSessionStorage,
  initializeLocalSessionStorage,
  getSessionStorage,
  isSessionStorageInitialized,
  parseStorageLocation,
  calculateChecksum,
} from '../../sessions/storage/index.js';
import type { LocalStorageConfig, SessionFile } from '../../sessions/storage/types.js';

const TEST_STORAGE_PATH = './test-data/sessions';

// ============================================================================
// Test Utilities
// ============================================================================

function cleanupTestStorage() {
  if (fs.existsSync(TEST_STORAGE_PATH)) {
    fs.rmSync(TEST_STORAGE_PATH, { recursive: true, force: true });
  }
}

// ============================================================================
// Local Storage Adapter Tests
// ============================================================================

describe('LocalSessionStorageAdapter', () => {
  let adapter: LocalSessionStorageAdapter;
  const testSessionOptions = {
    sessionId: 'ses_test123',
    agentId: 'agent_test456',
  };

  beforeAll(() => {
    cleanupTestStorage();
    const config: LocalStorageConfig = {
      type: 'local',
      basePath: TEST_STORAGE_PATH,
      maxSizeBytes: 10 * 1024 * 1024, // 10MB for tests
    };
    adapter = new LocalSessionStorageAdapter(config);
  });

  afterAll(() => {
    cleanupTestStorage();
  });

  beforeEach(async () => {
    // Clean up test session before each test
    await adapter.delete(testSessionOptions);
  });

  describe('store', () => {
    it('should store single file', async () => {
      const files: SessionFile[] = [
        {
          path: 'session.jsonl',
          content: '{"type":"test"}\n',
          contentType: 'application/x-ndjson',
        },
      ];

      const result = await adapter.store(testSessionOptions, files);

      expect(result.location).toContain(testSessionOptions.sessionId);
      expect(result.files.length).toBe(1);
      expect(result.files[0].path).toBe('session.jsonl');
      expect(result.totalSize).toBeGreaterThan(0);
    });

    it('should store multiple files', async () => {
      const files: SessionFile[] = [
        { path: 'session.jsonl', content: '{"type":"test"}\n' },
        { path: 'manifest.json', content: '{"version":"1.0"}' },
        { path: 'artifacts/code.js', content: 'console.log("hello");' },
      ];

      const result = await adapter.store(testSessionOptions, files);

      expect(result.files.length).toBe(3);
      expect(result.files.some((f) => f.path === 'artifacts/code.js')).toBe(true);
    });

    it('should store binary content', async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const files: SessionFile[] = [
        { path: 'data.bin', content: binaryContent },
      ];

      const result = await adapter.store(testSessionOptions, files);

      expect(result.files[0].size).toBe(4);
    });

    it('should reject oversized content', async () => {
      // Create adapter with small max size
      const smallAdapter = new LocalSessionStorageAdapter({
        type: 'local',
        basePath: TEST_STORAGE_PATH,
        maxSizeBytes: 100, // Very small
      });

      const files: SessionFile[] = [
        { path: 'large.txt', content: 'x'.repeat(200) },
      ];

      await expect(smallAdapter.store(testSessionOptions, files)).rejects.toThrow(
        /exceeds maximum/
      );
    });

    it('should create nested directories', async () => {
      const files: SessionFile[] = [
        { path: 'deep/nested/path/file.txt', content: 'nested content' },
      ];

      const result = await adapter.store(testSessionOptions, files);

      expect(result.files[0].path).toBe('deep/nested/path/file.txt');
    });
  });

  describe('retrieve', () => {
    it('should retrieve stored text file', async () => {
      const content = '{"test":"data"}\n';
      await adapter.store(testSessionOptions, [
        { path: 'session.jsonl', content },
      ]);

      const retrieved = await adapter.retrieve(testSessionOptions, 'session.jsonl');

      expect(retrieved).toBe(content);
    });

    it('should retrieve stored binary file', async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      await adapter.store(testSessionOptions, [
        { path: 'data.bin', content: binaryContent },
      ]);

      const retrieved = await adapter.retrieve(testSessionOptions, 'data.bin');

      expect(Buffer.isBuffer(retrieved)).toBe(true);
      expect(retrieved).toEqual(binaryContent);
    });

    it('should return null for non-existent file', async () => {
      const retrieved = await adapter.retrieve(testSessionOptions, 'nonexistent.txt');

      expect(retrieved).toBeNull();
    });

    it('should return null for non-existent session', async () => {
      const retrieved = await adapter.retrieve(
        { sessionId: 'nonexistent', agentId: 'agent' },
        'file.txt'
      );

      expect(retrieved).toBeNull();
    });
  });

  describe('retrieveStream', () => {
    it('should return readable stream for existing file', async () => {
      const content = 'stream content';
      await adapter.store(testSessionOptions, [
        { path: 'stream.txt', content },
      ]);

      const stream = await adapter.retrieveStream(testSessionOptions, 'stream.txt');

      expect(stream).not.toBeNull();

      // Read stream content
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) {
        chunks.push(Buffer.from(chunk));
      }
      const result = Buffer.concat(chunks).toString();
      expect(result).toBe(content);
    });

    it('should return null for non-existent file', async () => {
      const stream = await adapter.retrieveStream(testSessionOptions, 'nonexistent.txt');

      expect(stream).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all files in session', async () => {
      await adapter.store(testSessionOptions, [
        { path: 'file1.txt', content: 'content1' },
        { path: 'file2.txt', content: 'content2' },
        { path: 'subdir/file3.txt', content: 'content3' },
      ]);

      const result = await adapter.list(testSessionOptions);

      expect(result.files.length).toBe(3);
      expect(result.isTruncated).toBe(false);
    });

    it('should list files with prefix filter', async () => {
      await adapter.store(testSessionOptions, [
        { path: 'session.jsonl', content: 'content' },
        { path: 'artifacts/a.js', content: 'code1' },
        { path: 'artifacts/b.js', content: 'code2' },
      ]);

      const result = await adapter.list(testSessionOptions, { prefix: 'artifacts' });

      expect(result.files.length).toBe(2);
      expect(result.files.every((f) => f.path.startsWith('artifacts'))).toBe(true);
    });

    it('should respect maxKeys limit', async () => {
      await adapter.store(testSessionOptions, [
        { path: 'file1.txt', content: '1' },
        { path: 'file2.txt', content: '2' },
        { path: 'file3.txt', content: '3' },
      ]);

      const result = await adapter.list(testSessionOptions, { maxKeys: 2 });

      expect(result.files.length).toBe(2);
      expect(result.isTruncated).toBe(true);
    });

    it('should return empty list for non-existent session', async () => {
      const result = await adapter.list({
        sessionId: 'nonexistent',
        agentId: 'agent',
      });

      expect(result.files.length).toBe(0);
      expect(result.isTruncated).toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete session and all files', async () => {
      await adapter.store(testSessionOptions, [
        { path: 'file1.txt', content: 'content1' },
        { path: 'file2.txt', content: 'content2' },
      ]);

      const deleted = await adapter.delete(testSessionOptions);

      expect(deleted).toBe(true);

      const exists = await adapter.exists(testSessionOptions);
      expect(exists).toBe(false);
    });

    it('should return false for non-existent session', async () => {
      const deleted = await adapter.delete({
        sessionId: 'nonexistent',
        agentId: 'agent',
      });

      expect(deleted).toBe(false);
    });
  });

  describe('exists', () => {
    it('should return true for existing session', async () => {
      await adapter.store(testSessionOptions, [
        { path: 'file.txt', content: 'content' },
      ]);

      const exists = await adapter.exists(testSessionOptions);

      expect(exists).toBe(true);
    });

    it('should return false for non-existent session', async () => {
      const exists = await adapter.exists({
        sessionId: 'nonexistent',
        agentId: 'agent',
      });

      expect(exists).toBe(false);
    });
  });

  describe('getSize', () => {
    it('should return total size of session', async () => {
      const content1 = 'hello';
      const content2 = 'world';
      await adapter.store(testSessionOptions, [
        { path: 'file1.txt', content: content1 },
        { path: 'file2.txt', content: content2 },
      ]);

      const size = await adapter.getSize(testSessionOptions);

      expect(size).toBe(content1.length + content2.length);
    });

    it('should return 0 for empty session', async () => {
      const size = await adapter.getSize({
        sessionId: 'nonexistent',
        agentId: 'agent',
      });

      expect(size).toBe(0);
    });
  });

  describe('getUrl', () => {
    it('should return file path', () => {
      const url = adapter.getUrl(testSessionOptions, 'session.jsonl');

      // Path may be normalized (removing leading ./)
      expect(url).toContain('test-data/sessions');
      expect(url).toContain(testSessionOptions.sessionId);
      expect(url).toContain('session.jsonl');
    });
  });

  describe('append', () => {
    it('should append to existing file', async () => {
      await adapter.store(testSessionOptions, [
        { path: 'log.txt', content: 'line1\n' },
      ]);

      await adapter.append!(testSessionOptions, 'log.txt', 'line2\n');

      const content = await adapter.retrieve(testSessionOptions, 'log.txt');
      expect(content).toBe('line1\nline2\n');
    });

    it('should create file if not exists', async () => {
      // First create the session directory
      await adapter.store(testSessionOptions, [
        { path: 'dummy.txt', content: '' },
      ]);

      await adapter.append!(testSessionOptions, 'new.txt', 'content');

      const content = await adapter.retrieve(testSessionOptions, 'new.txt');
      expect(content).toBe('content');
    });
  });
});

// ============================================================================
// Storage Factory Tests
// ============================================================================

describe('Storage Factory', () => {
  beforeAll(() => {
    cleanupTestStorage();
  });

  afterAll(() => {
    cleanupTestStorage();
  });

  describe('createSessionStorage', () => {
    it('should create local storage adapter', async () => {
      const adapter = await createSessionStorage({
        type: 'local',
        basePath: TEST_STORAGE_PATH,
      });

      expect(adapter.type).toBe('local');
    });

    it('should reject unknown storage type', async () => {
      await expect(
        createSessionStorage({ type: 'unknown' as any, basePath: '/tmp' })
      ).rejects.toThrow();
    });
  });

  describe('Global Storage Instance', () => {
    it('should initialize and retrieve storage', () => {
      initializeLocalSessionStorage({
        type: 'local',
        basePath: TEST_STORAGE_PATH,
      });

      expect(isSessionStorageInitialized()).toBe(true);

      const storage = getSessionStorage();
      expect(storage.type).toBe('local');
    });
  });
});

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('Storage Utilities', () => {
  describe('parseStorageLocation', () => {
    it('should parse local file:// URLs', () => {
      const result = parseStorageLocation('file:///home/user/sessions');

      expect(result).not.toBeNull();
      expect(result!.type).toBe('local');
      expect(result!.path).toBe('/home/user/sessions');
    });

    it('should parse S3 URLs', () => {
      const result = parseStorageLocation('s3://my-bucket/sessions/data');

      expect(result).not.toBeNull();
      expect(result!.type).toBe('s3');
      expect(result!.bucket).toBe('my-bucket');
      expect(result!.path).toBe('sessions/data');
    });

    it('should parse GCS URLs', () => {
      const result = parseStorageLocation('gs://my-bucket/sessions/data');

      expect(result).not.toBeNull();
      expect(result!.type).toBe('gcs');
      expect(result!.bucket).toBe('my-bucket');
      expect(result!.path).toBe('sessions/data');
    });

    it('should treat plain paths as local', () => {
      const result = parseStorageLocation('/home/user/sessions');

      expect(result).not.toBeNull();
      expect(result!.type).toBe('local');
      expect(result!.path).toBe('/home/user/sessions');
    });

    it('should return null for unknown protocols', () => {
      const result = parseStorageLocation('ftp://server/path');

      expect(result).toBeNull();
    });
  });

  describe('calculateChecksum', () => {
    it('should calculate SHA-256 checksum for string', async () => {
      const checksum = await calculateChecksum('hello world');

      expect(checksum).toBeDefined();
      expect(checksum.length).toBe(64); // SHA-256 hex length
    });

    it('should calculate same checksum for same content', async () => {
      const checksum1 = await calculateChecksum('same content');
      const checksum2 = await calculateChecksum('same content');

      expect(checksum1).toBe(checksum2);
    });

    it('should calculate different checksums for different content', async () => {
      const checksum1 = await calculateChecksum('content A');
      const checksum2 = await calculateChecksum('content B');

      expect(checksum1).not.toBe(checksum2);
    });

    it('should handle Buffer input', async () => {
      const buffer = Buffer.from('hello world');
      const checksum = await calculateChecksum(buffer);

      expect(checksum).toBeDefined();
      expect(checksum.length).toBe(64);
    });

    it('should produce same checksum for string and equivalent Buffer', async () => {
      const str = 'hello world';
      const buffer = Buffer.from(str);

      const checksum1 = await calculateChecksum(str);
      const checksum2 = await calculateChecksum(buffer);

      expect(checksum1).toBe(checksum2);
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Storage Integration', () => {
  let adapter: LocalSessionStorageAdapter;
  const sessionOptions = {
    sessionId: 'ses_integration',
    agentId: 'agent_integration',
  };

  beforeAll(() => {
    cleanupTestStorage();
    adapter = new LocalSessionStorageAdapter({
      type: 'local',
      basePath: TEST_STORAGE_PATH,
    });
  });

  afterAll(() => {
    cleanupTestStorage();
  });

  it('should handle full session lifecycle', async () => {
    // 1. Create session with multiple files
    const sessionContent = '{"type":"user","message":"hello"}\n{"type":"assistant","message":"hi"}';
    const manifest = JSON.stringify({
      version: '1.0',
      sessionId: sessionOptions.sessionId,
      files: { primary: 'session.jsonl' },
    });

    await adapter.store(sessionOptions, [
      { path: 'session.jsonl', content: sessionContent },
      { path: 'manifest.json', content: manifest },
    ]);

    // 2. Verify existence
    expect(await adapter.exists(sessionOptions)).toBe(true);

    // 3. Retrieve and verify content
    const retrieved = await adapter.retrieve(sessionOptions, 'session.jsonl');
    expect(retrieved).toBe(sessionContent);

    // 4. List files
    const list = await adapter.list(sessionOptions);
    expect(list.files.length).toBe(2);

    // 5. Append new content
    await adapter.append!(sessionOptions, 'session.jsonl', '\n{"type":"user","message":"bye"}');

    const updated = await adapter.retrieve(sessionOptions, 'session.jsonl');
    expect(updated).toContain('bye');

    // 6. Check size increased
    const size = await adapter.getSize(sessionOptions);
    expect(size).toBeGreaterThan(sessionContent.length);

    // 7. Delete session
    const deleted = await adapter.delete(sessionOptions);
    expect(deleted).toBe(true);

    // 8. Verify deletion
    expect(await adapter.exists(sessionOptions)).toBe(false);
  });
});
