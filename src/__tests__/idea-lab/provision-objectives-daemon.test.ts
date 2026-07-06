/**
 * Idea-lab objective seeding through a real OpenTasks graph store.
 *
 * The fast provision.test.ts is deliberately daemon-free (empty objectives).
 * This test closes that gap: it drives `provisionIdeaLab` with real
 * objectives, which authors them as spec nodes via `daemonCreateSpec`, reads
 * them back with `daemonGetGraph`, and proves create-only idempotency (provision
 * twice → no duplicate specs).
 *
 * The standalone `opentasks daemon start` subprocess is unreliable outside the
 * production image (it needs HOME/OPENHIVE_HOME to survive), so — exactly like
 * opentasks-daemon-integration.test.ts — we hand-build an in-process IPC server
 * bound to the socket path `provisionIdeaLab` resolves. `withDaemon` then finds
 * it already alive and REUSES it instead of spawning the flaky subprocess, so
 * the real daemonCreateSpec/daemonGetGraph client paths are exercised end-to-end.
 *
 * Short /tmp root — macOS caps Unix socket paths at ~104 bytes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { provisionIdeaLab, parseIdeaLabPack, objectiveKey } from '../../idea-lab/index.js';
import { resolveDaemonSocket, daemonGetGraph } from '../../map/task-daemon-client.js';
import {
  createGraphStore,
  createIPCServer,
  createDaemonFlushManager,
  registerToolsMethods,
  registerGraphMethods,
  registerLifecycleMethods,
  createSQLitePersister,
  createJSONLPersister,
  createNativeProvider,
  createProviderAwareStore,
  createProviderRegistry,
  type GraphStore,
  type IPCServer,
} from 'opentasks';

// Short path — macOS 104-byte Unix socket limit.
const ROOT = path.join('/tmp', `il-obj-${process.pid}`);
const DB_PATH = path.join(ROOT, 'il-obj.db');
const GRAPH_DIR = path.join(ROOT, 'idea-lab', '.opentasks');

const silent = { info: () => {}, warn: () => {} };

let otStore: GraphStore;
let otServer: IPCServer;

const PACK = parseIdeaLabPack({
  version: 1,
  graph: { name: 'idea-lab/graph' },
  ledger: { name: 'idea-lab/ledger' },
  objectives: [
    { key: 'alpha', title: 'Objective Alpha', content: 'first north-star', priority: 3 },
    { key: 'beta', title: 'Objective Beta', content: 'second north-star', priority: 2 },
  ],
  roles: [{ key: 'ideator', cron: '0 * * * *', prompt: 'ideator prompt' }],
});

async function labSpecNodes(): Promise<Record<string, unknown>[]> {
  const socket = resolveDaemonSocket(GRAPH_DIR);
  const graph = await daemonGetGraph(socket, GRAPH_DIR, { includeArchived: true });
  return graph.nodes.filter((n) => {
    const meta = (n.metadata ?? {}) as Record<string, unknown>;
    return typeof meta.idealab_key === 'string';
  });
}

beforeAll(async () => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* fresh */
  }
  // Pre-build the .opentasks store + config so provisionIdeaLab's
  // ensureInitialized() is a no-op and resolveDaemonSocket() returns our socket.
  fs.mkdirSync(GRAPH_DIR, { recursive: true });
  const socketPath = path.join(GRAPH_DIR, 'daemon.sock');
  const locationHash = `il-obj-${process.pid}`;
  fs.writeFileSync(
    path.join(GRAPH_DIR, 'config.json'),
    JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: 'il-obj' },
      daemon: { socketPath },
    }),
  );
  const jsonlPath = path.join(GRAPH_DIR, 'graph.jsonl');
  fs.writeFileSync(jsonlPath, '');

  const sqlite = createSQLitePersister(GRAPH_DIR);
  await sqlite.initialize();
  const jsonl = createJSONLPersister(GRAPH_DIR);
  const jsonlLoad = async () => {
    try {
      return fs.existsSync(jsonlPath) ? await jsonl.load() : { nodes: [], edges: [] };
    } catch {
      return { nodes: [], edges: [] };
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonlSave = async (n: any[], e: any[]) => {
    await jsonl.save(n, e);
  };

  otStore = createGraphStore(
    { basePath: GRAPH_DIR, flush: { debounceMs: 50, maxDelayMs: 100 } },
    sqlite,
    jsonlLoad,
    jsonlSave,
  );
  await otStore.initialize();

  const nativeProvider = createNativeProvider(otStore);
  const registry = createProviderRegistry();
  registry.register(nativeProvider);
  const providerStore = createProviderAwareStore(otStore, { registry });
  const flushMgr = createDaemonFlushManager({ debounceMs: 50, maxDelayMs: 100 }, async () => {
    await otStore.flush();
  });
  otServer = createIPCServer(socketPath);
  const locState = {
    hash: locationHash,
    opentasksPath: GRAPH_DIR,
    store: otStore,
    providerStore,
    flushManager: flushMgr,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    watcher: null as any,
    primary: true,
    healthy: true,
  };
  const locResolver = {
    resolve: () => locState,
    getDefault: () => locState,
    list: () => [{ hash: locationHash, opentasksPath: GRAPH_DIR, primary: true, healthy: true }],
    has: (h: string) => h === locationHash,
    add: () => {},
    remove: async () => {},
  };
  registerLifecycleMethods({
    server: otServer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getStatus: () => ({ pid: process.pid, socketPath, uptime: 0, connections: 0 }) as any,
    shutdown: async () => {},
    version: '0.0.8',
    startedAt: new Date(),
  });
  registerGraphMethods({ server: otServer, locationResolver: locResolver });
  registerToolsMethods({ server: otServer, locationResolver: locResolver });
  await otServer.start();

  initDatabase(DB_PATH);
  await agentsDAL.createAgent({ name: 'il-obj-owner', is_admin: true });
}, 30_000);

afterAll(async () => {
  try {
    await otServer?.stop();
  } catch {
    /* best effort */
  }
  try {
    await otStore?.close();
  } catch {
    /* best effort */
  }
  try {
    closeDatabase();
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}, 15_000);

describe('provisionIdeaLab objective seeding (real OpenTasks graph store)', () => {
  it('authors objectives as spec nodes and reconciles them create-only', async () => {
    // ── First provision: authors both objectives through the daemon client.
    const first = await provisionIdeaLab({
      dataDir: ROOT,
      pack: PACK,
      targetSwarmIds: [],
      logger: silent,
    });
    expect(first.ok).toBe(true);
    expect(first.objectives.created).toBe(2);
    expect(first.objectives.existing).toBe(0);

    // ── Read the specs back out of the graph via the daemon.
    const nodes = await labSpecNodes();
    expect(nodes).toHaveLength(2);

    const byKey = new Map<string, Record<string, unknown>>();
    for (const n of nodes) {
      const meta = n.metadata as Record<string, unknown>;
      byKey.set(meta.idealab_key as string, n);
    }
    const alpha = byKey.get(objectiveKey('alpha'));
    const beta = byKey.get(objectiveKey('beta'));
    expect(alpha).toBeTruthy();
    expect(beta).toBeTruthy();
    expect(alpha!.title).toBe('Objective Alpha');
    expect(beta!.title).toBe('Objective Beta');

    // Spec marker + idea-lab metadata survived the round-trip.
    const alphaMeta = alpha!.metadata as Record<string, unknown>;
    expect(alphaMeta.kind).toBe('spec');
    expect((alphaMeta.idealab as Record<string, unknown>)?.tier).toBe('anchored');

    // ── Second provision: create-only reconcile — nothing new, no dupes.
    const second = await provisionIdeaLab({
      dataDir: ROOT,
      pack: PACK,
      targetSwarmIds: [],
      logger: silent,
    });
    expect(second.objectives.created).toBe(0);
    expect(second.objectives.existing).toBe(2);

    const afterSecond = await labSpecNodes();
    expect(afterSecond).toHaveLength(2); // no duplicate specs authored
  }, 60_000);
});
