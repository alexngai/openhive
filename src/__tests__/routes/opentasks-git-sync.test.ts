/**
 * Tests for OpenTasks git sync endpoints and read-only enforcement.
 *
 * Covers:
 * - GET /resources/:id/content/opentasks/git-status — sync state detection
 * - POST /resources/:id/content/opentasks/git-commit — commit graph files
 * - POST /resources/:id/content/opentasks/git-push — commit + push
 * - Read-only enforcement: 403 on POST/PATCH for ls-remote without git sync
 * - Mutations allowed when git sync enabled in metadata
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Mock the daemon client — tests focus on git sync + read-only, not daemon IPC
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
    daemonCreateTask: async () => { throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'); },
    daemonUpdateTask: async () => { throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'not running'); },
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

const TEST_ROOT = testRoot('opentasks-git-sync');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'git-sync.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Git Sync Test' },
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

describe('OpenTasks Git Sync & Read-Only', () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const config = createTestConfig();
    app = await createTestApp(config);

    const { agent, apiKey } = await agentsDAL.createAgent({
      name: 'git-sync-test-agent',
      description: 'Agent for git sync tests',
    });
    testAgent = { id: agent.id, apiKey };
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ==========================================================================
  // Read-Only Enforcement
  // ==========================================================================

  describe('Read-only enforcement for ls-remote resources', () => {
    let readOnlyResourceId: string;

    beforeAll(() => {
      const repoDir = createGitRepoWithOpentasks('read-only-repo');
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'read-only-tasks',
        git_remote_url: repoDir,
        owner_agent_id: testAgent.id,
        sync_strategy: 'ls-remote',
        local_path: repoDir,
        metadata: { opentasks: true },  // no opentasks_config.sync — read-only
      });
      readOnlyResourceId = resource.id;
    });

    it('POST /tasks should return 403 for read-only resource', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${readOnlyResourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Should be rejected' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('read-only');
    });

    it('PATCH /tasks/:nodeId should return 403 for read-only resource', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${readOnlyResourceId}/content/opentasks/tasks/t1`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { status: 'in_progress' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('read-only');
    });

    it('GET endpoints should still work (read-only, not no-access)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${readOnlyResourceId}/content/opentasks/status`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ==========================================================================
  // Mutations Allowed with Git Sync
  // ==========================================================================

  describe('Mutations allowed when git sync is enabled', () => {
    let syncEnabledResourceId: string;

    beforeAll(() => {
      const repoDir = createGitRepoWithOpentasks('sync-enabled-repo');
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'sync-enabled-tasks',
        git_remote_url: repoDir,
        owner_agent_id: testAgent.id,
        sync_strategy: 'ls-remote',
        local_path: repoDir,
        metadata: {
          opentasks: true,
          opentasks_config: {
            sync: { git: { enabled: true, autoCommit: true, autoPush: false } },
          },
        },
      });
      syncEnabledResourceId = resource.id;
    });

    it('POST /tasks should not return 403 (daemon may 503 but not 403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${syncEnabledResourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Should be allowed' },
      });

      // 503 = daemon not running (expected in mocked env), but NOT 403
      expect(res.statusCode).not.toBe(403);
    });

    it('PATCH /tasks/:nodeId should not return 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${syncEnabledResourceId}/content/opentasks/tasks/t1`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { status: 'in_progress' },
      });

      expect(res.statusCode).not.toBe(403);
    });
  });

  // ==========================================================================
  // Local resources are never read-only
  // ==========================================================================

  describe('Local resources (metadata strategy) are not read-only', () => {
    let localResourceId: string;

    beforeAll(() => {
      const otDir = mkTestDir(TEST_ROOT, 'local-ot');
      fs.writeFileSync(path.join(otDir, 'config.json'), JSON.stringify({ version: '1.0' }));
      fs.writeFileSync(path.join(otDir, 'graph.jsonl'), '');

      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'local-tasks',
        git_remote_url: otDir,
        owner_agent_id: testAgent.id,
        sync_strategy: 'metadata',
        local_path: otDir,
        metadata: { opentasks: true },
      });
      localResourceId = resource.id;
    });

    it('POST /tasks should not return 403 for local resource', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${localResourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Local task' },
      });

      expect(res.statusCode).not.toBe(403);
    });
  });

  // ==========================================================================
  // Git Status Endpoint
  // ==========================================================================

  describe('GET /git-status', () => {
    let repoDir: string;
    let resourceId: string;

    beforeAll(() => {
      repoDir = createGitRepoWithOpentasks('git-status-repo');
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'git-status-tasks',
        git_remote_url: repoDir,
        owner_agent_id: testAgent.id,
        sync_strategy: 'ls-remote',
        local_path: repoDir,
        metadata: { opentasks: true },
      });
      resourceId = resource.id;
    });

    it('should return clean status for committed repo', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/git-status`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.hasUncommittedChanges).toBe(false);
      expect(body.localHead).toBeTruthy();
    });

    it('should detect uncommitted changes after modifying graph', async () => {
      // Modify graph.jsonl
      const graphPath = path.join(repoDir, '.opentasks', 'graph.jsonl');
      fs.appendFileSync(graphPath, '{"id":"t2","type":"task","title":"New task","status":"open"}\n');

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/git-status`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.hasUncommittedChanges).toBe(true);
    });
  });

  // ==========================================================================
  // Git Commit Endpoint
  // ==========================================================================

  describe('POST /git-commit', () => {
    let repoDir: string;
    let resourceId: string;

    beforeAll(() => {
      repoDir = createGitRepoWithOpentasks('git-commit-repo');
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'git-commit-tasks',
        git_remote_url: repoDir,
        owner_agent_id: testAgent.id,
        sync_strategy: 'ls-remote',
        local_path: repoDir,
        metadata: {
          opentasks: true,
          opentasks_config: { sync: { git: { enabled: true } } },
        },
      });
      resourceId = resource.id;
    });

    it('should return committed=false when nothing to commit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/git-commit`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.committed).toBe(false);
    });

    it('should commit changes and return hash', async () => {
      // Make a change
      const graphPath = path.join(repoDir, '.opentasks', 'graph.jsonl');
      fs.appendFileSync(graphPath, '{"id":"t3","type":"task","title":"Committed task","status":"open"}\n');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/git-commit`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.committed).toBe(true);
      expect(body.hash).toBeTruthy();

      // Verify git log shows the commit
      const log = execSync('git log --oneline -1', { cwd: repoDir }).toString().trim();
      expect(log).toContain('Update task graph');
    });

    it('should return 403 for read-only resource', async () => {
      const readOnlyDir = createGitRepoWithOpentasks('commit-readonly');
      const readOnly = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'commit-readonly-tasks',
        git_remote_url: readOnlyDir,
        owner_agent_id: testAgent.id,
        sync_strategy: 'ls-remote',
        local_path: readOnlyDir,
        metadata: { opentasks: true },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${readOnly.id}/content/opentasks/git-commit`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ==========================================================================
  // Git Push Endpoint
  // ==========================================================================

  describe('POST /git-push', () => {
    it('should return 403 for read-only resource', async () => {
      const repoDir = createGitRepoWithOpentasks('push-readonly');
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'push-readonly-tasks',
        git_remote_url: repoDir,
        owner_agent_id: testAgent.id,
        sync_strategy: 'ls-remote',
        local_path: repoDir,
        metadata: { opentasks: true },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resource.id}/content/opentasks/git-push`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
