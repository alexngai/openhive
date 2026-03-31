/**
 * E2E Test: Remote OpenTasks Query via MAP Connector
 *
 * Uses a real OpenTasks daemon (via API) + real cc-swarm sidecar process.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn, ChildProcess, execSync } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { getAllInbound, setDefaultTaskGraph } from '../../map/connection-registry.js';
import { ConfigSchema, type Config } from '../../config.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

// Import opentasks for daemon setup
import {
  createGraphStore, createIPCServer, createDaemonFlushManager,
  registerToolsMethods, createSQLitePersister, createJSONLPersister,
  type GraphStore, type IPCServer,
} from 'opentasks';

// Use a short path to avoid macOS 104-byte Unix socket path limit
const TEST_ROOT = path.join('/tmp', `ot-e2e-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, 'remote-e2e.db');
const SERVER_PORT = 19670;

const SIDECAR_SCRIPT = path.resolve(
  __dirname, '..', '..', '..', 'references', 'claude-code-swarm', 'scripts', 'map-sidecar.mjs',
);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15000, intervalMs = 250): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function sendSidecarCommand(socketPath: string, command: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(command) + '\n');
    });
    let buffer = '';
    client.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) { client.end(); try { resolve(JSON.parse(buffer.slice(0, idx))); } catch { resolve(null); } }
    });
    client.on('error', () => resolve(null));
    setTimeout(() => { client.destroy(); resolve(null); }, 5000);
  });
}

const sidecarExists = fs.existsSync(SIDECAR_SCRIPT);

describe.skipIf(!sidecarExists)('E2E: Remote OpenTasks via MAP Connector', { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };
  let ingestToken: string;
  let sidecar: { pid: number; child: ChildProcess; socketPath: string; workDir: string; stderr: () => string; cleanup: () => void } | null = null;
  let opentasksDir: string;
  let locationHash: string;
  let otStore: GraphStore;
  let otServer: IPCServer;
  let daemonSocketPath: string;

  beforeAll(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    initDatabase(TEST_DB_PATH);

    const { agent, apiKey } = await agentsDAL.createAgent({ name: 'remote-e2e-agent', description: 'E2E' });
    testAgent = { id: agent.id, apiKey };
    const { plaintext_key } = createIngestKey(agent.id, { label: 'remote-e2e', agent_id: agent.id });
    ingestToken = plaintext_key;

    // Start opentasks daemon via API
    opentasksDir = path.join(TEST_ROOT, 'g');
    fs.mkdirSync(opentasksDir, { recursive: true });
    const otDir = path.join(opentasksDir, '.opentasks');
    fs.mkdirSync(otDir, { recursive: true });

    locationHash = `e2e-${process.pid}`;
    daemonSocketPath = path.join(otDir, 'daemon.sock');
    fs.writeFileSync(path.join(otDir, 'config.json'), JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: 'e2e' },
      daemon: { socketPath: daemonSocketPath },
    }));
    const jsonlPath = path.join(otDir, 'graph.jsonl');
    fs.writeFileSync(jsonlPath, '');

    const sqlite = createSQLitePersister(otDir);
    await sqlite.initialize();
    const jsonl = createJSONLPersister(otDir);
    const jsonlLoad = async () => { try { return fs.existsSync(jsonlPath) ? await jsonl.load() : { nodes: [], edges: [] }; } catch { return { nodes: [], edges: [] }; } };
    const jsonlSave = async (n: any[], e: any[]) => { await jsonl.save(n, e); };

    otStore = createGraphStore({ basePath: otDir, flush: { debounceMs: 50, maxDelayMs: 100 } }, sqlite, jsonlLoad, jsonlSave);
    await otStore.initialize();

    const flushMgr = createDaemonFlushManager({ debounceMs: 50, maxDelayMs: 100 }, async () => { await otStore.flush(); });
    otServer = createIPCServer(daemonSocketPath);

    const locState = { hash: locationHash, opentasksPath: otDir, store: otStore, flushManager: flushMgr, watcher: null as any, primary: true, healthy: true };
    const locResolver = {
      resolve: () => locState, getDefault: () => locState,
      list: () => [{ hash: locationHash, opentasksPath: otDir, primary: true, healthy: true }],
      has: (h: string) => h === locationHash, add: () => {}, remove: async () => {},
    };
    registerToolsMethods({ server: otServer, locationResolver: locResolver });
    await otServer.start();

    // Seed data
    await otStore.createNode({ type: 'task', title: 'Remote task A', status: 'open', priority: 2 } as any);
    await otStore.createNode({ type: 'task', title: 'Remote task B', status: 'in_progress', priority: 1 } as any);
    await otStore.flush();

    // Start OpenHive server
    const config = ConfigSchema.parse({
      port: SERVER_PORT, host: '127.0.0.1', database: TEST_DB_PATH,
      instance: { name: 'Remote E2E' }, admin: { createOnStartup: false },
      auth: { mode: 'local' }, rateLimit: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open' },
    });

    app = Fastify({ logger: false });
    await app.register(websocket);
    setupMapWebSocket(app, config);
    app.decorateRequest('agent', null);
    setLocalAgent(testAgent.id);
    await app.register(async (api) => { await api.register(resourceContentRoutes, { config }); }, { prefix: '/api/v1' });
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

  async function startSidecar(): Promise<typeof sidecar> {
    const workDir = fs.mkdtempSync(path.join('/tmp', 'ot-remote-e2e-'));
    const mapDir = path.join(fs.realpathSync(workDir), '.swarm', 'claude-swarm', 'tmp', 'map');
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, '.swarm', 'claude-swarm', 'config.json'), JSON.stringify({ template: 'test', opentasks: { enabled: true } }));

    // Create .opentasks/ in workDir and symlink the daemon socket
    const workOtDir = path.join(workDir, '.opentasks');
    fs.mkdirSync(workOtDir, { recursive: true });
    fs.writeFileSync(path.join(workOtDir, 'config.json'), JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: 'e2e' },
    }));
    fs.writeFileSync(path.join(workOtDir, 'graph.jsonl'), '');
    // Symlink daemon socket — use the same path as createIPCServer (NOT realpathSync which adds /private)
    const realSocketPath = daemonSocketPath;
    fs.symlinkSync(realSocketPath, path.join(workOtDir, 'daemon.sock'));
    // Also create .swarm/opentasks/ with socket (findSocketPath checks this first)
    const swarmOtDir = path.join(workDir, '.swarm', 'opentasks');
    fs.mkdirSync(swarmOtDir, { recursive: true });
    fs.symlinkSync(realSocketPath, path.join(swarmOtDir, 'daemon.sock'));

    const sidecarSocket = path.join(mapDir, 'sidecar.sock');
    const child = spawn('node', [
      SIDECAR_SCRIPT, '--server', `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${ingestToken}`,
      '--scope', 'swarm:remote-e2e', '--system-id', 'system-remote-e2e',
      '--inactivity-timeout', '120000',
    ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: workDir,
         env: { ...process.env, SWARM_LOG_LEVEL: 'debug', SWARM_LOG_STDERR: 'true' } });
    child.unref();

    let stderr = '';
    child.stderr!.on('data', (d) => { stderr += d.toString(); });

    const ready = await waitFor(async () => {
      if (!fs.existsSync(sidecarSocket)) return false;
      const resp = await sendSidecarCommand(sidecarSocket, { action: 'ping' });
      return resp !== null && (resp as any).ok === true;
    });
    if (!ready) { try { process.kill(child.pid!, 'SIGTERM'); } catch {} throw new Error(`Sidecar not ready. Stderr: ${stderr}`); }

    return {
      pid: child.pid!, child, socketPath: sidecarSocket, workDir, stderr: () => stderr,
      cleanup: () => { try { process.kill(child.pid!, 'SIGTERM'); } catch {} try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {} },
    };
  }

  it('sidecar connects with opentasks capabilities', async () => {
    sidecar = await startSidecar();
    const connected = await waitFor(() => getAllInbound().size > 0);
    expect(connected).toBe(true);
    const caps = [...getAllInbound().values()][0]?.capabilities as Record<string, unknown> | undefined;
    expect(caps?.tasks).toBeDefined();
  });

  it('can query remote graph via REST', async () => {
    if (!sidecar) { sidecar = await startSidecar(); await waitFor(() => getAllInbound().size > 0); }

    // Wait for connector to register
    await waitFor(() => sidecar!.stderr().includes('opentasks connector registered'), 15000, 200);

    // Register remote resource
    const resource = resourcesDAL.createResource({
      resource_type: 'task', name: 'remote-graph', description: 'Remote',
      git_remote_url: `remote://${locationHash}`, visibility: 'shared',
      owner_agent_id: testAgent.id, metadata: { opentasks: true, location_hash: locationHash },
    });

    const swarmIds = [...getAllInbound().keys()];
    if (swarmIds.length > 0) setDefaultTaskGraph(swarmIds[0], { location_hash: locationHash });

    await sleep(500);

    const summaryRes = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resource.id}/content/opentasks/summary`,
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
    });

    if (summaryRes.statusCode !== 200) {
      console.log('Summary status:', summaryRes.statusCode, summaryRes.body);
      console.log('Sidecar stderr (last 500):', sidecar.stderr().slice(-500));
    }

    expect(summaryRes.statusCode).toBe(200);
    const summary = JSON.parse(summaryRes.body);
    expect(summary.node_count).toBeGreaterThanOrEqual(2);
  });
});
