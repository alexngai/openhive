/**
 * E2E Test: Remote OpenTasks Mutations via MAP Connector
 *
 * Extends the remote query E2E test to cover:
 * - Remote task creation via REST (hub → sidecar → daemon → response)
 * - Remote status update via REST
 * - Remote graph retrieval (nodes + edges)
 * - MAP task handlers routing to remote swarm
 * - Full remote round-trip: create → query → verify
 *
 * Uses a real OpenTasks daemon + real cc-swarm sidecar process.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { getAllInbound, setDefaultTaskGraph } from '../../map/connection-registry.js';
import { ConfigSchema, type Config } from '../../config.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
import { setLocalAgent } from '../../api/middleware/auth.js';

import {
  createGraphStore, createIPCServer, createDaemonFlushManager,
  registerToolsMethods, registerGraphMethods, registerLifecycleMethods,
  createSQLitePersister, createJSONLPersister, createProviderAwareStore,
  type GraphStore, type IPCServer,
} from 'opentasks';

// Short path — macOS 104-byte Unix socket limit
const TEST_ROOT = path.join('/tmp', `ot-remote-mut-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, 'remote-mut.db');
const SERVER_PORT = 19671;

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

describe.skipIf(!sidecarExists)('E2E: Remote OpenTasks Mutations via MAP', { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };
  let ingestToken: string;
  let sidecar: {
    pid: number; child: ChildProcess; socketPath: string;
    workDir: string; stderr: () => string; cleanup: () => void;
  } | null = null;
  let opentasksDir: string;
  let locationHash: string;
  let otStore: GraphStore;
  let otServer: IPCServer;
  let daemonSocketPath: string;
  let resourceId: string;

  beforeAll(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    initDatabase(TEST_DB_PATH);

    const { agent, apiKey } = await agentsDAL.createAgent({
      name: 'remote-mut-agent',
      description: 'E2E remote mutations',
    });
    testAgent = { id: agent.id, apiKey };
    const { plaintext_key } = createIngestKey(agent.id, { label: 'remote-mut', agent_id: agent.id });
    ingestToken = plaintext_key;

    // Start OpenTasks daemon
    opentasksDir = path.join(TEST_ROOT, 'g');
    fs.mkdirSync(opentasksDir, { recursive: true });
    const otDir = path.join(opentasksDir, '.opentasks');
    fs.mkdirSync(otDir, { recursive: true });

    locationHash = `remote-mut-${process.pid}`;
    daemonSocketPath = path.join(otDir, 'daemon.sock');
    fs.writeFileSync(path.join(otDir, 'config.json'), JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: 'remote-mut' },
      daemon: { socketPath: daemonSocketPath },
    }));
    fs.writeFileSync(path.join(otDir, 'graph.jsonl'), '');

    const sqlite = createSQLitePersister(otDir);
    await sqlite.initialize();
    const jsonl = createJSONLPersister(otDir);
    const jsonlPath = path.join(otDir, 'graph.jsonl');
    const jsonlLoad = async () => {
      try { return fs.existsSync(jsonlPath) ? await jsonl.load() : { nodes: [], edges: [] }; }
      catch { return { nodes: [], edges: [] }; }
    };
    const jsonlSave = async (n: any[], e: any[]) => { await jsonl.save(n, e); };

    otStore = createGraphStore(
      { basePath: otDir, flush: { debounceMs: 50, maxDelayMs: 100 } },
      sqlite, jsonlLoad, jsonlSave,
    );
    await otStore.initialize();

    const flushMgr = createDaemonFlushManager(
      { debounceMs: 50, maxDelayMs: 100 },
      async () => { await otStore.flush(); },
    );
    otServer = createIPCServer(daemonSocketPath);

    const providerStore = createProviderAwareStore(otStore);
    const locState = {
      hash: locationHash, opentasksPath: otDir, store: otStore, providerStore,
      flushManager: flushMgr, watcher: null as any, primary: true, healthy: true,
    };
    const locResolver = {
      resolve: () => locState, getDefault: () => locState,
      list: () => [{ hash: locationHash, opentasksPath: otDir, primary: true, healthy: true }],
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

    // Seed initial data
    await otStore.createNode({ type: 'task', title: 'Seed task A', status: 'open', priority: 1 } as any);
    await otStore.createNode({ type: 'task', title: 'Seed task B', status: 'open', priority: 2 } as any);
    await otStore.flush();

    // Start OpenHive server
    const config = ConfigSchema.parse({
      port: SERVER_PORT, host: '127.0.0.1', database: TEST_DB_PATH,
      instance: { name: 'Remote Mutations E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open' },
    });

    app = Fastify({ logger: false });
    await app.register(websocket);
    setupMapWebSocket(app, config);
    app.decorateRequest('agent', null);
    setLocalAgent(testAgent.id);
    await app.register(async (api) => {
      await api.register(resourceContentRoutes, { config });
    }, { prefix: '/api/v1' });
    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 30000);

  afterAll(async () => {
    sidecar?.cleanup();
    try { await otServer?.stop(); } catch {}
    try { await otStore?.close(); } catch {}
    stopMapWebSocket();
    await app?.close();
    await sleep(200);
    closeDatabase();
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  }, 15000);

  async function startSidecar(): Promise<NonNullable<typeof sidecar>> {
    const workDir = fs.mkdtempSync(path.join('/tmp', 'ot-rmut-e2e-'));
    const mapDir = path.join(fs.realpathSync(workDir), '.swarm', 'claude-swarm', 'tmp', 'map');
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.swarm', 'claude-swarm', 'config.json'),
      JSON.stringify({ template: 'test', opentasks: { enabled: true } }),
    );

    // Create .opentasks/ in workDir and symlink the daemon socket
    const workOtDir = path.join(workDir, '.opentasks');
    fs.mkdirSync(workOtDir, { recursive: true });
    fs.writeFileSync(path.join(workOtDir, 'config.json'), JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: 'remote-mut' },
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
      '--scope', 'swarm:remote-mut',
      '--system-id', 'system-remote-mut',
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
      throw new Error(`Sidecar not ready. Stderr: ${stderr}`);
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

  async function ensureSidecarConnected(): Promise<void> {
    if (!sidecar) {
      sidecar = await startSidecar();
    }
    const connected = await waitFor(() => getAllInbound().size > 0);
    if (!connected) throw new Error('Sidecar did not connect');

    // Wait for opentasks connector
    await waitFor(() => sidecar!.stderr().includes('opentasks connector registered'), 15000, 200);

    // Register remote resource if not already done
    const existing = resourcesDAL.findResourceById(resourceId);
    if (!existing) {
      const resource = resourcesDAL.createResource({
        resource_type: 'task', name: 'remote-mut-graph', description: 'Remote',
        git_remote_url: `remote://${locationHash}`, visibility: 'shared',
        owner_agent_id: testAgent.id,
        metadata: { opentasks: true, location_hash: locationHash },
      });
      resourceId = resource.id;
    }

    const swarmIds = [...getAllInbound().keys()];
    if (swarmIds.length > 0) {
      setDefaultTaskGraph(swarmIds[0], { location_hash: locationHash });
    }

    await sleep(500);
  }

  it('sidecar connects with opentasks capabilities', async () => {
    await ensureSidecarConnected();
    const caps = [...getAllInbound().values()][0]?.capabilities as Record<string, unknown> | undefined;
    expect(caps?.tasks).toBeDefined();
  });

  it('can query remote graph via REST — nodes and edges', async () => {
    await ensureSidecarConnected();

    const graphRes = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resourceId}/content/opentasks/graph`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
    });

    expect(graphRes.statusCode).toBe(200);
    const graph = JSON.parse(graphRes.body);
    expect(graph.nodes).toBeInstanceOf(Array);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2); // seeded 2 tasks
  });

  it('can get remote summary via REST', async () => {
    await ensureSidecarConnected();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resourceId}/content/opentasks/summary`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const summary = JSON.parse(res.body);
    expect(summary.node_count).toBeGreaterThanOrEqual(2);
    expect(summary.task_counts).toBeDefined();
    expect(summary.remote_connected).toBe(true);
  });

  it('remote summary returns task status breakdown', async () => {
    await ensureSidecarConnected();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resourceId}/content/opentasks/summary`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
    });

    const summary = JSON.parse(res.body);
    expect(summary.task_counts.open).toBeGreaterThanOrEqual(2);
  });

  it('remote graph includes node details (title, status, priority)', async () => {
    await ensureSidecarConnected();

    const graphRes = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resourceId}/content/opentasks/graph`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
    });

    const graph = JSON.parse(graphRes.body);
    const seedA = graph.nodes.find((n: any) => n.title === 'Seed task A');
    expect(seedA).toBeDefined();
    expect(seedA.status).toBe('open');
    expect(seedA.type).toBe('task');
  });

  it('GET /tasks falls back to remote query', async () => {
    await ensureSidecarConnected();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks?limit=10`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.daemon_connected).toBe(true);
    expect(body.source).toBe('remote');
    expect(body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /status returns remote indicator for connected swarm', async () => {
    await ensureSidecarConnected();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resourceId}/content/opentasks/status`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.daemon_connected).toBe(true);
    expect(body.source).toBe('remote');
    expect(body.swarm_id).toBeDefined();
  });

  it('POST /tasks creates a task on remote graph', async () => {
    await ensureSidecarConnected();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      payload: { title: 'Remote-created task', description: 'via REST', priority: 3 },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.node_id).toBeDefined();
    expect(body.status).toBe('open');

    // Verify in upstream daemon's store
    await sleep(200);
    const created = await otStore.getNode(body.node_id) as any;
    expect(created).toBeDefined();
    expect(created.title).toBe('Remote-created task');
  });

  it('PATCH /tasks/:nodeId updates status via remote task.request', async () => {
    await ensureSidecarConnected();

    // Create a task to mutate
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      payload: { title: 'Status update target' },
    });
    const { node_id } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${node_id}`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      payload: { status: 'in_progress' },
    });

    expect(res.statusCode).toBe(200);

    await sleep(200);
    const node = await otStore.getNode(node_id);
    expect(node?.status).toBe('in_progress');
  });

  it('PATCH /tasks/:nodeId updates fields via remote graph.update.request', async () => {
    await ensureSidecarConnected();

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      payload: { title: 'Field update target' },
    });
    const { node_id } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${node_id}`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      payload: { title: 'Renamed title', assignee: 'agent-99', priority: 4 },
    });

    expect(res.statusCode).toBe(200);

    await sleep(200);
    const node = await otStore.getNode(node_id) as any;
    expect(node?.title).toBe('Renamed title');
    expect(node?.assignee).toBe('agent-99');
    expect(node?.priority).toBe(4);
  });

  it('POST /tasks/:nodeId/links creates an edge via remote link.request', async () => {
    await ensureSidecarConnected();

    const a = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      payload: { title: 'Link source' },
    });
    const b = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      payload: { title: 'Link target' },
    });
    const fromId = JSON.parse(a.body).node_id;
    const toId = JSON.parse(b.body).node_id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${fromId}/links`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      payload: { targetId: toId, type: 'blocks' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.from_id).toBe(fromId);
    expect(body.to_id).toBe(toId);
    expect(body.type).toBe('blocks');
    expect(body.edge_id).toBeDefined();

    // Now remove the edge
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/${fromId}/links/${toId}?type=blocks`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body).removed).toBe(true);
  });

  it('DELETE /tasks/:nodeId returns 501 for remote (upstream limitation)', async () => {
    await ensureSidecarConnected();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/some-node-id`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
    });

    expect(res.statusCode).toBe(501);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/graph\.delete\.request/);
  });
});
