/**
 * E2E Test: OpenTasks Context Bridge (daemon → sidecar → hub → observer)
 *
 * Proves the full production path for agent-authored specs:
 *
 *   Agent writes a context node via `graph.create` (opentasks daemon IPC)
 *     → opentasks daemon watch.event notification
 *     → cc-swarm `opentasks-bridge.mjs` attached in the sidecar
 *     → `createMAPEventBridge.handleProviderChange` emits context.created
 *     → MAP WS to OpenHive hub
 *     → `handleMapContextEvent` re-broadcasts spec.created on map:tasks
 *     → /ws observer receives the spec.created event
 *
 * This is the complementary e2e to `context-bridge-ws-e2e.test.ts`: that
 * test drives the bridge directly from the test process, this one drives
 * it through the real sidecar subprocess + the real daemon.
 *
 * Unlike the task bridge (`bridge-task-*` sidecar commands driven by
 * PostToolUse hooks), context events have no hook counterpart — they
 * flow purely via the daemon watcher.
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
import {
  getAllInbound,
  setDefaultTaskGraph,
} from '../../map/connection-registry.js';
import { ConfigSchema, type Config } from '../../config.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { specsRoutes } from '../../api/routes/specs.js';
import {
  createClient,
  createDaemon,
  createStoreForLocation,
  type Daemon,
  type GraphStore,
} from 'opentasks';

const TEST_ROOT = path.join('/tmp', `ot-ctx-bridge-e2e-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, 'ctx-bridge.db');
const SERVER_PORT = 19685;

const SIDECAR_SCRIPT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'references',
  'claude-code-swarm',
  'scripts',
  'map-sidecar.mjs',
);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15000,
  intervalMs = 200,
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
    try {
      messages.push(JSON.parse(data.toString()));
    } catch {
      /* ignore */
    }
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
        try {
          resolve(JSON.parse(buffer.slice(0, idx)));
        } catch {
          resolve(null);
        }
      }
    });
    client.on('error', () => resolve(null));
    setTimeout(() => {
      client.destroy();
      resolve(null);
    }, 5000);
  });
}

const sidecarExists = fs.existsSync(SIDECAR_SCRIPT);

describe.skipIf(!sidecarExists)(
  'E2E: opentasks daemon → sidecar → hub context bridge',
  { timeout: 90_000 },
  () => {
    let app: FastifyInstance;
    let agent: { id: string; apiKey: string; ingestToken: string };
    let agentFull: any;
    let store: GraphStore;
    let daemon: Daemon;
    let opentasksDir: string;
    let resourceId: string;

    let sidecar: {
      pid: number;
      child: ChildProcess;
      socketPath: string;
      workDir: string;
      stderr: () => string;
      cleanup: () => void;
    } | null = null;

    let wsObserver: WebSocket;
    let observerMessages: Array<Record<string, unknown>>;

    beforeAll(async () => {
      fs.mkdirSync(TEST_ROOT, { recursive: true });
      initDatabase(TEST_DB_PATH);

      const a = await agentsDAL.createAgent({
        name: 'ctx-bridge-agent',
        description: 'Context bridge e2e',
      });
      const ik = createIngestKey(a.agent.id, {
        label: 'ctx-bridge',
        agent_id: a.agent.id,
      });
      agent = { id: a.agent.id, apiKey: a.apiKey, ingestToken: ik.plaintext_key };
      agentFull = a.agent;

      // Real opentasks daemon with its own chokidar watcher + flush
      // plumbing. This mirrors production; our hand-rolled setup didn't
      // flush the JSONL reliably, so the file watcher never fired.
      opentasksDir = path.join(TEST_ROOT, '.opentasks');
      fs.mkdirSync(opentasksDir, { recursive: true });

      store = await createStoreForLocation(opentasksDir);
      daemon = createDaemon({
        locationPath: opentasksDir,
        version: '1.0.0-test',
        store,
        registryPath: path.join(TEST_ROOT, 'registry', 'registry.json'),
        shutdownTimeoutMs: 5000,
      });
      await daemon.start();

      const daemonSocketPath = daemon.socketPath;

      // Register a task-shaped resource so hub can resolve resource_id
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'ctx-bridge-graph',
        git_remote_url: opentasksDir,
        visibility: 'shared',
        owner_agent_id: agent.id,
        sync_strategy: 'local',
        local_path: opentasksDir,
        metadata: { opentasks: true, location_hash: path.basename(opentasksDir) },
      });
      resourceId = resource.id;

      // Start hub
      const config = ConfigSchema.parse({
        port: SERVER_PORT,
        host: '127.0.0.1',
        database: TEST_DB_PATH,
        instance: { name: 'Context Bridge E2E' },
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
      setLocalAgent(agentFull);
      // Mount specs routes so the dedup cross-path test can POST /specs and
      // verify the REST broadcast and the watcher-driven broadcast converge
      // to a single frame on the observer.
      await app.register(async (api) => {
        await api.register(specsRoutes, { config: config as Config });
      }, { prefix: '/api/v1' });
      await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });

      // Start sidecar — it will connect to the hub + attach to our daemon
      const workDir = fs.mkdtempSync(path.join('/tmp', 'ot-ctx-sc-'));
      const mapDir = path.join(
        fs.realpathSync(workDir),
        '.swarm',
        'claude-swarm',
        'tmp',
        'map',
      );
      fs.mkdirSync(mapDir, { recursive: true });
      fs.writeFileSync(
        path.join(workDir, '.swarm', 'claude-swarm', 'config.json'),
        JSON.stringify({ template: 'test', opentasks: { enabled: true } }),
      );
      // Point the sidecar's opentasks socket discovery at our daemon
      const workOtDir = path.join(workDir, '.opentasks');
      fs.mkdirSync(workOtDir, { recursive: true });
      fs.writeFileSync(
        path.join(workOtDir, 'config.json'),
        JSON.stringify({
          version: '1.0',
          location: {
            hash: path.basename(opentasksDir),
            uuid: path.basename(opentasksDir),
            name: 'ctx-bridge-test',
          },
        }),
      );
      fs.writeFileSync(path.join(workOtDir, 'graph.jsonl'), '');
      fs.symlinkSync(daemonSocketPath, path.join(workOtDir, 'daemon.sock'));
      const swarmOtDir = path.join(workDir, '.swarm', 'opentasks');
      fs.mkdirSync(swarmOtDir, { recursive: true });
      fs.symlinkSync(daemonSocketPath, path.join(swarmOtDir, 'daemon.sock'));

      const sidecarSocket = path.join(mapDir, 'sidecar.sock');
      const child = spawn(
        'node',
        [
          SIDECAR_SCRIPT,
          '--server',
          `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${agent.ingestToken}`,
          '--scope',
          'swarm:ctx-bridge-test',
          '--system-id',
          'system-ctx-bridge-test',
          '--inactivity-timeout',
          '120000',
        ],
        {
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe'],
          cwd: workDir,
          env: { ...process.env, SWARM_LOG_LEVEL: 'debug', SWARM_LOG_STDERR: 'true' },
        },
      );
      child.unref();
      let stderr = '';
      child.stderr!.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      const ready = await waitFor(async () => {
        if (!fs.existsSync(sidecarSocket)) return false;
        const resp = await sendSidecarCommand(sidecarSocket, { action: 'ping' });
        return resp !== null && (resp as any).ok === true;
      });
      if (!ready) {
        try {
          process.kill(child.pid!, 'SIGTERM');
        } catch {
          /* ignore */
        }
        throw new Error(`Sidecar not ready. Stderr: ${stderr}`);
      }

      sidecar = {
        pid: child.pid!,
        child,
        socketPath: sidecarSocket,
        workDir,
        stderr: () => stderr,
        cleanup: () => {
          try {
            process.kill(child.pid!, 'SIGTERM');
          } catch {
            /* ignore */
          }
          try {
            fs.rmSync(workDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        },
      };

      // Wait for the sidecar to register and for the opentasks bridge to
      // attach. The bridge's log line is "opentasks event bridge active".
      await waitFor(() => getAllInbound().size > 0);
      const bridgeAttached = await waitFor(
        () => sidecar!.stderr().includes('opentasks event bridge active'),
        15000,
        200,
      );
      if (!bridgeAttached) {
        // eslint-disable-next-line no-console
        console.error('[e2e] opentasks bridge did not attach. Sidecar stderr:\n', sidecar!.stderr());
        throw new Error('opentasks event bridge did not attach within timeout');
      }

      const swarmIds = [...getAllInbound().keys()];
      if (swarmIds.length > 0) {
        setDefaultTaskGraph(swarmIds[0], {
          resource_id: resourceId,
          location_hash: path.basename(opentasksDir),
        });
      }

      // Let the daemon's file watcher + watch handler finish initializing
      // so the seedCache pass sees an empty graph before we write.
      await sleep(500);

      // Connect WS observer to receive broadcast fan-out
      wsObserver = new WebSocket(
        `ws://127.0.0.1:${SERVER_PORT}/ws?token=${agent.ingestToken}`,
      );
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
    }, 60_000);

    afterAll(async () => {
      wsObserver?.close();
      sidecar?.cleanup();
      try {
        await daemon?.stop();
      } catch {
        /* ignore */
      }
      try {
        await store?.close();
      } catch {
        /* ignore */
      }
      stopMapWebSocket();
      stopHeartbeat();
      await app?.close();
      await sleep(200);
      closeDatabase();
      try {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }, 15_000);

    /**
     * Force the daemon to flush in-memory state to disk. The watch
     * handler is driven by the chokidar file watcher on graph.jsonl, so
     * writes stay invisible to watchers until flushed. The opentasks
     * daemon exposes this via the `flush` IPC method.
     */
    async function flush(client: any): Promise<void> {
      try {
        await client.request('flush');
      } catch {
        /* some setups respond with null — safe to ignore */
      }
    }

    it('agent creates kind=spec context via daemon → observer sees spec.created on map:tasks', async () => {
      observerMessages.length = 0;

      const client = createClient({
        socketPath: daemon.socketPath,
        autoConnect: false,
        timeout: 5000,
      });
      await client.connect();

      const node = (await client.createNode({
        type: 'context',
        title: 'Auth refactor spec',
        content: 'Body',
        priority: 2,
        metadata: { kind: 'spec' },
      } as any)) as any;

      expect(node).toBeTruthy();
      expect(node.id).toBeTruthy();

      // Force flush so the chokidar watcher fires and the sidecar's
      // bridge receives a watch.event notification.
      await flush(client);
      client.disconnect();

      // Observer should receive a spec.created broadcast — this traverses:
      //   daemon watch → sidecar bridge → MAP → hub listener → map:tasks
      const hit = await waitForMessage(
        observerMessages,
        (m) => m.type === 'spec.created' && m.channel === 'map:tasks',
        10_000,
      );

      expect(hit).not.toBeNull();
      const data = hit!.data as Record<string, unknown>;
      expect(data.resource_id).toBe(resourceId);
      expect(data.initiator).toMatchObject({ type: 'agent' });
      expect(data.spec).toMatchObject({
        id: node.id,
        title: 'Auth refactor spec',
        metadata: { kind: 'spec' },
      });
    });

    it('plain context (no kind=spec) via daemon produces NO spec broadcast', async () => {
      observerMessages.length = 0;

      const client = createClient({
        socketPath: daemon.socketPath,
        autoConnect: false,
        timeout: 5000,
      });
      await client.connect();

      await client.createNode({
        type: 'context',
        title: 'Just a note',
        metadata: { tags: ['note'] },
      } as any);
      await flush(client);
      client.disconnect();

      // Allow time for the watcher + bridge + hub to process; we assert
      // no spec.* broadcast arrives.
      await sleep(2000);

      const specHit = observerMessages.find(
        (m) => typeof m.type === 'string' && (m.type as string).startsWith('spec.'),
      );
      expect(specHit).toBeUndefined();
    });

    it('REST create + watcher fire on shared daemon → exactly one spec.created broadcast', async () => {
      // Scenario: hub and the sidecar share the same opentasks daemon
      // (local co-located deployment). A user POSTs to /specs, which
      // writes via daemonCreateSpec AND broadcasts spec.created directly.
      // The daemon's watcher then fires, the sidecar's bridge forwards
      // context.created to the hub, and handleMapContextEvent would
      // rebroadcast spec.created. The dedup cache must collapse both to
      // one frame on the observer.
      observerMessages.length = 0;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/specs',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        payload: {
          resource_id: resourceId,
          title: 'REST-authored spec',
          content: 'User typed this in the compose form',
          priority: 1,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      const specId = body.spec?.id as string;
      expect(specId).toBeTruthy();

      // Wait long enough for both paths to try to fire:
      //   - REST direct broadcast: synchronous, already sent
      //   - Watcher path: chokidar ≈ 100ms + watch-debounce 150ms + MAP
      //     transit ≈ 100ms — call it 600ms to be safe
      await sleep(1000);

      const specBroadcasts = observerMessages.filter(
        (m) => m.type === 'spec.created' && m.channel === 'map:tasks',
      );

      // Core assertion: exactly one broadcast hit the observer for this spec
      const matching = specBroadcasts.filter((m) => {
        const spec = (m.data as Record<string, unknown>)?.spec as Record<string, unknown> | undefined;
        return spec?.id === specId;
      });
      expect(matching).toHaveLength(1);

      // First-broadcast-wins: the REST broadcast (initiator.type='user')
      // should be the one that landed, not the watcher's agent-typed one.
      const data = matching[0].data as Record<string, unknown>;
      expect(data.initiator).toMatchObject({ type: 'user', id: agent.id });
    });

    it('updating a kind=spec context emits spec.updated', async () => {
      const client = createClient({
        socketPath: daemon.socketPath,
        autoConnect: false,
        timeout: 5000,
      });
      await client.connect();

      observerMessages.length = 0;

      // Create the node first and wait until the watcher has cached
      // its hash (seen via the spec.created broadcast landing). Without
      // this wait, chokidar can coalesce the create + update into one
      // file-change event — the diff pass then sees "new node with the
      // update's fields" and emits `created` instead of `updated`.
      const node = (await client.createNode({
        type: 'context',
        title: 'Spec to update',
        metadata: { kind: 'spec' },
      } as any)) as any;
      await flush(client);

      const createHit = await waitForMessage(
        observerMessages,
        (m) => m.type === 'spec.created' && m.channel === 'map:tasks',
        10_000,
      );
      expect(createHit).not.toBeNull();

      observerMessages.length = 0;

      // Now update — the watcher's cache has the pre-update hash, so
      // the diff will correctly emit `updated`.
      await client.updateNode(node.id, {
        title: 'Spec to update (revised)',
        archived: false,
      } as any);
      await flush(client);
      client.disconnect();

      const hit = await waitForMessage(
        observerMessages,
        (m) => m.type === 'spec.updated' && m.channel === 'map:tasks',
        10_000,
      );

      expect(hit).not.toBeNull();
      const data = hit!.data as Record<string, unknown>;
      expect(data.spec).toMatchObject({
        id: node.id,
        title: 'Spec to update (revised)',
        metadata: { kind: 'spec' },
      });
    });
  },
);
