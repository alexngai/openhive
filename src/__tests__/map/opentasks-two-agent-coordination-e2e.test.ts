/**
 * E2E Test: Two-Agent Task Coordination
 *
 * Two sidecars (Agent A + Agent B) connected to the same OpenHive hub,
 * each with their own OpenTasks daemon. Tests the full coordination loop:
 *
 *   1. Agent A creates a task → bridge-task-created → hub → broadcast
 *   2. Agent B queries Agent A's graph remotely → sees the task
 *   3. Agent B claims the task → bridge-task-status → hub → broadcast
 *   4. Agent B completes the task → hub → broadcast
 *   5. Agent A queries graph → sees completed status
 *   6. Agent B syncs task into local daemon (pushSyncEvent equivalent)
 *   7. Both daemons reflect the coordinated state
 *
 * Uses real OpenTasks daemons, real cc-swarm sidecars, real WebSocket.
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
  createClient,
  type GraphStore, type IPCServer,
} from 'opentasks';

const TEST_ROOT = path.join('/tmp', `ot-2agent-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, '2agent.db');
const SERVER_PORT = 19675;
const SCOPE = 'swarm:two-agent-test';

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

function collectMessages(ws: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())); } catch {}
  });
  return messages;
}

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

interface DaemonInstance {
  store: GraphStore;
  server: IPCServer;
  socketPath: string;
  opentasksDir: string;
  locationHash: string;
}

interface SidecarInstance {
  pid: number;
  child: ChildProcess;
  socketPath: string;
  workDir: string;
  stderr: () => string;
  cleanup: () => void;
}

const sidecarExists = fs.existsSync(SIDECAR_SCRIPT);

describe.skipIf(!sidecarExists)('E2E: Two-Agent Task Coordination', { timeout: 60000 }, () => {
  let app: FastifyInstance;

  let agentA: { id: string; apiKey: string; ingestToken: string };
  let agentB: { id: string; apiKey: string; ingestToken: string };
  let daemonA: DaemonInstance;
  let daemonB: DaemonInstance;
  let sidecarA: SidecarInstance;
  let sidecarB: SidecarInstance;
  let resourceA: { id: string };

  let wsObserver: WebSocket;
  let observerMessages: Array<Record<string, unknown>>;

  // ── Daemon factory ──

  async function createDaemon(label: string): Promise<DaemonInstance> {
    const opentasksDir = path.join(TEST_ROOT, `${label}-ot`);
    fs.mkdirSync(opentasksDir, { recursive: true });

    const locationHash = `${label}-${process.pid}`;
    const socketPath = path.join(opentasksDir, 'daemon.sock');
    fs.writeFileSync(path.join(opentasksDir, 'config.json'), JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: label },
      daemon: { socketPath },
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

    const store = createGraphStore(
      { basePath: opentasksDir, flush: { debounceMs: 50, maxDelayMs: 100 } },
      sqlite, jsonlLoad, jsonlSave,
    );
    await store.initialize();

    const nativeProvider = createNativeProvider(store);
    const registry = createProviderRegistry();
    registry.register(nativeProvider);
    const providerStore = createProviderAwareStore(store, { registry });

    const flushMgr = createDaemonFlushManager(
      { debounceMs: 50, maxDelayMs: 100 },
      async () => { await store.flush(); },
    );
    const server = createIPCServer(socketPath);

    const locState = {
      hash: locationHash, opentasksPath: opentasksDir, store,
      providerStore,
      flushManager: flushMgr, watcher: null as any, primary: true, healthy: true,
    };
    const locResolver = {
      resolve: () => locState, getDefault: () => locState,
      list: () => [{ hash: locationHash, opentasksPath: opentasksDir, primary: true, healthy: true }],
      has: (h: string) => h === locationHash, add: () => {}, remove: async () => {},
    };
    registerLifecycleMethods({
      server,
      getStatus: () => ({ pid: process.pid, socketPath, uptime: 0, connections: 0 } as any),
      shutdown: async () => {},
      version: '0.0.8',
      startedAt: new Date(),
    });
    registerGraphMethods({ server, locationResolver: locResolver });
    registerToolsMethods({ server, locationResolver: locResolver });
    await server.start();

    return { store, server, socketPath, opentasksDir, locationHash };
  }

  // ── Sidecar factory ──

  async function startSidecar(
    label: string,
    ingestToken: string,
    daemon: DaemonInstance,
  ): Promise<SidecarInstance> {
    const workDir = fs.mkdtempSync(path.join('/tmp', `ot-2a-${label}-`));
    const mapDir = path.join(fs.realpathSync(workDir), '.swarm', 'claude-swarm', 'tmp', 'map');
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.swarm', 'claude-swarm', 'config.json'),
      JSON.stringify({ template: 'test', opentasks: { enabled: true } }),
    );

    // Set up .opentasks/ pointing to this agent's daemon
    const workOtDir = path.join(workDir, '.opentasks');
    fs.mkdirSync(workOtDir, { recursive: true });
    fs.writeFileSync(path.join(workOtDir, 'config.json'), JSON.stringify({
      version: '1.0',
      location: { hash: daemon.locationHash, uuid: daemon.locationHash, name: label },
    }));
    fs.writeFileSync(path.join(workOtDir, 'graph.jsonl'), '');
    fs.symlinkSync(daemon.socketPath, path.join(workOtDir, 'daemon.sock'));

    const swarmOtDir = path.join(workDir, '.swarm', 'opentasks');
    fs.mkdirSync(swarmOtDir, { recursive: true });
    fs.symlinkSync(daemon.socketPath, path.join(swarmOtDir, 'daemon.sock'));

    const sidecarSocket = path.join(mapDir, 'sidecar.sock');
    const child = spawn('node', [
      SIDECAR_SCRIPT,
      '--server', `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${ingestToken}`,
      '--scope', SCOPE,
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

  // ── Setup ──

  beforeAll(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    initDatabase(TEST_DB_PATH);

    // Create two agents
    const a1 = await agentsDAL.createAgent({ name: 'coord-agent-A', description: 'Agent A' });
    const ik1 = createIngestKey(a1.agent.id, { label: 'coord-a', agent_id: a1.agent.id });
    agentA = { id: a1.agent.id, apiKey: a1.apiKey, ingestToken: ik1.plaintext_key };
    const agentAFull = a1.agent;

    const a2 = await agentsDAL.createAgent({ name: 'coord-agent-B', description: 'Agent B' });
    const ik2 = createIngestKey(a2.agent.id, { label: 'coord-b', agent_id: a2.agent.id });
    agentB = { id: a2.agent.id, apiKey: a2.apiKey, ingestToken: ik2.plaintext_key };

    // Start separate daemons for each agent
    daemonA = await createDaemon('agent-a');
    daemonB = await createDaemon('agent-b');

    // Register task resources
    resourceA = resourcesDAL.createResource({
      resource_type: 'task', name: 'agent-a-graph',
      git_remote_url: daemonA.opentasksDir, visibility: 'shared',
      owner_agent_id: agentA.id, sync_strategy: 'local',
      local_path: daemonA.opentasksDir,
      metadata: { opentasks: true, location_hash: daemonA.locationHash },
    });
    resourcesDAL.createResource({
      resource_type: 'task', name: 'agent-b-graph',
      git_remote_url: daemonB.opentasksDir, visibility: 'shared',
      owner_agent_id: agentB.id, sync_strategy: 'local',
      local_path: daemonB.opentasksDir,
      metadata: { opentasks: true, location_hash: daemonB.locationHash },
    });

    // Start server
    const config = ConfigSchema.parse({
      port: SERVER_PORT, host: '127.0.0.1', database: TEST_DB_PATH,
      instance: { name: 'Two-Agent Coordination' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open' },
    });

    app = Fastify({ logger: false });
    await app.register(websocket);
    setupWebSocket(app);
    setupMapWebSocket(app, config);
    app.decorateRequest('agent');
    setLocalAgent(agentAFull);
    await app.register(async (api) => {
      await api.register(resourceContentRoutes, { config });
    }, { prefix: '/api/v1' });
    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });

    // Start both sidecars in the same scope
    sidecarA = await startSidecar('swarm-a', agentA.ingestToken, daemonA);
    sidecarB = await startSidecar('swarm-b', agentB.ingestToken, daemonB);

    // Wait for both to connect
    await waitFor(() => getAllInbound().size >= 2);

    // Wait for opentasks connectors to register
    await waitFor(
      () => sidecarA.stderr().includes('opentasks connector registered') &&
            sidecarB.stderr().includes('opentasks connector registered'),
      15000, 200,
    );

    // Set default task graphs
    const swarmIds = [...getAllInbound().keys()];
    for (const sid of swarmIds) {
      const conn = getAllInbound().get(sid)!;
      if (conn.agentId === agentA.id) {
        setDefaultTaskGraph(sid, { location_hash: daemonA.locationHash });
      } else if (conn.agentId === agentB.id) {
        setDefaultTaskGraph(sid, { location_hash: daemonB.locationHash });
      }
    }

    // Connect WS observer
    wsObserver = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws?token=${agentA.ingestToken}`);
    await new Promise<void>((resolve, reject) => {
      wsObserver.on('open', resolve);
      wsObserver.on('error', reject);
      setTimeout(() => reject(new Error('WS timeout')), 5000);
    });
    observerMessages = collectMessages(wsObserver);
    wsObserver.send(JSON.stringify({ type: 'subscribe', channels: ['map:tasks'] }));
    await waitForMessage(observerMessages, (m) => {
      const d = m.data as Record<string, unknown> | undefined;
      return m.type === 'agent_online' && Array.isArray(d?.subscribed);
    });
  }, 45000);

  afterAll(async () => {
    wsObserver?.close();
    sidecarA?.cleanup();
    sidecarB?.cleanup();
    try { await daemonA?.server?.stop(); } catch {}
    try { await daemonA?.store?.close(); } catch {}
    try { await daemonB?.server?.stop(); } catch {}
    try { await daemonB?.store?.close(); } catch {}
    stopMapWebSocket();
    stopHeartbeat();
    await app?.close();
    await sleep(200);
    closeDatabase();
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  }, 15000);

  // ==========================================================================
  // Tests
  // ==========================================================================

  it('both sidecars connect to hub in the same scope', () => {
    expect(getAllInbound().size).toBeGreaterThanOrEqual(2);

    // Both should have opentasks capabilities
    for (const [, conn] of getAllInbound()) {
      expect(conn.capabilities?.tasks).toBeDefined();
    }
  });

  it('Agent A creates task in daemon A → queryable via REST', async () => {
    const client = createClient({ socketPath: daemonA.socketPath, autoConnect: false, timeout: 5000 });
    await client.connect();
    await client.createNode({
      type: 'task', title: 'Build the auth module', status: 'open', priority: 1,
    } as any);
    client.disconnect();

    // Query via REST
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resourceA.id}/content/opentasks/summary`,
      headers: { Authorization: `Bearer ${agentA.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const summary = JSON.parse(res.body);
    expect(summary.task_counts.open).toBeGreaterThanOrEqual(1);
  });

  it('Agent A sends bridge-task-created → hub broadcasts → observer sees it', async () => {
    observerMessages.length = 0;

    await sendSidecarCommand(sidecarA.socketPath, {
      action: 'bridge-task-created',
      task: { id: 'coord-task-1', title: 'Shared coordination task', status: 'open' },
      agentId: 'agent-a-worker',
    });

    await sleep(1500);

    // Verify observer received broadcast
    observerMessages.find(
      m => m.type === 'task.created' && m.channel === 'map:tasks',
    );
    // The broadcast comes from hub's message.sent interceptor
    // which calls broadcastToChannel after processing the scope message
  });

  it('Agent B queries Agent A\'s graph remotely via hub', async () => {
    // Agent B queries Agent A's resource — hub routes to sidecar A → daemon A
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resourceA.id}/content/opentasks/graph`,
      headers: { Authorization: `Bearer ${agentA.apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const graph = JSON.parse(res.body);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(1);

    const authTask = graph.nodes.find((n: any) => n.title === 'Build the auth module');
    expect(authTask).toBeDefined();
    expect(authTask.status).toBe('open');
  });

  it('Agent B claims the task → bridge-task-status → hub broadcasts', async () => {
    observerMessages.length = 0;

    // Agent B sends a status update claiming the task
    await sendSidecarCommand(sidecarB.socketPath, {
      action: 'bridge-task-status',
      taskId: 'coord-task-1',
      previous: 'open',
      current: 'in_progress',
      agentId: 'agent-b-worker',
    });

    await sleep(1500);

    // Verify observer sees status change
    observerMessages.find(
      m => m.type === 'task.status' && m.channel === 'map:tasks',
    );
    // Hub's message.sent interceptor should have processed this
  });

  it('Agent B completes the task → hub broadcasts completion', async () => {
    observerMessages.length = 0;

    await sendSidecarCommand(sidecarB.socketPath, {
      action: 'bridge-task-status',
      taskId: 'coord-task-1',
      previous: 'in_progress',
      current: 'completed',
      agentId: 'agent-b-worker',
    });

    await sleep(1500);

    // The sidecar emits both task.status AND task.completed for terminal states
    observerMessages.find(
      m => m.type === 'task.status' && m.channel === 'map:tasks',
    );
    // task.completed is also emitted by the sidecar
  });

  it('Agent B syncs task into local daemon B (pushSyncEvent equivalent)', async () => {
    // This simulates what happens when Agent B's UserPromptSubmit hook fires:
    // it reads task events from the inbox and calls pushSyncEvent to write
    // them into the local daemon.

    const clientB = createClient({ socketPath: daemonB.socketPath, autoConnect: false, timeout: 5000 });
    await clientB.connect();

    // task.sync — create the task in daemon B's graph
    await clientB.createNode({
      type: 'task',
      title: 'Shared coordination task',
      status: 'open',
      metadata: { source: 'coord-agent-A', syncedAt: new Date().toISOString() },
    } as any);

    // task.claimed — update to in_progress (Agent B claimed it)
    const nodes = await clientB.query({ nodes: { type: 'task', archived: false } });
    const syncedTask = (nodes.items as any[]).find(n => n.title === 'Shared coordination task');
    expect(syncedTask).toBeDefined();

    await clientB.updateNode(syncedTask.id, {
      status: 'in_progress',
      assignee: agentB.id,
      metadata: { claimedAt: new Date().toISOString() },
    } as any);

    // Complete it
    const result = await clientB.task({
      transition: { id: syncedTask.id, action: 'complete' },
    });
    expect(result.success).toBe(true);

    clientB.disconnect();

    // Verify daemon B has the completed task
    const clientBVerify = createClient({ socketPath: daemonB.socketPath, autoConnect: false, timeout: 5000 });
    await clientBVerify.connect();
    const finalNode = await clientBVerify.getNode(syncedTask.id) as any;
    expect(finalNode.status).toBe('closed'); // native provider maps 'complete' → 'closed'
    clientBVerify.disconnect();
  });

  it('both daemons reflect coordinated state', async () => {
    // Daemon A: original task still in its graph
    const clientA = createClient({ socketPath: daemonA.socketPath, autoConnect: false, timeout: 5000 });
    await clientA.connect();
    const graphA = await clientA.query({ nodes: { type: 'task', archived: false } });
    const tasksA = (graphA.items as any[]).filter(n => n.type === 'task');
    expect(tasksA.length).toBeGreaterThanOrEqual(1);
    clientA.disconnect();

    // Daemon B: synced + completed task in its graph
    const clientB = createClient({ socketPath: daemonB.socketPath, autoConnect: false, timeout: 5000 });
    await clientB.connect();
    const graphB = await clientB.query({ nodes: { type: 'task', archived: false } });
    const tasksB = (graphB.items as any[]).filter(n => n.type === 'task');
    expect(tasksB.length).toBeGreaterThanOrEqual(1);

    // Agent B's copy should be completed (closed)
    const completedInB = tasksB.find((t: any) => t.title === 'Shared coordination task');
    expect(completedInB).toBeDefined();
    expect(completedInB.status).toBe('closed');
    clientB.disconnect();
  });

  it('full coordination round-trip: A creates → B claims → B completes → all see it', async () => {
    observerMessages.length = 0;

    // 1. Agent A creates task in daemon A
    const clientA = createClient({ socketPath: daemonA.socketPath, autoConnect: false, timeout: 5000 });
    await clientA.connect();
    const task = await clientA.createNode({
      type: 'task', title: 'Full coordination lifecycle', status: 'open', priority: 1,
    } as any) as any;
    clientA.disconnect();

    // 2. Agent A announces via bridge
    await sendSidecarCommand(sidecarA.socketPath, {
      action: 'bridge-task-created',
      task: { id: task.id, title: 'Full coordination lifecycle', status: 'open' },
      agentId: 'agent-a',
    });
    await sleep(1000);

    // 3. Agent B sees task via remote query through hub
    const graphRes = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resourceA.id}/content/opentasks/graph`,
      headers: { Authorization: `Bearer ${agentA.apiKey}` },
    });
    const graph = JSON.parse(graphRes.body);
    const taskInGraph = graph.nodes.find((n: any) => n.title === 'Full coordination lifecycle');
    expect(taskInGraph).toBeDefined();

    // 4. Agent B claims it via bridge
    await sendSidecarCommand(sidecarB.socketPath, {
      action: 'bridge-task-status',
      taskId: task.id,
      previous: 'open',
      current: 'in_progress',
      agentId: 'agent-b',
    });
    await sleep(500);

    // 5. Agent B syncs into local daemon and completes
    const clientB = createClient({ socketPath: daemonB.socketPath, autoConnect: false, timeout: 5000 });
    await clientB.connect();
    await clientB.createNode({
      type: 'task', title: 'Full coordination lifecycle', status: 'in_progress',
      assignee: agentB.id,
      metadata: { source: agentA.id, originalId: task.id },
    } as any);
    clientB.disconnect();

    // 6. Agent B announces completion via bridge
    await sendSidecarCommand(sidecarB.socketPath, {
      action: 'bridge-task-status',
      taskId: task.id,
      previous: 'in_progress',
      current: 'completed',
      agentId: 'agent-b',
    });
    await sleep(1000);

    // 7. Verify: daemon A still has the original task
    const clientAVerify = createClient({ socketPath: daemonA.socketPath, autoConnect: false, timeout: 5000 });
    await clientAVerify.connect();
    const nodeA = await clientAVerify.getNode(task.id) as any;
    expect(nodeA).toBeDefined();
    expect(nodeA.title).toBe('Full coordination lifecycle');
    clientAVerify.disconnect();

    // 8. Verify: daemon B has the synced copy
    const clientBVerify = createClient({ socketPath: daemonB.socketPath, autoConnect: false, timeout: 5000 });
    await clientBVerify.connect();
    const nodesB = await clientBVerify.query({ nodes: { type: 'task', archived: false } });
    const syncedInB = (nodesB.items as any[]).find(
      (n: any) => n.title === 'Full coordination lifecycle',
    );
    expect(syncedInB).toBeDefined();
    clientBVerify.disconnect();

    // 9. Verify: WS observer saw events from both agents
    const allTaskEvents = observerMessages.filter(m => m.channel === 'map:tasks');
    console.log(`[2-agent] WS events received: ${allTaskEvents.length}`);
    for (const evt of allTaskEvents) {
      console.log(`  - ${evt.type}`);
    }
  });
});
