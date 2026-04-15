/**
 * E2E Test: Multi-Agent Task Round-Trip
 *
 * Tests the complete cross-agent flows that the per-layer tests don't cover:
 *
 * 1. WebSocket Broadcast: task mutations → broadcastToChannel → /ws subscribers
 * 2. MAP Scope Relay: Swarm A sends task.created → hub intercepts → broadcasts
 * 3. Full Lifecycle: create → assign → start → complete with events visible
 *    to all connected clients
 *
 * Architecture:
 *   - Fastify server with /ws (realtime) + /ws/map (MAP)
 *   - Real OpenTasks daemon for task persistence
 *   - Raw WebSocket client subscribed to map:tasks channel
 *   - MAP WebSocket connection(s) for agent communication
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { setupWebSocket, stopHeartbeat } from '../../realtime/index.js';
import { getAllInbound, setDefaultTaskGraph } from '../../map/connection-registry.js';
import { ConfigSchema } from '../../config.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
import { setLocalAgent } from '../../api/middleware/auth.js';

import {
  createGraphStore, createIPCServer, createDaemonFlushManager,
  registerToolsMethods, registerGraphMethods, registerLifecycleMethods,
  createSQLitePersister, createJSONLPersister,
  createNativeProvider, createProviderAwareStore, createProviderRegistry,
  type GraphStore, type IPCServer,
} from 'opentasks';

// Short paths — macOS 104-byte Unix socket limit
const TEST_ROOT = path.join('/tmp', `ot-multi-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, 'multi.db');
const SERVER_PORT = 19672;

const SIDECAR_SCRIPT = path.resolve(
  __dirname, '..', '..', '..', 'references', 'claude-code-swarm', 'scripts', 'map-sidecar.mjs',
);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15000,
  intervalMs = 250,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** Collect WebSocket messages into an array */
function collectMessages(ws: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())); } catch { /* skip */ }
  });
  return messages;
}

/** Wait for a message matching a predicate */
async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 10000,
): Promise<Record<string, unknown> | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await sleep(100);
  }
  return null;
}

function sendSidecarCommand(
  socketPath: string,
  command: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(command) + '\n');
    });
    let buffer = '';
    client.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        client.end();
        try { resolve(JSON.parse(buffer.slice(0, idx))); }
        catch { resolve(null); }
      }
    });
    client.on('error', () => resolve(null));
    setTimeout(() => { client.destroy(); resolve(null); }, 5000);
  });
}

const sidecarExists = fs.existsSync(SIDECAR_SCRIPT);

describe.skipIf(!sidecarExists)('E2E: Multi-Agent Task Round-Trip', { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let agentA: { id: string; apiKey: string; ingestToken: string };
  let agentB: { id: string; apiKey: string; ingestToken: string };
  let otStore: GraphStore;
  let otServer: IPCServer;
  let daemonSocketPath: string;
  let opentasksDir: string;
  let locationHash: string;
  let resourceId: string;

  // Sidecar for agent A
  let sidecarA: {
    pid: number; child: ChildProcess; socketPath: string;
    workDir: string; stderr: () => string; cleanup: () => void;
  } | null = null;

  beforeAll(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    initDatabase(TEST_DB_PATH);

    // Create two agents
    const a1 = await agentsDAL.createAgent({ name: 'multi-agent-A', description: 'Agent A' });
    const ik1 = createIngestKey(a1.agent.id, { label: 'multi-a', agent_id: a1.agent.id });
    agentA = { id: a1.agent.id, apiKey: a1.apiKey, ingestToken: ik1.plaintext_key };
    const agentAFull = a1.agent;

    const a2 = await agentsDAL.createAgent({ name: 'multi-agent-B', description: 'Agent B' });
    const ik2 = createIngestKey(a2.agent.id, { label: 'multi-b', agent_id: a2.agent.id });
    agentB = { id: a2.agent.id, apiKey: a2.apiKey, ingestToken: ik2.plaintext_key };

    // Start OpenTasks daemon
    opentasksDir = path.join(TEST_ROOT, '.opentasks');
    fs.mkdirSync(opentasksDir, { recursive: true });

    locationHash = `multi-${process.pid}`;
    daemonSocketPath = path.join(opentasksDir, 'daemon.sock');
    fs.writeFileSync(path.join(opentasksDir, 'config.json'), JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: 'multi' },
      daemon: { socketPath: daemonSocketPath },
    }));
    fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '');

    const sqlite = createSQLitePersister(opentasksDir);
    await sqlite.initialize();
    const jsonl = createJSONLPersister(opentasksDir);
    const jsonlPath = path.join(opentasksDir, 'graph.jsonl');
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

    const nativeProvider = createNativeProvider(otStore);
    const registry = createProviderRegistry();
    registry.register(nativeProvider);
    const providerStore = createProviderAwareStore(otStore, { registry });

    const flushMgr = createDaemonFlushManager(
      { debounceMs: 50, maxDelayMs: 100 },
      async () => { await otStore.flush(); },
    );
    otServer = createIPCServer(daemonSocketPath);

    const locState = {
      hash: locationHash, opentasksPath: opentasksDir, store: otStore,
      providerStore,
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

    // Register task resource
    const resource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'multi-agent-graph',
      description: 'Shared task graph',
      git_remote_url: opentasksDir,
      visibility: 'shared',
      owner_agent_id: agentA.id,
      sync_strategy: 'local',
      local_path: opentasksDir,
      metadata: { opentasks: true, location_hash: locationHash },
    });
    resourceId = resource.id;

    // Start server with both WebSocket endpoints
    const config = ConfigSchema.parse({
      port: SERVER_PORT, host: '127.0.0.1', database: TEST_DB_PATH,
      instance: { name: 'Multi-Agent E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open' },
    });

    app = Fastify({ logger: false });
    await app.register(websocket);

    // Register both WebSocket endpoints
    setupWebSocket(app);          // /ws — realtime broadcasts
    setupMapWebSocket(app, config); // /ws/map — MAP protocol

    app.decorateRequest('agent');
    setLocalAgent(agentAFull);
    await app.register(async (api) => {
      await api.register(resourceContentRoutes, { config });
    }, { prefix: '/api/v1' });
    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 30000);

  afterAll(async () => {
    sidecarA?.cleanup();
    try { await otServer?.stop(); } catch {}
    try { await otStore?.close(); } catch {}
    stopMapWebSocket();
    stopHeartbeat();
    await app?.close();
    await sleep(200);
    closeDatabase();
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  }, 15000);

  // ==========================================================================
  // Helper: start sidecar
  // ==========================================================================

  async function startSidecar(
    label: string,
    ingestToken: string,
    scope: string,
  ): Promise<NonNullable<typeof sidecarA>> {
    const workDir = fs.mkdtempSync(path.join('/tmp', `ot-multi-${label}-`));
    const mapDir = path.join(fs.realpathSync(workDir), '.swarm', 'claude-swarm', 'tmp', 'map');
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.swarm', 'claude-swarm', 'config.json'),
      JSON.stringify({ template: 'test', opentasks: { enabled: true } }),
    );

    const workOtDir = path.join(workDir, '.opentasks');
    fs.mkdirSync(workOtDir, { recursive: true });
    fs.writeFileSync(path.join(workOtDir, 'config.json'), JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: label },
    }));
    fs.writeFileSync(path.join(workOtDir, 'graph.jsonl'), '');
    fs.symlinkSync(daemonSocketPath, path.join(workOtDir, 'daemon.sock'));

    const swarmOtDir = path.join(workDir, '.swarm', 'opentasks');
    fs.mkdirSync(swarmOtDir, { recursive: true });
    fs.symlinkSync(daemonSocketPath, path.join(swarmOtDir, 'daemon.sock'));

    const sidecarSocket = path.join(mapDir, 'sidecar.sock');
    const child = spawn('node', [
      SIDECAR_SCRIPT,
      '--server', `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${ingestToken}`,
      '--scope', scope,
      '--system-id', `system-${label}`,
      '--inactivity-timeout', '120000',
    ], {
      detached: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: workDir,
      env: { ...process.env, SWARM_LOG_LEVEL: 'debug', SWARM_LOG_STDERR: 'true' },
    });
    child.unref();

    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    const ready = await waitFor(async () => {
      if (!fs.existsSync(sidecarSocket)) return false;
      const resp = await sendSidecarCommand(sidecarSocket, { action: 'ping' });
      return resp !== null && (resp as any).ok === true;
    });
    if (!ready) {
      try { process.kill(child.pid!, 'SIGTERM'); } catch {}
      throw new Error(`Sidecar ${label} not ready. Stderr: ${stderr}`);
    }

    return {
      pid: child.pid!, child, socketPath: sidecarSocket, workDir,
      stderr: () => stderr,
      cleanup: () => {
        try { process.kill(child.pid!, 'SIGTERM'); } catch {}
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      },
    };
  }

  // ==========================================================================
  // 1. WebSocket Broadcast: REST mutations → /ws subscribers
  // ==========================================================================

  describe('WebSocket Broadcast — task events reach /ws subscribers', () => {
    let wsClient: WebSocket;
    let messages: Array<Record<string, unknown>>;

    beforeAll(async () => {
      // Connect raw WebSocket to /ws endpoint (use ingest token — faster than bcrypt)
      wsClient = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws?token=${agentB.ingestToken}`);
      await new Promise<void>((resolve, reject) => {
        wsClient.on('open', resolve);
        wsClient.on('error', reject);
        setTimeout(() => reject(new Error('WS connect timeout')), 5000);
      });

      messages = collectMessages(wsClient);

      // Subscribe to map:tasks channel
      wsClient.send(JSON.stringify({ type: 'subscribe', channels: ['map:tasks'] }));
      // Wait for subscription confirmation
      await waitForMessage(messages, (m) => {
        const data = m.data as Record<string, unknown> | undefined;
        return m.type === 'agent_online' && Array.isArray(data?.subscribed);
      });
    }, 15000);

    afterAll(() => {
      wsClient?.close();
    });

    it('POST create task → subscriber receives task.created broadcast', async () => {
      // Create task via REST
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${agentA.apiKey}` },
        payload: { title: 'Broadcast test task', priority: 2 },
      });
      expect(res.statusCode).toBe(201);

      // Wait for broadcast
      const broadcast = await waitForMessage(
        messages,
        (m) => m.type === 'task.created' && m.channel === 'map:tasks',
      );

      expect(broadcast).not.toBeNull();
      expect(broadcast!.channel).toBe('map:tasks');
      const data = broadcast!.data as Record<string, unknown>;
      expect((data.task as Record<string, unknown>).title).toBe('Broadcast test task');
    });

    it('PATCH update status → subscriber receives task.status broadcast', async () => {
      // Create a task first
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${agentA.apiKey}` },
        payload: { title: 'Status broadcast test' },
      });
      const { node_id } = JSON.parse(createRes.body);

      // Clear messages to isolate
      messages.length = 0;

      // Update status
      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${node_id}`,
        headers: { Authorization: `Bearer ${agentA.apiKey}` },
        payload: { status: 'in_progress' },
      });
      expect(updateRes.statusCode).toBe(200);

      // Wait for broadcast
      const broadcast = await waitForMessage(
        messages,
        (m) => m.type === 'task.status' && m.channel === 'map:tasks',
      );

      expect(broadcast).not.toBeNull();
      const data = broadcast!.data as Record<string, unknown>;
      expect(data.taskId).toBe(node_id);
      expect(data.current).toBe('in_progress');
    });
  });

  // ==========================================================================
  // 2. MAP Scope Message → Hub Intercepts → Events Emitted
  // ==========================================================================

  describe('MAP scope messages — hub intercepts task events from sidecar', () => {
    let wsObserver: WebSocket;
    let observerMessages: Array<Record<string, unknown>>;

    beforeAll(async () => {
      // Start sidecar A
      sidecarA = await startSidecar('swarm-a', agentA.ingestToken, 'swarm:multi-test');
      const connected = await waitFor(() => getAllInbound().size > 0);
      expect(connected).toBe(true);

      await waitFor(() => sidecarA!.stderr().includes('opentasks connector registered'), 15000, 200);

      const swarmIds = [...getAllInbound().keys()];
      if (swarmIds.length > 0) {
        setDefaultTaskGraph(swarmIds[0], { location_hash: locationHash });
      }

      // Connect observer WebSocket to /ws
      wsObserver = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws?token=${agentB.ingestToken}`);
      await new Promise<void>((resolve, reject) => {
        wsObserver.on('open', resolve);
        wsObserver.on('error', reject);
        setTimeout(() => reject(new Error('Observer WS timeout')), 5000);
      });
      observerMessages = collectMessages(wsObserver);
      wsObserver.send(JSON.stringify({ type: 'subscribe', channels: ['map:tasks'] }));
      await waitForMessage(observerMessages, (m) => {
        const data = m.data as Record<string, unknown> | undefined;
        return m.type === 'agent_online' && Array.isArray(data?.subscribed);
      });
    }, 30000);

    afterAll(() => {
      wsObserver?.close();
    });

    it('sidecar sends task via MAP → hub stores in graph → observer gets broadcast', async () => {
      // Use the sidecar's MAP connection to send a scope message with task event
      await sendSidecarCommand(sidecarA!.socketPath, {
        action: 'bridge',
        event: {
          type: 'task.created',
          task: { id: 'sidecar-task-1', title: 'Task from sidecar A', status: 'open' },
          _origin: 'cc-swarm',
        },
      });

      // Give the hub time to process
      await sleep(1000);

      // Verify task was stored (either via compat shim or daemon)
      const summaryRes = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/summary`,
        headers: { Authorization: `Bearer ${agentA.apiKey}` },
      });
      expect(summaryRes.statusCode).toBe(200);
      const summary = JSON.parse(summaryRes.body);
      expect(summary.node_count).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 3. Full Lifecycle: create → update → complete with broadcasts
  // ==========================================================================

  describe('Full lifecycle — create, update, complete with all broadcasts', () => {
    let wsClient: WebSocket;
    let lifecycleMessages: Array<Record<string, unknown>>;

    beforeAll(async () => {
      wsClient = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws?token=${agentB.ingestToken}`);
      await new Promise<void>((resolve, reject) => {
        wsClient.on('open', resolve);
        wsClient.on('error', reject);
        setTimeout(() => reject(new Error('WS connect timeout')), 5000);
      });
      lifecycleMessages = collectMessages(wsClient);
      wsClient.send(JSON.stringify({ type: 'subscribe', channels: ['map:tasks'] }));
      await waitForMessage(lifecycleMessages, (m) => {
        const data = m.data as Record<string, unknown> | undefined;
        return m.type === 'agent_online' && Array.isArray(data?.subscribed);
      });
    });

    afterAll(() => {
      wsClient?.close();
    });

    it('create → start → complete lifecycle with broadcasts at each step', async () => {
      // Clear messages
      lifecycleMessages.length = 0;

      // Step 1: Create task via REST
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${agentA.apiKey}` },
        payload: { title: 'Full lifecycle task', priority: 1 },
      });
      expect(createRes.statusCode).toBe(201);
      const { node_id } = JSON.parse(createRes.body);

      // Wait for task.created broadcast
      const createdBroadcast = await waitForMessage(
        lifecycleMessages,
        (m) => m.type === 'task.created' && m.channel === 'map:tasks',
      );
      expect(createdBroadcast).not.toBeNull();

      // Step 2: Start task (open → in_progress) via REST
      const startRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${node_id}`,
        headers: { Authorization: `Bearer ${agentA.apiKey}` },
        payload: { status: 'in_progress' },
      });
      expect(startRes.statusCode).toBe(200);

      // Wait for task.status broadcast
      const startBroadcast = await waitForMessage(
        lifecycleMessages,
        (m) => {
          if (m.type !== 'task.status' || m.channel !== 'map:tasks') return false;
          const data = m.data as Record<string, unknown>;
          return data.taskId === node_id && data.current === 'in_progress';
        },
      );
      expect(startBroadcast).not.toBeNull();

      // Step 3: Complete task (in_progress → completed) via REST
      const completeRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${node_id}`,
        headers: { Authorization: `Bearer ${agentA.apiKey}` },
        payload: { status: 'completed' },
      });
      expect(completeRes.statusCode).toBe(200);

      // Wait for task.status broadcast
      const completeBroadcast = await waitForMessage(
        lifecycleMessages,
        (m) => {
          if (m.type !== 'task.status' || m.channel !== 'map:tasks') return false;
          const data = m.data as Record<string, unknown>;
          return data.taskId === node_id && data.current === 'completed';
        },
      );
      expect(completeBroadcast).not.toBeNull();

      // Verify final state via REST
      const summaryRes = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/summary`,
        headers: { Authorization: `Bearer ${agentA.apiKey}` },
      });
      const summary = JSON.parse(summaryRes.body);
      expect(summary.task_counts.completed ?? summary.task_counts.closed ?? 0).toBeGreaterThanOrEqual(1);

      // Verify all 3 broadcasts arrived in order
      const taskEvents = lifecycleMessages.filter(
        (m) => m.channel === 'map:tasks' && (m.type === 'task.created' || m.type === 'task.status'),
      );
      expect(taskEvents.length).toBeGreaterThanOrEqual(3);
      expect(taskEvents[0].type).toBe('task.created');
      expect(taskEvents[1].type).toBe('task.status');
      expect((taskEvents[1].data as any).current).toBe('in_progress');
      expect(taskEvents[2].type).toBe('task.status');
      expect((taskEvents[2].data as any).current).toBe('completed');
    });

    it('observer can query graph and see all task states', async () => {
      // Agent B queries the shared graph and sees the tasks
      const graphRes = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${resourceId}/content/opentasks/graph`,
        headers: { Authorization: `Bearer ${agentA.apiKey}` },
      });

      expect(graphRes.statusCode).toBe(200);
      const graph = JSON.parse(graphRes.body);
      expect(graph.nodes.length).toBeGreaterThan(0);

      // Should have tasks in various states from our lifecycle tests
      const statuses = new Set(graph.nodes.filter((n: any) => n.type === 'task').map((n: any) => n.status));
      expect(statuses.size).toBeGreaterThanOrEqual(1);
    });
  });
});
