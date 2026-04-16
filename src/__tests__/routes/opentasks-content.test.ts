/**
 * Tests for OpenTasks content API endpoints.
 *
 * Tests the 4 OpenTasks-specific routes:
 * - GET /resources/:id/content/opentasks/summary
 * - GET /resources/:id/content/opentasks/ready
 * - GET /resources/:id/content/opentasks/tasks
 * - GET /resources/:id/content/opentasks/status
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mock the daemon client so tests work without a running daemon.
// Routes use dynamic import: await import('../../map/task-daemon-client.js')
// ---------------------------------------------------------------------------

vi.mock('../../map/task-daemon-client.js', async () => {
  const { existsSync, statSync, readFileSync } = await import('fs');
  const { join } = await import('path');

  class TaskDaemonError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'TaskDaemonError';
      this.code = code;
    }
  }

  function resolveDaemonSocket(opentasksDir: string): string {
    const configPath = join(opentasksDir, 'config.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (config.daemon?.socketPath) return config.daemon.socketPath;
      } catch { /* fall through */ }
    }

    const directSocket = join(opentasksDir, 'daemon.sock');
    if (existsSync(directSocket)) return directSocket;

    const nestedSocket = join(opentasksDir, '.opentasks', 'daemon.sock');
    if (existsSync(nestedSocket)) return nestedSocket;

    return directSocket;
  }

  function _parseJsonl(opentasksDir: string): { nodes: any[]; edges: any[] } {
    const graphPath = join(opentasksDir, 'graph.jsonl');
    if (!existsSync(graphPath)) return { nodes: [], edges: [] };
    const lines = readFileSync(graphPath, 'utf-8').split('\n').filter((l: string) => l.trim());
    const nodes: any[] = [];
    const edges: any[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.from_id && obj.to_id) edges.push(obj);
        else nodes.push(obj);
      } catch { /* skip */ }
    }
    return { nodes, edges };
  }

  return {
    TaskDaemonError,
    resolveDaemonSocket,

    daemonGetSummary: async (_socketPath: string, opentasksDir?: string) => {
      if (!opentasksDir) throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'No opentasksDir');
      const { nodes, edges } = _parseJsonl(opentasksDir);
      const activeNodes = nodes.filter((n: any) => !n.archived && !n.deleted);
      const activeEdges = edges.filter((e: any) => !e.deleted);

      const taskCounts: Record<string, number> = { open: 0, in_progress: 0, blocked: 0, closed: 0 };
      let contextCount = 0;
      let feedbackCount = 0;
      for (const n of activeNodes) {
        if (n.type === 'task') {
          const s = n.status || 'open';
          taskCounts[s] = (taskCounts[s] ?? 0) + 1;
        } else if (n.type === 'context') contextCount++;
        else if (n.type === 'feedback') feedbackCount++;
      }

      const blockedIds = new Set<string>();
      for (const e of activeEdges) {
        if (e.type === 'blocks') {
          const blocker = activeNodes.find((n: any) => n.id === e.from_id);
          if (blocker && blocker.status !== 'closed') {
            blockedIds.add(e.to_id);
          }
        }
      }
      const readyCount = activeNodes.filter(
        (n: any) => n.type === 'task' && n.status === 'open' && !blockedIds.has(n.id),
      ).length;

      return {
        node_count: activeNodes.length,
        edge_count: activeEdges.length,
        task_counts: taskCounts,
        context_count: contextCount,
        feedback_count: feedbackCount,
        ready_count: readyCount,
        daemon_connected: false,
      };
    },

    daemonGetReady: async (_socketPath: string, limit?: number, opentasksDir?: string) => {
      if (!opentasksDir) throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'No opentasksDir');
      const { nodes, edges } = _parseJsonl(opentasksDir);
      const activeNodes = nodes.filter((n: any) => !n.archived && !n.deleted);
      const activeEdges = edges.filter((e: any) => !e.deleted);

      const blockedIds = new Set<string>();
      for (const e of activeEdges) {
        if (e.type === 'blocks') {
          const blocker = activeNodes.find((n: any) => n.id === e.from_id);
          if (blocker && blocker.status !== 'closed') {
            blockedIds.add(e.to_id);
          }
        }
      }

      let ready = activeNodes
        .filter((n: any) => n.type === 'task' && n.status === 'open' && !blockedIds.has(n.id))
        .sort((a: any, b: any) => (a.priority ?? 999) - (b.priority ?? 999));

      if (limit) ready = ready.slice(0, limit);

      return { items: ready, total: ready.length, daemon_connected: false };
    },

    daemonQueryNodes: async (_socketPath: string, filter: any, opentasksDir?: string) => {
      if (!opentasksDir) throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'No opentasksDir');
      const { nodes } = _parseJsonl(opentasksDir);
      let items = nodes.filter((n: any) => !n.archived && !n.deleted);
      if (filter.type) items = items.filter((n: any) => n.type === filter.type);
      if (filter.status) items = items.filter((n: any) => n.status === filter.status);
      return { items, total: items.length, daemon_connected: false };
    },

    daemonGetStatus: async (_socketPath: string, opentasksDir: string) => {
      const graphPath = join(opentasksDir, 'graph.jsonl');
      const graphExists = existsSync(graphPath);
      return {
        daemon_running: false,
        graph_file_exists: graphExists,
        graph_last_modified: graphExists ? statSync(graphPath).mtime.toISOString() : null,
        socket_path: _socketPath,
      };
    },

    daemonGetGraph: async (_socketPath: string, opentasksDir?: string) => {
      if (!opentasksDir) throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'No opentasksDir');
      const { nodes, edges } = _parseJsonl(opentasksDir);
      return { nodes, edges };
    },

    daemonCreateTask: async () => {
      throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'Daemon not running');
    },

    daemonUpdateTask: async () => {
      throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'Daemon not running');
    },
  };
});

import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

// ============================================================================
// Fixture Builders
// ============================================================================

interface GraphNode {
  id: string;
  type: 'task' | 'context' | 'feedback' | 'external';
  title?: string;
  status?: string;
  priority?: number;
  archived?: boolean;
}

interface GraphEdge {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  deleted?: boolean;
}

function buildGraphJsonl(nodes: GraphNode[], edges: GraphEdge[]): string {
  return [...nodes, ...edges].map(obj => JSON.stringify(obj)).join('\n') + '\n';
}

/** Create an .opentasks/ directory with graph.jsonl */
function createOpenTasksFixture(
  baseDir: string,
  opts: {
    nodes?: GraphNode[];
    edges?: GraphEdge[];
    config?: Record<string, unknown>;
  } = {},
): string {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(
    path.join(baseDir, 'graph.jsonl'),
    buildGraphJsonl(opts.nodes || [], opts.edges || []),
  );
  if (opts.config) {
    fs.writeFileSync(
      path.join(baseDir, 'config.json'),
      JSON.stringify(opts.config, null, 2),
    );
  }
  return baseDir;
}

// ============================================================================
// Test Setup
// ============================================================================

const TEST_ROOT = testRoot('opentasks-content');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'opentasks-content.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test OpenHive', description: 'Test instance' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(resourceContentRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

// ============================================================================
// Tests
// ============================================================================

describe('OpenTasks Content Routes', () => {
  let app: FastifyInstance;
  let config: Config;
  let testAgent: { id: string; apiKey: string };
  let otherAgent: { id: string; apiKey: string };

  let opentasksResource: { id: string };
  let memoryResource: { id: string };
  let opentasksDir: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    config = createTestConfig();
    app = await createTestApp(config);

    // Create test agents
    const { agent: a1, apiKey: k1 } = await agentsDAL.createAgent({
      name: 'ot-content-test-agent',
      description: 'Test agent for OpenTasks content routes',
    });
    testAgent = { id: a1.id, apiKey: k1 };

    const { agent: a2, apiKey: k2 } = await agentsDAL.createAgent({
      name: 'ot-other-agent',
      description: 'Another agent',
    });
    otherAgent = { id: a2.id, apiKey: k2 };

    // Create OpenTasks fixture directory
    opentasksDir = mkTestDir(TEST_ROOT, 'opentasks-store');
    createOpenTasksFixture(opentasksDir, {
      nodes: [
        { id: 't-1', type: 'task', title: 'Setup CI', status: 'open', priority: 1 },
        { id: 't-2', type: 'task', title: 'Write tests', status: 'open', priority: 2 },
        { id: 't-3', type: 'task', title: 'Deploy', status: 'open', priority: 3 },
        { id: 't-4', type: 'task', title: 'Design review', status: 'in_progress' },
        { id: 't-5', type: 'task', title: 'Fix bug', status: 'closed' },
        { id: 'c-1', type: 'context', title: 'Project overview' },
        { id: 'f-1', type: 'feedback', title: 'Review comment' },
      ],
      edges: [
        // t-3 (Deploy) is blocked by t-1 (Setup CI) which is open
        { id: 'e-1', from_id: 't-1', to_id: 't-3', type: 'blocks' },
        // t-2 (Write tests) is blocked by t-5 (Fix bug) which is closed — so t-2 is ready
        { id: 'e-2', from_id: 't-5', to_id: 't-2', type: 'blocks' },
        { id: 'e-3', from_id: 'c-1', to_id: 't-1', type: 'references' },
      ],
    });

    // Create an OpenTasks task resource pointing to the fixture
    opentasksResource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'Test OpenTasks Store',
      description: 'OpenTasks store for testing',
      git_remote_url: opentasksDir,
      visibility: 'private',
      owner_agent_id: testAgent.id,
      metadata: { opentasks: true },
    });

    // Create a non-OpenTasks resource for negative tests
    const memDir = mkTestDir(TEST_ROOT, 'memory-bank');
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Memory\n');
    memoryResource = resourcesDAL.createResource({
      resource_type: 'memory_bank',
      name: 'Test Memory',
      git_remote_url: memDir,
      visibility: 'private',
      owner_agent_id: testAgent.id,
    });
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ==========================================================================
  // GET /resources/:id/content/opentasks/summary
  // ==========================================================================

  describe('GET /resources/:id/content/opentasks/summary', () => {
    it('should return graph summary with correct counts', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/summary`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.node_count).toBe(7);
      expect(body.edge_count).toBe(3);
      expect(body.context_count).toBe(1);
      expect(body.feedback_count).toBe(1);
      expect(body.task_counts).toEqual({
        open: 3,
        in_progress: 1,
        blocked: 0,
        closed: 1,
      });
      expect(body.daemon_connected).toBe(false);
    });

    it('should compute ready_count correctly', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/summary`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      // t-1 (open, no blockers) = ready
      // t-2 (open, blocked by t-5 which is closed) = ready
      // t-3 (open, blocked by t-1 which is open) = NOT ready
      expect(body.ready_count).toBe(2);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/summary`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for unauthorized agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/summary`,
        headers: { Authorization: `Bearer ${otherAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should return 404 for non-existent resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/resources/res_nonexistent/content/opentasks/summary',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('should return 400 for non-OpenTasks resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/opentasks/summary`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('OpenTasks');
    });
  });

  // ==========================================================================
  // GET /resources/:id/content/opentasks/ready
  // ==========================================================================

  describe('GET /resources/:id/content/opentasks/ready', () => {
    it('should return unblocked open tasks', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/ready`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.items).toBeInstanceOf(Array);
      expect(body.daemon_connected).toBe(false);
      expect(body.total).toBeGreaterThan(0);

      const ids = body.items.map((t: { id: string }) => t.id);
      expect(ids).toContain('t-1'); // unblocked
      expect(ids).toContain('t-2'); // blocker (t-5) is closed
      expect(ids).not.toContain('t-3'); // blocked by open t-1
      expect(ids).not.toContain('t-4'); // in_progress, not open
      expect(ids).not.toContain('t-5'); // closed
    });

    it('should sort results by priority', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/ready`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      const priorities = body.items.map((t: { priority?: number }) => t.priority ?? 999);
      for (let i = 1; i < priorities.length; i++) {
        expect(priorities[i]).toBeGreaterThanOrEqual(priorities[i - 1]);
      }
    });

    it('should respect limit query param', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/ready?limit=1`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items.length).toBeLessThanOrEqual(1);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/ready`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 400 for non-OpenTasks resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/opentasks/ready`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ==========================================================================
  // GET /resources/:id/content/opentasks/tasks
  // ==========================================================================

  describe('GET /resources/:id/content/opentasks/tasks', () => {
    it('should return task nodes from JSONL', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.daemon_connected).toBe(true);
      expect(body.items).toBeInstanceOf(Array);
      // Should have task-type nodes
      expect(body.items.length).toBeGreaterThan(0);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/tasks`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 400 for non-OpenTasks resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ==========================================================================
  // GET /resources/:id/content/opentasks/status
  // ==========================================================================

  describe('GET /resources/:id/content/opentasks/status', () => {
    it('should return daemon and graph file status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/status`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.daemon_running).toBe(false);
      expect(body.graph_file_exists).toBe(true);
      expect(body.graph_last_modified).toBeTruthy();
      expect(new Date(body.graph_last_modified).getTime()).not.toBeNaN();
      expect(body.socket_path).toContain('daemon.sock');
    });

    it('should handle missing graph.jsonl', async () => {
      // Create resource pointing to empty dir
      const emptyDir = mkTestDir(TEST_ROOT, 'empty-opentasks');
      const emptyResource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'Empty OpenTasks',
        git_remote_url: emptyDir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
        metadata: { opentasks: true },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${emptyResource.id}/content/opentasks/status`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.graph_file_exists).toBe(false);
      expect(body.graph_last_modified).toBeNull();
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/status`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for unauthorized agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/status`,
        headers: { Authorization: `Bearer ${otherAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should return 400 for non-OpenTasks resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/opentasks/status`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ==========================================================================
  // Edge case: empty graph
  // ==========================================================================

  describe('empty graph', () => {
    let emptyGraphResource: { id: string };

    beforeAll(() => {
      const dir = mkTestDir(TEST_ROOT, 'empty-graph-store');
      createOpenTasksFixture(dir, { nodes: [], edges: [] });

      emptyGraphResource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'Empty Graph',
        git_remote_url: dir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
        metadata: { opentasks: true },
      });
    });

    it('summary should return all zeros', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${emptyGraphResource.id}/content/opentasks/summary`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.node_count).toBe(0);
      expect(body.edge_count).toBe(0);
      expect(body.ready_count).toBe(0);
    });

    it('ready should return empty items', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${emptyGraphResource.id}/content/opentasks/ready`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // ==========================================================================
  // Graceful fallback when local path is missing
  // ==========================================================================

  describe('Behavior when daemon cannot start for a resource', () => {
    let noPathResource: { id: string };

    beforeAll(() => {
      // Create a task resource pointing to a path that will be auto-created
      // but the daemon won't start (no opentasks CLI in mocked env)
      noPathResource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'Ghost OpenTasks',
        description: 'Points to an auto-created path',
        git_remote_url: '/tmp/nonexistent-opentasks-' + Date.now(),
        visibility: 'private',
        owner_agent_id: testAgent.id,
        metadata: { opentasks: true },
      });
    });

    it('GET /opentasks/tasks should return empty items for auto-created path', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${noPathResource.id}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      // Path is auto-created for opentasks resources, mock daemon returns empty
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items).toEqual([]);
    });

    it('GET /opentasks/ready should return empty items for auto-created path', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${noPathResource.id}/content/opentasks/ready`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items).toEqual([]);
    });

    it('GET /opentasks/status should report daemon not running', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${noPathResource.id}/content/opentasks/status`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.daemon_running).toBe(false);
    });
  });
});
