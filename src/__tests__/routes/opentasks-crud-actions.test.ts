/**
 * Tests for OpenTasks CRUD actions: delete, assignee, and links.
 *
 * Covers:
 * - DELETE /resources/:id/content/opentasks/tasks/:nodeId — soft and hard delete
 * - POST create and PATCH update with assignee field
 * - POST /resources/:id/content/opentasks/tasks/:nodeId/links — create link
 * - DELETE /resources/:id/content/opentasks/tasks/:nodeId/links/:targetId — remove link
 * - 403 on read-only resources for all mutation endpoints
 * - Validation errors for missing/invalid fields
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Track calls to mocked daemon functions
const mockDeleteTask = vi.fn();
const mockCreateTask = vi.fn();
const mockUpdateTask = vi.fn();
const mockCreateLink = vi.fn();
const mockRemoveLink = vi.fn();

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
    daemonCreateTask: (...args: unknown[]) => mockCreateTask(...args),
    daemonUpdateTask: (...args: unknown[]) => mockUpdateTask(...args),
    daemonDeleteTask: (...args: unknown[]) => mockDeleteTask(...args),
    daemonCreateLink: (...args: unknown[]) => mockCreateLink(...args),
    daemonRemoveLink: (...args: unknown[]) => mockRemoveLink(...args),
    daemonGetSummary: async () => ({ node_count: 0, edge_count: 0, task_counts: {}, context_count: 0, feedback_count: 0, ready_count: 0, daemon_connected: false }),
    daemonGetReady: async () => ({ items: [], total: 0, daemon_connected: false }),
    daemonQueryNodes: async () => ({ items: [], total: 0, daemon_connected: false }),
    daemonGetGraph: async () => ({ nodes: [], edges: [] }),
    daemonGetStatus: async (_s: string, dir: string) => ({ daemon_running: false, graph_file_exists: fs.existsSync(path.join(dir, 'graph.jsonl')), graph_last_modified: null, socket_path: '/tmp/nonexistent.sock' }),
  };
});

import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('opentasks-crud-actions');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'crud-actions.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'CRUD Actions Test' },
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

describe('OpenTasks CRUD Actions', () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };

  // Resource IDs for different test scenarios
  let writableResourceId: string;
  let readOnlyResourceId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const config = createTestConfig();
    app = await createTestApp(config);

    const { agent, apiKey } = await agentsDAL.createAgent({
      name: 'crud-actions-test-agent',
      description: 'Agent for CRUD actions tests',
    });
    testAgent = { id: agent.id, apiKey };

    // Create writable resource (local strategy — never read-only)
    const writableDir = mkTestDir(TEST_ROOT, 'writable-ot');
    fs.writeFileSync(path.join(writableDir, 'config.json'), JSON.stringify({ version: '1.0' }));
    fs.writeFileSync(path.join(writableDir, 'graph.jsonl'), '');
    const writable = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'writable-tasks',
      git_remote_url: writableDir,
      owner_agent_id: testAgent.id,
      sync_strategy: 'metadata',
      local_path: writableDir,
      metadata: { opentasks: true },
    });
    writableResourceId = writable.id;

    // Create read-only resource (ls-remote without git sync)
    const readOnlyDir = createGitRepoWithOpentasks('readonly-ot');
    const readOnly = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'readonly-tasks',
      git_remote_url: readOnlyDir,
      owner_agent_id: testAgent.id,
      sync_strategy: 'ls-remote',
      local_path: readOnlyDir,
      metadata: { opentasks: true },  // no opentasks_config.sync — read-only
    });
    readOnlyResourceId = readOnly.id;

    // Set up default mock returns
    mockCreateTask.mockResolvedValue({ id: 'new-task-1', title: 'Test', status: 'open', assignee: null });
    mockUpdateTask.mockResolvedValue({ id: 't1', title: 'Updated', status: 'in_progress', assignee: null });
    mockDeleteTask.mockResolvedValue(undefined);
    mockCreateLink.mockResolvedValue({ edgeId: 'edge-1' });
    mockRemoveLink.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ==========================================================================
  // Task Deletion
  // ==========================================================================

  describe('DELETE /tasks/:nodeId — Task Deletion', () => {
    beforeAll(() => {
      mockDeleteTask.mockClear();
    });

    it('should soft delete a task by default', async () => {
      mockDeleteTask.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.deleted).toBe(true);
      expect(body.node_id).toBe('t1');
      expect(body.hard).toBe(false);

      // Verify daemon was called with hard=false
      expect(mockDeleteTask).toHaveBeenCalledWith(
        expect.any(String), // socketPath
        't1',
        { hard: false },
        expect.any(String), // localPath
      );
    });

    it('should hard delete a task when ?hard=true', async () => {
      mockDeleteTask.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1?hard=true`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.deleted).toBe(true);
      expect(body.hard).toBe(true);

      // Verify daemon was called with hard=true
      expect(mockDeleteTask).toHaveBeenCalledWith(
        expect.any(String),
        't1',
        { hard: true },
        expect.any(String),
      );
    });

    it('should return 403 for read-only resource', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${readOnlyResourceId}/content/opentasks/tasks/t1`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('read-only');
    });

    it('should return 503 when daemon is not running', async () => {
      // Import the mocked error class
      const { TaskDaemonError } = await import('../../map/task-daemon-client.js');
      mockDeleteTask.mockRejectedValueOnce(new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'));

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(503);
    });
  });

  // ==========================================================================
  // Task Assignment (assignee in create/update)
  // ==========================================================================

  describe('Assignee field in POST create and PATCH update', () => {
    beforeAll(() => {
      mockCreateTask.mockClear();
      mockUpdateTask.mockClear();
    });

    it('POST /tasks should accept assignee and pass it to daemon', async () => {
      mockCreateTask.mockResolvedValue({ id: 'assigned-1', title: 'Assigned task', status: 'open', assignee: 'agent_worker' });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Assigned task', assignee: 'agent_worker' },
      });

      expect(res.statusCode).toBe(201);
      // Verify assignee was passed through to daemon client
      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ assignee: 'agent_worker' }),
        expect.any(String),
      );
    });

    it('POST /tasks should accept null assignee', async () => {
      mockCreateTask.mockResolvedValue({ id: 'unassigned-1', title: 'Unassigned', status: 'open', assignee: null });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Unassigned', assignee: null },
      });

      expect(res.statusCode).toBe(201);
    });

    it('PATCH /tasks/:nodeId should accept assignee and pass it to daemon', async () => {
      mockUpdateTask.mockResolvedValue({ id: 't1', title: 'Updated', status: 'open', assignee: 'new_agent' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { assignee: 'new_agent' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateTask).toHaveBeenCalledWith(
        expect.any(String),
        't1',
        expect.objectContaining({ assignee: 'new_agent' }),
        expect.any(String),
      );
    });

    it('PATCH /tasks/:nodeId should accept null assignee to unassign', async () => {
      mockUpdateTask.mockResolvedValue({ id: 't1', title: 'Updated', status: 'open', assignee: null });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { assignee: null },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ==========================================================================
  // Task Links (Dependencies)
  // ==========================================================================

  describe('POST /tasks/:nodeId/links — Create Link', () => {
    beforeAll(() => {
      mockCreateLink.mockClear();
    });

    it('should create a link between tasks', async () => {
      mockCreateLink.mockResolvedValue({ edgeId: 'edge-123' });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1/links`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { targetId: 't2', type: 'blocks' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.edge_id).toBe('edge-123');
      expect(body.from_id).toBe('t1');
      expect(body.to_id).toBe('t2');
      expect(body.type).toBe('blocks');
    });

    it('should accept all valid link types', async () => {
      const validTypes = ['blocks', 'depends-on', 'related', 'parent-of', 'implements', 'references'];

      for (const type of validTypes) {
        mockCreateLink.mockResolvedValue({ edgeId: `edge-${type}` });

        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1/links`,
          headers: { Authorization: `Bearer ${testAgent.apiKey}` },
          payload: { targetId: 't2', type },
        });

        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.type).toBe(type);
      }
    });

    it('should return 422 for invalid link type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1/links`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { targetId: 't2', type: 'invalid-type' },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 422 when targetId is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1/links`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { type: 'blocks' },
      });

      expect(res.statusCode).toBe(422);
    });

    it('should return 422 when type is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1/links`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { targetId: 't2' },
      });

      expect(res.statusCode).toBe(422);
    });

    it('should return 403 for read-only resource', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${readOnlyResourceId}/content/opentasks/tasks/t1/links`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { targetId: 't2', type: 'blocks' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('read-only');
    });

    it('should return 503 when daemon is not running', async () => {
      const { TaskDaemonError } = await import('../../map/task-daemon-client.js');
      mockCreateLink.mockRejectedValueOnce(new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'));

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1/links`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { targetId: 't2', type: 'blocks' },
      });

      expect(res.statusCode).toBe(503);
    });

    it('should pass fromId, toId, and type to daemon client', async () => {
      mockCreateLink.mockResolvedValue({ edgeId: 'edge-verify' });

      await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/source-node/links`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { targetId: 'target-node', type: 'depends-on' },
      });

      expect(mockCreateLink).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          fromId: 'source-node',
          toId: 'target-node',
          type: 'depends-on',
        }),
        expect.any(String),
      );
    });
  });

  describe('DELETE /tasks/:nodeId/links/:targetId — Remove Link', () => {
    beforeAll(() => {
      mockRemoveLink.mockClear();
    });

    it('should remove a link with default type (blocks)', async () => {
      mockRemoveLink.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1/links/t2`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.removed).toBe(true);

      expect(mockRemoveLink).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          fromId: 't1',
          toId: 't2',
          type: 'blocks',
        }),
        expect.any(String),
      );
    });

    it('should remove a link with specified type', async () => {
      mockRemoveLink.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1/links/t2?type=depends-on`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      expect(mockRemoveLink).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'depends-on' }),
        expect.any(String),
      );
    });

    it('should return 403 for read-only resource', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${readOnlyResourceId}/content/opentasks/tasks/t1/links/t2?type=blocks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('read-only');
    });

    it('should return 503 when daemon is not running', async () => {
      const { TaskDaemonError } = await import('../../map/task-daemon-client.js');
      mockRemoveLink.mockRejectedValueOnce(new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'));

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${writableResourceId}/content/opentasks/tasks/t1/links/t2`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(503);
    });
  });
});
