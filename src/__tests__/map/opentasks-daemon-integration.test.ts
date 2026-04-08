/**
 * Integration Test: OpenTasks Daemon — Full Local Path
 *
 * Spins up a real OpenTasks daemon via API and exercises the complete
 * flow: daemon client ops, REST API routes, and MAP task method handlers.
 *
 * Covers:
 * - Create task via daemon → query back
 * - Update task status transitions
 * - Assign task to agent
 * - Ready tasks (blocked vs unblocked)
 * - Full graph retrieval
 * - Full lifecycle: create → assign → start → complete
 * - REST endpoints with real daemon (POST/PATCH/GET)
 * - MAP task handlers (map/tasks/create, update, assign, list)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
import { handleTaskRequest, MAP_TASK_METHODS } from '../../map/task-handler.js';
import { ConfigSchema, type Config } from '../../config.js';

import {
  createGraphStore, createIPCServer, createDaemonFlushManager,
  registerToolsMethods, registerGraphMethods, registerLifecycleMethods,
  createSQLitePersister, createJSONLPersister,
  createNativeProvider, createProviderAwareStore, createProviderRegistry,
  type GraphStore, type IPCServer,
} from 'opentasks';

// Short path — macOS 104-byte Unix socket limit
const TEST_ROOT = path.join('/tmp', `ot-daemon-int-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, 'daemon-int.db');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('OpenTasks Daemon Integration', { timeout: 30000 }, () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };
  let otStore: GraphStore;
  let otServer: IPCServer;
  let daemonSocketPath: string;
  let opentasksDir: string;
  let locationHash: string;
  let resourceId: string;

  beforeAll(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    initDatabase(TEST_DB_PATH);

    const { agent, apiKey } = await agentsDAL.createAgent({
      name: 'daemon-int-agent',
      description: 'Agent for daemon integration tests',
    });
    testAgent = { id: agent.id, apiKey };

    // Set up OpenTasks daemon via API
    opentasksDir = path.join(TEST_ROOT, '.opentasks');
    fs.mkdirSync(opentasksDir, { recursive: true });

    locationHash = `daemon-int-${process.pid}`;
    daemonSocketPath = path.join(opentasksDir, 'daemon.sock');
    fs.writeFileSync(path.join(opentasksDir, 'config.json'), JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: 'daemon-int' },
      daemon: { socketPath: daemonSocketPath },
    }));
    const jsonlPath = path.join(opentasksDir, 'graph.jsonl');
    fs.writeFileSync(jsonlPath, '');

    const sqlite = createSQLitePersister(opentasksDir);
    await sqlite.initialize();
    const jsonl = createJSONLPersister(opentasksDir);
    const jsonlLoad = async () => {
      try { return fs.existsSync(jsonlPath) ? await jsonl.load() : { nodes: [], edges: [] }; }
      catch { return { nodes: [], edges: [] }; }
    };
    const jsonlSave = async (n: any[], e: any[]) => { await jsonl.save(n, e); };

    otStore = createGraphStore(
      { basePath: opentasksDir, flush: { debounceMs: 50, maxDelayMs: 100 } },
      sqlite, jsonlLoad, jsonlSave,
    );
    await otStore.initialize();

    // Set up native provider for task operations (transition, assign, ready)
    const nativeProvider = createNativeProvider(otStore);
    const registry = createProviderRegistry();
    registry.register(nativeProvider);
    const providerStore = createProviderAwareStore(otStore, { providers: registry });

    const flushMgr = createDaemonFlushManager(
      { debounceMs: 50, maxDelayMs: 100 },
      async () => { await otStore.flush(); },
    );
    otServer = createIPCServer(daemonSocketPath);

    const locState = {
      hash: locationHash, opentasksPath: opentasksDir, store: otStore,
      providerStore: providerStore,
      flushManager: flushMgr, watcher: null as any, primary: true, healthy: true,
    };
    const locResolver = {
      resolve: () => locState, getDefault: () => locState,
      list: () => [{ hash: locationHash, opentasksPath: opentasksDir, primary: true, healthy: true }],
      has: (h: string) => h === locationHash, add: () => {}, remove: async () => {},
    };
    registerLifecycleMethods({
      server: otServer,
      getStatus: () => ({ pid: process.pid, socketPath: daemonSocketPath, uptime: 0, connections: 0 } as any),
      shutdown: async () => {},
      version: '0.0.8',
      startedAt: new Date(),
    });
    registerGraphMethods({ server: otServer, locationResolver: locResolver });
    registerToolsMethods({ server: otServer, locationResolver: locResolver });
    await otServer.start();

    // Register resource in DB
    const resource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'daemon-int-resource',
      description: 'Resource for daemon integration tests',
      git_remote_url: opentasksDir,
      visibility: 'private',
      owner_agent_id: testAgent.id,
      sync_strategy: 'local',
      local_path: opentasksDir,
      metadata: { opentasks: true, location_hash: locationHash },
    });
    resourceId = resource.id;

    // Set up Fastify with resource-content routes
    const config = ConfigSchema.parse({
      database: TEST_DB_PATH,
      instance: { name: 'Daemon Integration Test' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
    }) as Config;

    app = Fastify({ logger: false });
    app.decorateRequest('agent', null);
    const { setLocalAgent } = await import('../../api/middleware/auth.js');
    setLocalAgent(testAgent.id);
    await app.register(async (api) => {
      await api.register(resourceContentRoutes, { config });
    }, { prefix: '/api/v1' });
    await app.ready();
  }, 20000);

  afterAll(async () => {
    try { await otServer?.stop(); } catch {}
    try { await otStore?.close(); } catch {}
    await app?.close();
    await sleep(200);
    closeDatabase();
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  }, 10000);

  // ==========================================================================
  // Daemon Client Operations
  // ==========================================================================

  describe('Daemon Client — Direct Operations', () => {
    it('should create a task and query it back', async () => {
      const { daemonCreateTask, daemonGetSummary } = await import('../../map/task-daemon-client.js');

      const task = await daemonCreateTask(daemonSocketPath, {
        title: 'First task',
        description: 'Test description',
        status: 'open',
        priority: 2,
      }, opentasksDir);

      expect(task.id).toBeTruthy();
      expect(task.title).toBe('First task');
      expect(task.status).toBe('open');

      // Query back via summary
      const summary = await daemonGetSummary(daemonSocketPath, opentasksDir);
      expect(summary.daemon_connected).toBe(true);
      expect(summary.node_count).toBeGreaterThanOrEqual(1);
      expect(summary.task_counts.open).toBeGreaterThanOrEqual(1);
    });

    it('should update task status through transitions', async () => {
      const { daemonCreateTask, daemonUpdateTask } = await import('../../map/task-daemon-client.js');

      const task = await daemonCreateTask(daemonSocketPath, {
        title: 'Task for transitions',
        status: 'open',
      }, opentasksDir);

      // open → in_progress (start)
      const updated = await daemonUpdateTask(daemonSocketPath, task.id, {
        status: 'in_progress',
      }, opentasksDir);
      expect(updated.status).toBe('in_progress');

      // in_progress → completed (complete)
      const completed = await daemonUpdateTask(daemonSocketPath, task.id, {
        status: 'completed',
      }, opentasksDir);
      expect(completed.status).toBe('completed');
    });

    it('should assign a task to an agent', async () => {
      const { daemonCreateTask, daemonAssignTask } = await import('../../map/task-daemon-client.js');

      const task = await daemonCreateTask(daemonSocketPath, {
        title: 'Task for assignment',
        status: 'open',
      }, opentasksDir);

      const assigned = await daemonAssignTask(
        daemonSocketPath, task.id, 'agent_worker_1', opentasksDir,
      );
      expect(assigned.assignee).toBe('agent_worker_1');
    });

    it('should compute ready tasks with blocking edges', async () => {
      const { daemonCreateTask, daemonGetReady } = await import('../../map/task-daemon-client.js');
      const { createClient } = await import('opentasks');

      // Create a blocker and a blocked task
      const blocker = await daemonCreateTask(daemonSocketPath, {
        title: 'Blocker task',
        status: 'open',
        priority: 1,
      }, opentasksDir);

      const blocked = await daemonCreateTask(daemonSocketPath, {
        title: 'Blocked task',
        status: 'open',
        priority: 1,
      }, opentasksDir);

      // Create blocking edge via direct client
      const client = createClient({ socketPath: daemonSocketPath, autoConnect: false, timeout: 5000 });
      await client.connect();
      await client.link({ fromId: blocker.id, toId: blocked.id, type: 'blocks' });
      client.disconnect();

      const ready = await daemonGetReady(daemonSocketPath, 100, opentasksDir);
      const readyIds = ready.items.map((t: any) => t.id);
      expect(readyIds).not.toContain(blocked.id);
      // blocker should be ready (nothing blocks it)
      expect(readyIds).toContain(blocker.id);
    });

    it('should return full graph with nodes', async () => {
      const { daemonGetGraph } = await import('../../map/task-daemon-client.js');

      const graph = await daemonGetGraph(daemonSocketPath, opentasksDir);
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.edges).toBeInstanceOf(Array);

      // Nodes should have expected fields
      const node = graph.nodes[0];
      expect(node).toHaveProperty('id');
      expect(node).toHaveProperty('type');
    });

    it('should report daemon status as running', async () => {
      const { daemonGetStatus } = await import('../../map/task-daemon-client.js');

      const status = await daemonGetStatus(daemonSocketPath, opentasksDir);
      expect(status.daemon_running).toBe(true);
      expect(status.graph_file_exists).toBe(true);
      expect(status.socket_path).toBe(daemonSocketPath);
    });

    it('should list tasks with status filter', async () => {
      const { daemonListTasks } = await import('../../map/task-daemon-client.js');

      const openTasks = await daemonListTasks(daemonSocketPath, { status: 'open' }, 100, opentasksDir);
      expect(openTasks.tasks.length).toBeGreaterThan(0);
      for (const task of openTasks.tasks) {
        expect(task.status).toBe('open');
      }
    });
  });

  // ==========================================================================
  // Full Task Lifecycle
  // ==========================================================================

  describe('Full Task Lifecycle', () => {
    it('create → assign → start → complete', async () => {
      const { daemonCreateTask, daemonAssignTask, daemonUpdateTask, daemonListTasks } =
        await import('../../map/task-daemon-client.js');

      // 1. Create
      const task = await daemonCreateTask(daemonSocketPath, {
        title: 'Lifecycle test task',
        description: 'Full lifecycle',
        status: 'open',
        priority: 1,
      }, opentasksDir);
      expect(task.status).toBe('open');

      // 2. Assign
      const assigned = await daemonAssignTask(
        daemonSocketPath, task.id, 'agent_lifecycle', opentasksDir,
      );
      expect(assigned.assignee).toBe('agent_lifecycle');

      // 3. Start (open → in_progress)
      const started = await daemonUpdateTask(daemonSocketPath, task.id, {
        status: 'in_progress',
      }, opentasksDir);
      expect(started.status).toBe('in_progress');

      // 4. Complete (in_progress → completed)
      const completed = await daemonUpdateTask(daemonSocketPath, task.id, {
        status: 'completed',
      }, opentasksDir);
      expect(completed.status).toBe('completed');

      // Verify via list — completed tasks should not appear in open filter
      const openTasks = await daemonListTasks(daemonSocketPath, { status: 'open' }, 100, opentasksDir);
      const openIds = openTasks.tasks.map(t => t.id);
      expect(openIds).not.toContain(task.id);
    });
  });

  // ==========================================================================
  // REST Routes with Real Daemon
  // ==========================================================================

  describe('REST Routes — Real Daemon', () => {
    it('POST /tasks should create via daemon and return node_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'REST created task', description: 'Via REST', priority: 3 },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.node_id).toBeTruthy();
      expect(body.status).toBe('open');
    });

    it('PATCH /tasks/:nodeId should update status via daemon', async () => {
      // First create
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Task to update via REST' },
      });
      const { node_id } = JSON.parse(createRes.body);

      // Then update
      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${node_id}`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { status: 'in_progress' },
      });

      expect(updateRes.statusCode).toBe(200);
      const body = JSON.parse(updateRes.body);
      expect(body.node_id).toBe(node_id);
      expect(body.new_status).toBe('in_progress');
    });

    it('GET /summary should return daemon-connected summary', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/summary`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.daemon_connected).toBe(true);
      expect(body.node_count).toBeGreaterThan(0);
      expect(body.task_counts).toBeDefined();
    });

    it('GET /ready should return ready tasks from daemon', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/ready`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.daemon_connected).toBe(true);
      expect(body.items).toBeInstanceOf(Array);
    });

    it('GET /tasks should return task list from daemon', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.daemon_connected).toBe(true);
      expect(body.items).toBeInstanceOf(Array);
      expect(body.items.length).toBeGreaterThan(0);
    });

    it('GET /graph should return full graph from daemon', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/graph`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.nodes).toBeInstanceOf(Array);
      expect(body.edges).toBeInstanceOf(Array);
      expect(body.nodes.length).toBeGreaterThan(0);
    });

    it('GET /status should report daemon_running=true', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/status`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.daemon_running).toBe(true);
      expect(body.graph_file_exists).toBe(true);
    });

    it('POST then GET round-trip — created task appears in graph', async () => {
      const uniqueTitle = `round-trip-${Date.now()}`;

      // Create
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: uniqueTitle, priority: 4 },
      });
      expect(createRes.statusCode).toBe(201);

      // Query back via graph endpoint
      const graphRes = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/graph`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const graph = JSON.parse(graphRes.body);
      const found = graph.nodes.find((n: any) => n.title === uniqueTitle);
      expect(found).toBeDefined();
      expect(found.status).toBe('open');
    });
  });

  // ==========================================================================
  // MAP Task Method Handlers
  // ==========================================================================

  describe('MAP Task Handlers — map/tasks/*', () => {
    const ctx = () => ({ swarmId: 'swarm_test', agentId: testAgent.id });

    it('map/tasks/create should create task via daemon', async () => {
      const result = await handleTaskRequest(MAP_TASK_METHODS.CREATE, {
        resource_id: resourceId,
        task: { title: 'MAP created task', description: 'Via MAP handler', priority: 2 },
      }, ctx()) as { task: any };

      expect(result.task).toBeDefined();
      expect(result.task.id).toBeTruthy();
      expect(result.task.title).toBe('MAP created task');
      expect(result.task.status).toBe('open');
    });

    it('map/tasks/list should return tasks from daemon', async () => {
      const result = await handleTaskRequest(MAP_TASK_METHODS.LIST, {
        resource_id: resourceId,
      }, ctx()) as { tasks: any[]; hasMore: boolean };

      expect(result.tasks).toBeInstanceOf(Array);
      expect(result.tasks.length).toBeGreaterThan(0);
    });

    it('map/tasks/list with status filter', async () => {
      const result = await handleTaskRequest(MAP_TASK_METHODS.LIST, {
        resource_id: resourceId,
        filter: { status: 'open' },
      }, ctx()) as { tasks: any[] };

      expect(result.tasks.length).toBeGreaterThan(0);
      for (const task of result.tasks) {
        expect(task.status).toBe('open');
      }
    });

    it('map/tasks/update should transition status via daemon', async () => {
      // Create a task first
      const created = await handleTaskRequest(MAP_TASK_METHODS.CREATE, {
        resource_id: resourceId,
        task: { title: 'MAP update test' },
      }, ctx()) as { task: any };

      // Update status
      const result = await handleTaskRequest(MAP_TASK_METHODS.UPDATE, {
        resource_id: resourceId,
        taskId: created.task.id,
        status: 'in_progress',
      }, ctx()) as { task: any };

      expect(result.task).toBeDefined();
      expect(result.task.status).toBe('in_progress');
    });

    it('map/tasks/assign should assign task via daemon', async () => {
      const created = await handleTaskRequest(MAP_TASK_METHODS.CREATE, {
        resource_id: resourceId,
        task: { title: 'MAP assign test' },
      }, ctx()) as { task: any };

      const result = await handleTaskRequest(MAP_TASK_METHODS.ASSIGN, {
        resource_id: resourceId,
        taskId: created.task.id,
        agentId: 'agent_map_worker',
      }, ctx()) as { task: any };

      expect(result.task).toBeDefined();
      expect(result.task.assignee).toBe('agent_map_worker');
    });

    it('map/tasks/create → update → list round-trip', async () => {
      const uniqueTitle = `map-roundtrip-${Date.now()}`;

      // Create
      const created = await handleTaskRequest(MAP_TASK_METHODS.CREATE, {
        resource_id: resourceId,
        task: { title: uniqueTitle, priority: 1 },
      }, ctx()) as { task: any };

      // Update to in_progress
      await handleTaskRequest(MAP_TASK_METHODS.UPDATE, {
        resource_id: resourceId,
        taskId: created.task.id,
        status: 'in_progress',
      }, ctx());

      // List and find it
      const listed = await handleTaskRequest(MAP_TASK_METHODS.LIST, {
        resource_id: resourceId,
        filter: { status: 'in_progress' },
      }, ctx()) as { tasks: any[] };

      const found = listed.tasks.find((t: any) => t.title === uniqueTitle);
      expect(found).toBeDefined();
      expect(found.status).toBe('in_progress');
    });

    it('should reject invalid params', async () => {
      // Missing task object
      await expect(
        handleTaskRequest(MAP_TASK_METHODS.CREATE, {
          resource_id: resourceId,
        }, ctx()),
      ).rejects.toThrow(/missing task object/);

      // Missing taskId for update
      await expect(
        handleTaskRequest(MAP_TASK_METHODS.UPDATE, {
          resource_id: resourceId,
          status: 'completed',
        }, ctx()),
      ).rejects.toThrow(/missing taskId/);

      // Missing taskId/agentId for assign
      await expect(
        handleTaskRequest(MAP_TASK_METHODS.ASSIGN, {
          resource_id: resourceId,
        }, ctx()),
      ).rejects.toThrow(/missing taskId or agentId/);
    });

    it('should reject unknown resource', async () => {
      await expect(
        handleTaskRequest(MAP_TASK_METHODS.LIST, {
          resource_id: 'res_nonexistent',
        }, ctx()),
      ).rejects.toThrow(/not found/i);
    });
  });

  // ==========================================================================
  // Daemon Client — Delete Task
  // ==========================================================================

  describe('Daemon Client — Delete Task', () => {
    it('should soft delete a task (archive it)', async () => {
      const { daemonCreateTask, daemonDeleteTask, daemonGetGraph } = await import('../../map/task-daemon-client.js');

      const task = await daemonCreateTask(daemonSocketPath, {
        title: 'Task to soft-delete',
        status: 'open',
      }, opentasksDir);

      await daemonDeleteTask(daemonSocketPath, task.id, { hard: false }, opentasksDir);

      // Soft-deleted tasks should be archived — not returned in graph (which filters archived: false)
      const graph = await daemonGetGraph(daemonSocketPath, opentasksDir);
      const ids = graph.nodes.map((n: any) => n.id);
      expect(ids).not.toContain(task.id);
    });

    it('should hard delete a task', async () => {
      const { daemonCreateTask, daemonDeleteTask, daemonQueryNodes } = await import('../../map/task-daemon-client.js');

      const task = await daemonCreateTask(daemonSocketPath, {
        title: 'Task to hard-delete',
        status: 'open',
      }, opentasksDir);

      await daemonDeleteTask(daemonSocketPath, task.id, { hard: true }, opentasksDir);

      // Hard-deleted tasks should not exist at all — even in archived queries
      const all = await daemonQueryNodes(daemonSocketPath, { type: 'task' }, opentasksDir);
      const ids = all.items.map((n: any) => n.id);
      expect(ids).not.toContain(task.id);
    });
  });

  // ==========================================================================
  // Daemon Client — Create and Remove Links
  // ==========================================================================

  describe('Daemon Client — Links (Dependencies)', () => {
    it('should create a blocking link between tasks', async () => {
      const { daemonCreateTask, daemonCreateLink, daemonGetReady } = await import('../../map/task-daemon-client.js');

      const taskA = await daemonCreateTask(daemonSocketPath, {
        title: 'Link source direct',
        status: 'open',
        priority: 1,
      }, opentasksDir);
      const taskB = await daemonCreateTask(daemonSocketPath, {
        title: 'Link target direct',
        status: 'open',
        priority: 1,
      }, opentasksDir);

      const result = await daemonCreateLink(daemonSocketPath, {
        fromId: taskA.id,
        toId: taskB.id,
        type: 'blocks',
      }, opentasksDir);

      // The link was created successfully (no error thrown)
      // Verify via ready computation — blocked task should not be ready
      const ready = await daemonGetReady(daemonSocketPath, 200, opentasksDir);
      const readyIds = ready.items.map((t: any) => t.id);
      expect(readyIds).not.toContain(taskB.id);
    });

    it('should remove a link between tasks', async () => {
      const { daemonCreateTask, daemonCreateLink, daemonRemoveLink, daemonGetReady } = await import('../../map/task-daemon-client.js');

      const taskA = await daemonCreateTask(daemonSocketPath, {
        title: 'Unlink source',
        status: 'open',
        priority: 1,
      }, opentasksDir);
      const taskB = await daemonCreateTask(daemonSocketPath, {
        title: 'Unlink target',
        status: 'open',
        priority: 1,
      }, opentasksDir);

      // Create link — taskB should become blocked
      await daemonCreateLink(daemonSocketPath, {
        fromId: taskA.id,
        toId: taskB.id,
        type: 'blocks',
      }, opentasksDir);

      // Remove link — taskB should become ready again
      await daemonRemoveLink(daemonSocketPath, {
        fromId: taskA.id,
        toId: taskB.id,
        type: 'blocks',
      }, opentasksDir);

      // Verify taskB is ready again (no longer blocked)
      const ready = await daemonGetReady(daemonSocketPath, 200, opentasksDir);
      const readyIds = ready.items.map((t: any) => t.id);
      expect(readyIds).toContain(taskB.id);
    });

    it('should create a link and verify it blocks ready computation', async () => {
      const { daemonCreateTask, daemonCreateLink, daemonGetReady } = await import('../../map/task-daemon-client.js');

      const blocker = await daemonCreateTask(daemonSocketPath, {
        title: 'Blocker for link test',
        status: 'open',
        priority: 1,
      }, opentasksDir);
      const blocked = await daemonCreateTask(daemonSocketPath, {
        title: 'Blocked by link test',
        status: 'open',
        priority: 1,
      }, opentasksDir);

      await daemonCreateLink(daemonSocketPath, {
        fromId: blocker.id,
        toId: blocked.id,
        type: 'blocks',
      }, opentasksDir);

      const ready = await daemonGetReady(daemonSocketPath, 100, opentasksDir);
      const readyIds = ready.items.map((t: any) => t.id);
      expect(readyIds).not.toContain(blocked.id);
      expect(readyIds).toContain(blocker.id);
    });
  });

  // ==========================================================================
  // REST Routes — Delete, Links
  // ==========================================================================

  describe('REST Routes — Delete & Links', () => {
    it('DELETE /tasks/:nodeId should soft delete via daemon', async () => {
      // Create a task first
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Task to delete via REST' },
      });
      const { node_id } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${node_id}`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.deleted).toBe(true);
      expect(body.node_id).toBe(node_id);
      expect(body.hard).toBe(false);
    });

    it('DELETE /tasks/:nodeId?hard=true should hard delete via daemon', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Task to hard-delete via REST' },
      });
      const { node_id } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${node_id}?hard=true`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.deleted).toBe(true);
      expect(body.hard).toBe(true);
    });

    it('POST /tasks/:nodeId/links should create a link via REST', async () => {
      // Create two tasks
      const resA = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Link source via REST' },
      });
      const { node_id: nodeA } = JSON.parse(resA.body);

      const resB = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Link target via REST' },
      });
      const { node_id: nodeB } = JSON.parse(resB.body);

      const linkRes = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${nodeA}/links`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { targetId: nodeB, type: 'blocks' },
      });

      expect(linkRes.statusCode).toBe(201);
      const body = JSON.parse(linkRes.body);
      expect(body.from_id).toBe(nodeA);
      expect(body.to_id).toBe(nodeB);
      expect(body.type).toBe('blocks');
      expect(body.edge_id).toBeTruthy();
    });

    it('DELETE /tasks/:nodeId/links/:targetId should remove a link via REST', async () => {
      // Create two tasks and a link
      const resA = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Unlink source via REST' },
      });
      const { node_id: nodeA } = JSON.parse(resA.body);

      const resB = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Unlink target via REST' },
      });
      const { node_id: nodeB } = JSON.parse(resB.body);

      // Create link
      await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${nodeA}/links`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { targetId: nodeB, type: 'depends-on' },
      });

      // Remove link
      const removeRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${nodeA}/links/${nodeB}?type=depends-on`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(removeRes.statusCode).toBe(200);
      const body = JSON.parse(removeRes.body);
      expect(body.removed).toBe(true);
    });

    it('POST /tasks with assignee should pass through to daemon', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Assigned task via REST', assignee: 'agent_rest_worker' },
      });

      expect(res.statusCode).toBe(201);
    });

    it('PATCH /tasks/:nodeId with assignee should update via daemon', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Task to reassign via REST' },
      });
      const { node_id } = JSON.parse(createRes.body);

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${node_id}`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { assignee: 'new_agent' },
      });

      expect(updateRes.statusCode).toBe(200);
    });
  });
});
