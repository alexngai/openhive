/**
 * Tests for OpenTasks Context Node endpoints.
 *
 * Covers:
 * - POST /resources/:id/content/opentasks/contexts — inline context creation
 * - POST /resources/:id/content/opentasks/context-files — file-backed context creation
 * - GET /resources/:id/content/opentasks/contexts/:nodeId/resolve — resolve file content
 * - GET /resources/:id/content/opentasks/contexts/:nodeId/drift — check drift
 * - POST /resources/:id/content/opentasks/contexts/:nodeId/sync — sync to HEAD
 * - GET /resources/:id/content/opentasks/context-summary — context breadcrumbs
 * - 403 on read-only resources for mutation endpoints
 * - 422 validation errors for missing/invalid fields
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Track calls to mocked daemon functions
const mockCreateContext = vi.fn();
const mockCreateContextFile = vi.fn();
const mockResolveContextFile = vi.fn();
const mockCheckContextDrift = vi.fn();
const mockSyncContextFile = vi.fn();
const mockContextSummary = vi.fn();

// Mock the daemon client — tests focus on REST layer, not daemon IPC
vi.mock('../../map/task-daemon-client.js', () => {
  class TaskDaemonError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'TaskDaemonError';
      this.code = code;
    }
  }

  return {
    TaskDaemonError,
    resolveDaemonSocket: (_dir: string) => '/tmp/nonexistent.sock',
    daemonCreateContext: (...args: unknown[]) => mockCreateContext(...args),
    daemonCreateContextFile: (...args: unknown[]) => mockCreateContextFile(...args),
    daemonResolveContextFile: (...args: unknown[]) => mockResolveContextFile(...args),
    daemonCheckContextDrift: (...args: unknown[]) => mockCheckContextDrift(...args),
    daemonSyncContextFile: (...args: unknown[]) => mockSyncContextFile(...args),
    daemonContextSummary: (...args: unknown[]) => mockContextSummary(...args),
    // Stubs for other daemon functions used during route registration
    daemonCreateTask: async () => ({ id: 'stub', title: 'stub', status: 'open', assignee: null }),
    daemonUpdateTask: async () => ({ id: 'stub', title: 'stub', status: 'open', assignee: null }),
    daemonDeleteTask: async () => undefined,
    daemonCreateLink: async () => ({ edgeId: 'stub' }),
    daemonRemoveLink: async () => undefined,
    daemonGetSummary: async () => ({ node_count: 0, edge_count: 0, task_counts: {}, context_count: 0, feedback_count: 0, ready_count: 0, daemon_connected: false }),
    daemonGetReady: async () => ({ items: [], total: 0, daemon_connected: false }),
    daemonQueryNodes: async () => ({ items: [], total: 0, daemon_connected: false }),
    daemonGetGraph: async () => ({ nodes: [], edges: [] }),
    daemonGetStatus: async (_s: string, dir: string) => ({ daemon_running: false, graph_file_exists: fs.existsSync(path.join(dir, 'graph.jsonl')), graph_last_modified: null, socket_path: '/tmp/nonexistent.sock' }),
    daemonListTasks: async () => ({ tasks: [], hasMore: false }),
    daemonAssignTask: async () => ({ id: 'stub', assignee: null }),
  };
});

import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('opentasks-context');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'context.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Context Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(async (api) => {
    await api.register(resourceContentRoutes, { config });
  }, { prefix: '/api/v1' });
  return app;
}

/** Create a git repo with .opentasks/ directory for testing */
function createGitRepoWithOpentasks(name: string): string {
  const repoDir = mkTestDir(TEST_ROOT, name);

  execSync('git init -q', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'ignore' });

  const otDir = path.join(repoDir, '.opentasks');
  fs.mkdirSync(otDir, { recursive: true });
  fs.writeFileSync(path.join(otDir, 'config.json'), JSON.stringify({ version: '1.0', location: { name } }));
  fs.writeFileSync(path.join(otDir, 'graph.jsonl'), '{"id":"t1","type":"task","title":"Test task","status":"open"}\n');

  execSync('git add -A', { cwd: repoDir, stdio: 'ignore' });
  execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

  return repoDir;
}

describe('OpenTasks Context Endpoints', () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };
  let writableResourceId: string;
  let readOnlyResourceId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const config = createTestConfig();
    app = await createTestApp(config);

    const { agent, apiKey } = await agentsDAL.createAgent({
      name: 'context-test-agent',
      description: 'Agent for context tests',
    });
    testAgent = { id: agent.id, apiKey };

    // Create writable resource (local strategy)
    const writableDir = mkTestDir(TEST_ROOT, 'writable-ot');
    fs.writeFileSync(path.join(writableDir, 'config.json'), JSON.stringify({ version: '1.0' }));
    fs.writeFileSync(path.join(writableDir, 'graph.jsonl'), '');
    const writable = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'writable-ctx',
      git_remote_url: writableDir,
      owner_agent_id: testAgent.id,
      sync_strategy: 'metadata',
      local_path: writableDir,
      metadata: { opentasks: true },
    });
    writableResourceId = writable.id;

    // Create read-only resource (ls-remote without git sync)
    const readOnlyDir = createGitRepoWithOpentasks('readonly-ctx');
    const readOnly = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'readonly-ctx',
      git_remote_url: readOnlyDir,
      owner_agent_id: testAgent.id,
      sync_strategy: 'ls-remote',
      local_path: readOnlyDir,
      metadata: { opentasks: true },
    });
    readOnlyResourceId = readOnly.id;

    // Set up default mock returns
    mockCreateContext.mockResolvedValue({ id: 'ctx-1', title: 'Test Context', type: 'context' });
    mockCreateContextFile.mockResolvedValue({ id: 'ctx-file-1', title: 'README.md', type: 'context' });
    mockResolveContextFile.mockResolvedValue({
      content: '# Hello\nWorld',
      drifted: false,
      filePath: 'README.md',
      commit: 'abc123',
      contentHash: 'sha256:deadbeef',
    });
    mockCheckContextDrift.mockResolvedValue({
      drifted: false,
      currentHash: 'sha256:deadbeef',
      capturedHash: 'sha256:deadbeef',
    });
    mockSyncContextFile.mockResolvedValue({ id: 'ctx-file-1', title: 'README.md' });
    mockContextSummary.mockResolvedValue({
      contexts: [{ id: 'ctx-1', title: 'Test', type: 'inline' }],
      total: 1,
    });
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ==========================================================================
  // Inline Context Creation
  // ==========================================================================

  describe('POST /contexts — Inline Context Creation', () => {
    beforeAll(() => {
      mockCreateContext.mockClear();
      mockCreateContext.mockResolvedValue({ id: 'ctx-new', title: 'My Context', type: 'context' });
    });

    it('should create an inline context node', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'My Context', content: 'Some inline content' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.node_id).toBe('ctx-new');
      expect(body.type).toBe('context');
    });

    it('should pass title, content, priority, and tags to daemon', async () => {
      mockCreateContext.mockResolvedValue({ id: 'ctx-full', title: 'Full', type: 'context' });

      await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Full', content: 'Body text', priority: 3, tags: ['arch', 'design'] },
      });

      expect(mockCreateContext).toHaveBeenCalledWith(
        expect.any(String), // socketPath
        expect.objectContaining({
          title: 'Full',
          content: 'Body text',
          priority: 3,
          tags: ['arch', 'design'],
        }),
        expect.any(String), // localPath
      );
    });

    it('should return 403 for read-only resource', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${readOnlyResourceId}/content/opentasks/contexts`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Should fail' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('read-only');
    });

    it('should return 422 for missing title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { content: 'No title provided' },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 422 for empty title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: '' },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 503 when daemon is not running', async () => {
      const { TaskDaemonError } = await import('../../map/task-daemon-client.js');
      mockCreateContext.mockRejectedValueOnce(new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'));

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Daemon down' },
      });

      expect(res.statusCode).toBe(503);
    });
  });

  // ==========================================================================
  // File-Backed Context Creation
  // ==========================================================================

  describe('POST /context-files — File-Backed Context', () => {
    beforeAll(() => {
      mockCreateContextFile.mockClear();
      mockCreateContextFile.mockResolvedValue({ id: 'ctx-file-new', title: 'src/main.ts', type: 'context' });
    });

    it('should create a file-backed context node', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/context-files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { filePath: 'src/main.ts' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.node_id).toBe('ctx-file-new');
      expect(body.type).toBe('context');
    });

    it('should accept optional title and commit', async () => {
      mockCreateContextFile.mockResolvedValue({ id: 'ctx-file-opt', title: 'Custom Title', type: 'context' });

      await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/context-files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { filePath: 'README.md', title: 'Custom Title', commit: 'abc1234' },
      });

      expect(mockCreateContextFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          filePath: 'README.md',
          title: 'Custom Title',
          commit: 'abc1234',
        }),
        expect.any(String),
      );
    });

    it('should return 403 for read-only resource', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${readOnlyResourceId}/content/opentasks/context-files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { filePath: 'src/main.ts' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('read-only');
    });

    it('should return 422 for missing filePath', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/context-files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Missing path' },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 422 for empty filePath', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/context-files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { filePath: '' },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 503 when daemon is not running', async () => {
      const { TaskDaemonError } = await import('../../map/task-daemon-client.js');
      mockCreateContextFile.mockRejectedValueOnce(new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'));

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/context-files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { filePath: 'src/main.ts' },
      });

      expect(res.statusCode).toBe(503);
    });
  });

  // ==========================================================================
  // Resolve File Content
  // ==========================================================================

  describe('GET /contexts/:nodeId/resolve — Resolve File Content', () => {
    beforeAll(() => {
      mockResolveContextFile.mockClear();
      mockResolveContextFile.mockResolvedValue({
        content: '# README\nProject docs',
        drifted: false,
        filePath: 'README.md',
        commit: 'abc123',
        contentHash: 'sha256:aabbccdd',
      });
    });

    it('should resolve file content for a context node', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts/ctx-file-1/resolve`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.content).toBe('# README\nProject docs');
      expect(body.drifted).toBe(false);
      expect(body.filePath).toBe('README.md');
      expect(body.commit).toBe('abc123');
      expect(body.contentHash).toBe('sha256:aabbccdd');
    });

    it('should pass nodeId to daemon client', async () => {
      await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts/my-node-id/resolve`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(mockResolveContextFile).toHaveBeenCalledWith(
        expect.any(String), // socketPath
        'my-node-id',
        expect.any(String), // localPath
      );
    });

    it('should return 503 when daemon is not running', async () => {
      const { TaskDaemonError } = await import('../../map/task-daemon-client.js');
      mockResolveContextFile.mockRejectedValueOnce(new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'));

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts/ctx-1/resolve`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(503);
    });
  });

  // ==========================================================================
  // Check Drift
  // ==========================================================================

  describe('GET /contexts/:nodeId/drift — Check Drift', () => {
    beforeAll(() => {
      mockCheckContextDrift.mockClear();
      mockCheckContextDrift.mockResolvedValue({
        drifted: true,
        currentHash: 'sha256:newvalue',
        capturedHash: 'sha256:oldvalue',
      });
    });

    it('should check drift for a context node', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts/ctx-file-1/drift`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.drifted).toBe(true);
      expect(body.currentHash).toBe('sha256:newvalue');
      expect(body.capturedHash).toBe('sha256:oldvalue');
    });

    it('should pass nodeId to daemon client', async () => {
      await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts/drift-node/drift`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(mockCheckContextDrift).toHaveBeenCalledWith(
        expect.any(String),
        'drift-node',
        expect.any(String),
      );
    });

    it('should return 503 when daemon is not running', async () => {
      const { TaskDaemonError } = await import('../../map/task-daemon-client.js');
      mockCheckContextDrift.mockRejectedValueOnce(new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'));

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts/ctx-1/drift`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(503);
    });
  });

  // ==========================================================================
  // Sync to HEAD
  // ==========================================================================

  describe('POST /contexts/:nodeId/sync — Sync to HEAD', () => {
    beforeAll(() => {
      mockSyncContextFile.mockClear();
      mockSyncContextFile.mockResolvedValue({ id: 'ctx-synced', title: 'Synced File' });
    });

    it('should sync a context node to HEAD', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts/ctx-file-1/sync`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('ctx-synced');
      expect(body.title).toBe('Synced File');
    });

    it('should pass force flag when provided', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts/ctx-file-1/sync`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { force: true },
      });

      expect(mockSyncContextFile).toHaveBeenCalledWith(
        expect.any(String),
        'ctx-file-1',
        true,   // force
        expect.any(String),
      );
    });

    it('should return 403 for read-only resource', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${readOnlyResourceId}/content/opentasks/contexts/ctx-1/sync`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('read-only');
    });

    it('should return 503 when daemon is not running', async () => {
      const { TaskDaemonError } = await import('../../map/task-daemon-client.js');
      mockSyncContextFile.mockRejectedValueOnce(new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'));

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/contexts/ctx-1/sync`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(503);
    });
  });

  // ==========================================================================
  // Context Summary / Breadcrumbs
  // ==========================================================================

  describe('GET /context-summary — Context Breadcrumbs', () => {
    beforeAll(() => {
      mockContextSummary.mockClear();
      mockContextSummary.mockResolvedValue({
        contexts: [
          { id: 'ctx-1', title: 'Architecture', type: 'inline' },
          { id: 'ctx-2', title: 'README.md', type: 'file' },
        ],
        total: 2,
      });
    });

    it('should return context summary', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/context-summary`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.contexts).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('should pass query params to daemon', async () => {
      await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/context-summary?taskId=t1&branch=main&limit=10`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(mockContextSummary).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          taskId: 't1',
          branch: 'main',
        }),
        expect.any(String),
      );
    });

    it('should return 503 when daemon is not running', async () => {
      const { TaskDaemonError } = await import('../../map/task-daemon-client.js');
      mockContextSummary.mockRejectedValueOnce(new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'));

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/context-summary`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(503);
    });
  });
});
