/**
 * OpenTasks E2E Integration Tests
 *
 * Tests the full OpenHive ↔ OpenTasks integration using a REAL OpenTasks
 * daemon (no mocks). Spins up an actual IPC server with a graph store,
 * populates it with nodes and edges, then exercises:
 *
 * 1. OpenHive's OpenHiveOpenTasksClient against the real daemon
 * 2. All 4 content API endpoints with a Fastify app hitting the real daemon
 * 3. Resource discovery of the .opentasks directory
 * 4. JSONL fallback behavior when daemon is stopped
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import * as fs from "fs";
import * as path from "path";

// OpenTasks (real npm package)
import {
  createGraphStore,
  createIPCServer,
  createDaemonFlushManager,
  registerToolsMethods,
  createSQLitePersister,
  createJSONLPersister,
  createClient,
  type GraphStore,
  type IPCServer,
  type OpenTasksClient,
  type DaemonFlushManager,
  type FileWatcher,
  type Node,
  type Edge,
  type StoredNode,
  type StoredEdge,
} from 'opentasks';

// LocationResolver/LocationState are internal to opentasks (not re-exported from main index)
interface LocationState {
  hash: string;
  opentasksPath: string;
  store: GraphStore;
  flushManager: DaemonFlushManager;
  watcher: FileWatcher;
  primary: boolean;
  healthy: boolean;
}

interface LocationResolver {
  resolve(locationHash?: string): LocationState;
  getDefault(): LocationState;
  list(): Array<{ hash: string; opentasksPath: string; primary: boolean; healthy: boolean }>;
  has(hash: string): boolean;
  add(state: LocationState): void;
  remove(hash: string): Promise<void>;
}

// OpenHive
import { OpenHiveOpenTasksClient } from "../../opentasks-client/client.js";
import { initDatabase, closeDatabase } from "../../db/index.js";
import * as agentsDAL from "../../db/dal/agents.js";
import * as resourcesDAL from "../../db/dal/syncable-resources.js";
import { resourceContentRoutes } from "../../api/routes/resource-content.js";
import { discoverLocalResources } from "../../discovery/index.js";
import { ConfigSchema } from "../../config.js";
import {
  testRoot,
  testDbPath,
  cleanTestRoot,
  mkTestDir,
} from "../helpers/test-dirs.js";

// ============================================================================
// Test Infrastructure
// ============================================================================

const TEST_ROOT = testRoot("ot-e2e");
const TEST_DB_PATH = testDbPath(TEST_ROOT, "ot-e2e.db");

interface E2EContext {
  openTasksDir: string;
  socketPath: string;
  store: GraphStore;
  server: IPCServer;
  otClient: OpenTasksClient;
  nodes: Node[];
  edges: Edge[];
  stop: () => Promise<void>;
}

/**
 * Set up a real OpenTasks daemon with populated data.
 * This mirrors the pattern from opentasks/tests/e2e/helpers/system-setup.ts
 * but is minimal — just IPC server, graph store, and tool handlers.
 */
async function setupOpenTasks(name: string): Promise<E2EContext> {
  const rootDir = mkTestDir(TEST_ROOT, name);
  const openTasksDir = path.join(rootDir, ".opentasks");
  fs.mkdirSync(openTasksDir, { recursive: true });

  const socketPath = path.join(openTasksDir, "daemon.sock");
  const jsonlPath = path.join(openTasksDir, "graph.jsonl");

  // Create SQLite storage (pass base directory — it appends /cache.db)
  const sqlite = createSQLitePersister(openTasksDir);
  await sqlite.initialize();

  // Create JSONL persister (pass base directory — it appends /graph.jsonl)
  const jsonl = createJSONLPersister(openTasksDir);

  // JSONL load/save functions
  const jsonlLoad = async () => {
    try {
      if (!fs.existsSync(jsonlPath)) return { nodes: [], edges: [] };
      return await jsonl.load();
    } catch {
      return { nodes: [], edges: [] };
    }
  };
  const jsonlSave = async (nodes: StoredNode[], edges: StoredEdge[]) => {
    await jsonl.save(nodes, edges);
  };

  // Create graph store with fast debounce for tests
  const store = createGraphStore(
    { basePath: openTasksDir, flush: { debounceMs: 50, maxDelayMs: 100 } },
    sqlite,
    jsonlLoad,
    jsonlSave,
  );
  await store.initialize();

  // Create flush manager
  const flushManager = createDaemonFlushManager(
    { debounceMs: 50, maxDelayMs: 100 },
    async () => {
      await store.flush();
    },
  );

  // Create IPC server
  const server = createIPCServer(socketPath);

  // Create minimal location resolver
  const locationState: LocationState = {
    hash: "e2e-test",
    opentasksPath: openTasksDir,
    store,
    flushManager,
    watcher: null as unknown as FileWatcher,
    primary: true,
    healthy: true,
  };
  const locationResolver: LocationResolver = {
    resolve() {
      return locationState;
    },
    getDefault() {
      return locationState;
    },
    list() {
      return [
        {
          hash: "e2e-test",
          opentasksPath: openTasksDir,
          primary: true,
          healthy: true,
        },
      ];
    },
    has(hash: string) {
      return hash === "e2e-test";
    },
    add() {},
    async remove() {},
  };

  // Register tool handlers (link, query, annotate, task)
  registerToolsMethods({ server, locationResolver });

  // Start IPC server
  await server.start();

  // Create and connect official OpenTasks client
  const otClient = createClient({ socketPath });
  await otClient.connect();

  // ---- Populate graph with test data ----

  // Context nodes
  const ctx1 = await store.createNode({
    type: "context",
    title: "Authentication System Spec",
    content: "Design and implement OAuth2 + JWT auth flow.",
    priority: 0,
    tags: ["auth", "security"],
  });

  const ctx2 = await store.createNode({
    type: "context",
    title: "Database Schema Design",
    content: "PostgreSQL schema for users, sessions, tokens.",
    priority: 1,
  });

  // Task nodes with various statuses
  const taskOpen1 = await store.createNode({
    type: "task",
    title: "Implement JWT token generation",
    content: "Create token service with RS256 signing.",
    status: "open",
    priority: 0,
    tags: ["auth", "backend"],
  });

  const taskOpen2 = await store.createNode({
    type: "task",
    title: "Add refresh token rotation",
    content: "Implement sliding window refresh tokens.",
    status: "open",
    priority: 1,
  });

  const taskOpen3 = await store.createNode({
    type: "task",
    title: "Write auth middleware",
    content: "Express middleware for JWT validation.",
    status: "open",
    priority: 2,
  });

  const taskInProgress = await store.createNode({
    type: "task",
    title: "Design user schema",
    content: "Create users table with proper indices.",
    status: "in_progress",
    priority: 1,
  });

  const taskBlocked = await store.createNode({
    type: "task",
    title: "Implement login endpoint",
    content: "POST /auth/login with rate limiting.",
    status: "open",
    priority: 0,
  });

  const taskClosed1 = await store.createNode({
    type: "task",
    title: "Set up project structure",
    content: "Initialize monorepo with workspaces.",
    status: "closed",
    priority: 0,
  });

  const taskClosed2 = await store.createNode({
    type: "task",
    title: "Configure TypeScript",
    content: "tsconfig.json with strict mode.",
    status: "closed",
    priority: 1,
  });

  // Feedback (requires target_id and feedback_type)
  const feedback1 = await store.createNode({
    type: "feedback",
    title: "Consider using Ed25519 instead of RS256",
    content: "Ed25519 is faster and has simpler key management.",
    target_id: taskOpen1.id,
    feedback_type: "suggestion",
  });

  // Edges
  const edges: Edge[] = [];

  // taskOpen1 implements ctx1
  edges.push(
    await store.createEdge({
      from_id: taskOpen1.id,
      to_id: ctx1.id,
      type: "implements",
    }),
  );

  // taskOpen3 is blocked by taskOpen1 (active blocker → taskOpen3 is NOT ready)
  edges.push(
    await store.createEdge({
      from_id: taskOpen1.id,
      to_id: taskOpen3.id,
      type: "blocks",
    }),
  );

  // taskOpen2 is blocked by taskClosed1 (closed blocker → taskOpen2 IS ready)
  edges.push(
    await store.createEdge({
      from_id: taskClosed1.id,
      to_id: taskOpen2.id,
      type: "blocks",
    }),
  );

  // taskBlocked is blocked by taskInProgress (active blocker → NOT ready)
  edges.push(
    await store.createEdge({
      from_id: taskInProgress.id,
      to_id: taskBlocked.id,
      type: "blocks",
    }),
  );

  // feedback references task
  edges.push(
    await store.createEdge({
      from_id: feedback1.id,
      to_id: taskOpen1.id,
      type: "references",
    }),
  );

  // ctx2 references ctx1
  edges.push(
    await store.createEdge({
      from_id: ctx2.id,
      to_id: ctx1.id,
      type: "references",
    }),
  );

  const nodes = [
    ctx1,
    ctx2,
    taskOpen1,
    taskOpen2,
    taskOpen3,
    taskInProgress,
    taskBlocked,
    taskClosed1,
    taskClosed2,
    feedback1,
  ];

  // Flush everything to JSONL
  await store.flush();

  return {
    openTasksDir,
    socketPath,
    store,
    server,
    otClient,
    nodes,
    edges,
    async stop() {
      otClient.disconnect();
      await server.stop();
      await store.close();
      sqlite.close();
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("OpenTasks E2E Integration", () => {
  let ctx: E2EContext;

  // Fastify app for content API tests
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };
  let opentasksResource: { id: string };

  beforeAll(async () => {
    // 1. Set up real OpenTasks daemon
    ctx = await setupOpenTasks("d");

    // 2. Set up OpenHive database and Fastify app
    initDatabase(TEST_DB_PATH);

    const config = ConfigSchema.parse({
      database: TEST_DB_PATH,
      instance: { name: "E2E Test", description: "E2E test instance" },
      admin: { createOnStartup: false },
      auth: { mode: "local" },
      rateLimit: { enabled: false },
    });

    app = Fastify({ logger: false });
    app.decorateRequest("agent", null);
    await app.register(
      async (api) => {
        await api.register(resourceContentRoutes, { config });
      },
      { prefix: "/api/v1" },
    );

    // 3. Create agent and resource
    const { agent, apiKey } = await agentsDAL.createAgent({
      name: "e2e-test-agent",
      description: "Agent for e2e testing",
    });
    testAgent = { id: agent.id, apiKey };

    opentasksResource = resourcesDAL.createResource({
      resource_type: "task",
      name: "E2E OpenTasks",
      description: "Real OpenTasks store",
      git_remote_url: ctx.openTasksDir,
      visibility: "private",
      owner_agent_id: testAgent.id,
      metadata: { opentasks: true },
    });
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await ctx?.stop();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  }, 15000);

  // ==========================================================================
  // Part 1: OpenHive client ↔ Real daemon
  // ==========================================================================

  describe("OpenHiveOpenTasksClient against real daemon", () => {
    let ohClient: OpenHiveOpenTasksClient;

    afterAll(() => {
      ohClient?.disconnect();
    });

    it("should connect to the real daemon", async () => {
      // Verify the official client is still connected
      expect(ctx.otClient.connected).toBe(true);

      ohClient = new OpenHiveOpenTasksClient(ctx.openTasksDir);
      const result = await ohClient.connectDaemon();
      expect(result).toBe(true);
      expect(ohClient.connected).toBe(true);
    });

    it("should report daemon running", async () => {
      // Create a separate client to test isDaemonRunning (it creates its own probe)
      const probeClient = new OpenHiveOpenTasksClient(ctx.openTasksDir);
      const running = await probeClient.isDaemonRunning();
      expect(running).toBe(true);
    });

    it("should get graph summary from JSONL", async () => {
      const summary = await ohClient.getGraphSummary();

      // 10 nodes total: 2 context + 5 open tasks + 1 in_progress + 2 closed + 1 feedback
      expect(summary.node_count).toBe(10);
      // 6 edges created above
      expect(summary.edge_count).toBe(6);
      expect(summary.context_count).toBe(2);
      expect(summary.feedback_count).toBe(1);

      // Task status breakdown
      expect(summary.task_counts.open).toBe(4); // taskOpen1, taskOpen2, taskOpen3, taskBlocked
      expect(summary.task_counts.in_progress).toBe(1);
      expect(summary.task_counts.blocked).toBe(0); // taskBlocked has status 'open' with blocking edge, not 'blocked' status
      expect(summary.task_counts.closed).toBe(2);
    });

    it("should compute correct ready count", async () => {
      const summary = await ohClient.getGraphSummary();

      // Ready = open + no active blockers:
      // taskOpen1: open, no blockers → READY
      // taskOpen2: open, blocked by taskClosed1 (closed) → READY
      // taskOpen3: open, blocked by taskOpen1 (open) → NOT ready
      // taskBlocked: open, blocked by taskInProgress (in_progress) → NOT ready
      expect(summary.ready_count).toBe(2);
    });

    it("should get ready tasks via daemon (with fallback)", async () => {
      const ready = await ohClient.getReady();

      expect(ready.length).toBe(2);

      // Should be sorted by priority (taskOpen1 has P0, taskOpen2 has P1)
      expect(ready[0].priority).toBeLessThanOrEqual(ready[1].priority ?? 999);

      // Verify the correct tasks are returned
      const titles = ready.map((t) => t.title);
      expect(titles).toContain("Implement JWT token generation");
      expect(titles).toContain("Add refresh token rotation");

      // Should NOT contain blocked or non-open tasks
      expect(titles).not.toContain("Write auth middleware"); // blocked by taskOpen1
      expect(titles).not.toContain("Implement login endpoint"); // blocked by taskInProgress
      expect(titles).not.toContain("Design user schema"); // in_progress
      expect(titles).not.toContain("Set up project structure"); // closed
    });

    it("should query nodes via daemon", async () => {
      const result = await ohClient.queryNodes({
        type: "task",
        status: "open",
      });

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThanOrEqual(3);
    });

    it("should cross-validate with official OpenTasks client", async () => {
      // Query ready tasks from both clients
      const ohReady = await ohClient.getReady();
      const otReady = await ctx.otClient.query({ ready: {} });

      // Both should identify the same ready tasks
      const ohIds = ohReady.map((t) => t.id).sort();
      const otIds = otReady.items.map((t: { id: string }) => t.id).sort();

      expect(ohIds.length).toBe(otIds.length);
      expect(ohIds).toEqual(otIds);
    });
  });

  // ==========================================================================
  // Part 2: Content API endpoints ↔ Real daemon
  // ==========================================================================

  describe("Content API endpoints with real daemon", () => {
    it("GET /opentasks/summary — correct graph summary", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/summary`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.node_count).toBe(10);
      expect(body.edge_count).toBe(6);
      expect(body.context_count).toBe(2);
      expect(body.feedback_count).toBe(1);
      expect(body.ready_count).toBe(2);
      expect(body.task_counts.open).toBe(4);
      expect(body.task_counts.in_progress).toBe(1);
      expect(body.task_counts.closed).toBe(2);
      // daemon_connected can be true or false depending on timing
      expect(typeof body.daemon_connected).toBe("boolean");
    });

    it("GET /opentasks/ready — correct ready tasks", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/ready`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.items.length).toBe(2);
      expect(body.total).toBe(2);

      const titles = body.items.map((t: { title: string }) => t.title);
      expect(titles).toContain("Implement JWT token generation");
      expect(titles).toContain("Add refresh token rotation");
    });

    it("GET /opentasks/ready — respects limit", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/ready?limit=1`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items.length).toBeLessThanOrEqual(1);
    });

    it("GET /opentasks/tasks — returns data", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Without a running daemon connection from the route handler's perspective,
      // it falls back to task_counts
      if (body.daemon_connected) {
        expect(body.items).toBeInstanceOf(Array);
      } else {
        expect(body.task_counts).toBeDefined();
        expect(body.task_counts.open).toBe(4);
      }
    });

    it("GET /opentasks/status — reports graph file exists", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/status`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.graph_file_exists).toBe(true);
      expect(body.graph_last_modified).toBeTruthy();
      expect(new Date(body.graph_last_modified).getTime()).not.toBeNaN();
      expect(body.socket_path).toContain("daemon.sock");
    });
  });

  // ==========================================================================
  // Part 3: Discovery of real .opentasks directory
  // ==========================================================================

  describe("Discovery of real OpenTasks store", () => {
    it("should discover the .opentasks directory with accurate metadata", async () => {
      // The parent of ctx.openTasksDir contains .opentasks/
      const projectDir = path.dirname(ctx.openTasksDir);

      const config = ConfigSchema.parse({
        resourceDiscovery: {
          globalEnabled: false,
          projectRoot: projectDir,
          openTasksEnabled: true,
        },
      });

      const { agent } = await agentsDAL.createAgent({
        name: "discovery-e2e-agent",
        description: "Discovery e2e agent",
      });

      const result = await discoverLocalResources(config, {
        ownerAgentId: agent.id,
        scopes: ["project"],
      });

      const taskResource = [...result.created, ...result.updated].find(
        (r) => r.resource_type === "task",
      );

      expect(taskResource).toBeDefined();
      expect(taskResource!.scope).toBe("project");
    });
  });

  // ==========================================================================
  // Part 4: JSONL fallback after daemon shutdown
  // ==========================================================================

  describe("JSONL fallback after daemon stops", () => {
    let postShutdownClient: OpenHiveOpenTasksClient;

    beforeAll(async () => {
      // Stop the daemon (data is already flushed to JSONL)
      await ctx.stop();

      // Create a new OpenHive client pointed at the same directory
      postShutdownClient = new OpenHiveOpenTasksClient(ctx.openTasksDir);
    });

    it("should report daemon not running", async () => {
      const running = await postShutdownClient.isDaemonRunning();
      expect(running).toBe(false);
    });

    it("should fail to connect", async () => {
      const connected = await postShutdownClient.connectDaemon();
      expect(connected).toBe(false);
      expect(postShutdownClient.connected).toBe(false);
    });

    it("should still get graph summary from JSONL", async () => {
      const summary = await postShutdownClient.getGraphSummary();

      expect(summary.node_count).toBe(10);
      expect(summary.edge_count).toBe(6);
      expect(summary.context_count).toBe(2);
      expect(summary.feedback_count).toBe(1);
      expect(summary.task_counts.open).toBe(4); // taskOpen1, taskOpen2, taskOpen3, taskBlocked
      expect(summary.task_counts.in_progress).toBe(1);
      expect(summary.task_counts.closed).toBe(2);
      expect(summary.ready_count).toBe(2);
    });

    it("should still get ready tasks from JSONL", async () => {
      const ready = await postShutdownClient.getReady();

      expect(ready.length).toBe(2);

      const titles = ready.map((t) => t.title);
      expect(titles).toContain("Implement JWT token generation");
      expect(titles).toContain("Add refresh token rotation");
    });

    it("should return null for queryNodes without daemon", async () => {
      const result = await postShutdownClient.queryNodes({ type: "task" });
      expect(result).toBeNull();
    });

    it("content API /summary should work via JSONL fallback", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/summary`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.daemon_connected).toBe(false);
      expect(body.node_count).toBe(10);
      expect(body.ready_count).toBe(2);
    });

    it("content API /ready should work via JSONL fallback", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/ready`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.daemon_connected).toBe(false);
      expect(body.items.length).toBe(2);
    });

    it("content API /tasks should return fallback with daemon offline", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.daemon_connected).toBe(false);
      expect(body.task_counts).toBeDefined();
      expect(body.task_counts.open).toBe(4);
    });

    it("content API /status should report daemon offline", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/${opentasksResource.id}/content/opentasks/status`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.daemon_running).toBe(false);
      expect(body.graph_file_exists).toBe(true);
    });
  });
});
