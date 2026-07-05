/**
 * Validates the load-bearing idea-lab mechanism: a git-synced OpenTasks lab
 * graph shared between the hub and a swarm, where ideas authored on one side
 * converge to the other and back.
 *
 * The real path (traced in src/idea-lab/CLAUDE.md): the lab graph is a
 * git-backed task resource; the hub and every subscribed swarm hold a clone;
 * the opentasks daemon auto-commits/pushes writes and pulls peers' changes
 * (pullOnStartup + reconcile-on-reload). This test stands that up concretely:
 *
 *   1. A bare git repo = the shared remote (the "test repo" / source of truth).
 *   2. A HUB clone authors two objectives → commit → push.
 *   3. An AGENT clone (a fresh swarm) pulls → READS the hub's objectives →
 *      authors a derived idea → commit → push.
 *   4. The HUB pulls → READS the agent's idea.
 *
 * Reads/writes go through the real opentasks daemon client
 * (daemonCreateSpec / daemonGetGraph) against an in-process IPC server bound to
 * each clone's socket — the same proven pattern as
 * provision-objectives-daemon.test.ts (the standalone daemon subprocess is
 * unreliable outside the production image). A fresh store per phase faithfully
 * simulates the daemon's pull-then-reload, since store.initialize() treats
 * graph.jsonl as the source of truth (opentasks graph/store.ts).
 *
 * Short /tmp root — macOS caps Unix socket paths at ~104 bytes.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { daemonCreateSpec, daemonGetGraph } from '../../map/task-daemon-client.js';
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
} from 'opentasks';

const ROOT = path.join('/tmp', `il-gitsync-${process.pid}`);
const REMOTE = path.join(ROOT, 'remote.git');
const HUB = path.join(ROOT, 'hub');
const AGENT = path.join(ROOT, 'agent');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'idea-lab-test',
  GIT_AUTHOR_EMAIL: 'test@idea-lab',
  GIT_COMMITTER_NAME: 'idea-lab-test',
  GIT_COMMITTER_EMAIL: 'test@idea-lab',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString();
}

interface Location {
  socket: string;
  otDir: string;
  stop: () => Promise<void>;
}

/**
 * Stand up an in-process opentasks daemon bound to `<otDir>/daemon.sock`,
 * preserving any existing graph.jsonl (so a cloned/pulled graph is read, not
 * clobbered). Returns a handle; `stop()` flushes graph.jsonl to disk.
 */
async function startLocation(otDir: string): Promise<Location> {
  fs.mkdirSync(otDir, { recursive: true });
  const socketPath = path.join(otDir, 'daemon.sock');
  const locationHash = `loc-${path.basename(path.dirname(otDir))}`;
  fs.writeFileSync(
    path.join(otDir, 'config.json'),
    JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: 'il' },
      daemon: { socketPath },
    }),
  );
  const jsonlPath = path.join(otDir, 'graph.jsonl');
  if (!fs.existsSync(jsonlPath)) fs.writeFileSync(jsonlPath, ''); // preserve pulled graph

  const sqlite = createSQLitePersister(otDir);
  await sqlite.initialize();
  const jsonl = createJSONLPersister(otDir);
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
  const store = createGraphStore(
    { basePath: otDir, flush: { debounceMs: 50, maxDelayMs: 100 } },
    sqlite,
    jsonlLoad,
    jsonlSave,
  );
  await store.initialize();

  const nativeProvider = createNativeProvider(store);
  const registry = createProviderRegistry();
  registry.register(nativeProvider);
  const providerStore = createProviderAwareStore(store, { registry });
  const flushMgr = createDaemonFlushManager({ debounceMs: 50, maxDelayMs: 100 }, async () => {
    await store.flush();
  });
  const server = createIPCServer(socketPath);
  const locState = {
    hash: locationHash,
    opentasksPath: otDir,
    store,
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
    list: () => [{ hash: locationHash, opentasksPath: otDir, primary: true, healthy: true }],
    has: (h: string) => h === locationHash,
    add: () => {},
    remove: async () => {},
  };
  registerLifecycleMethods({
    server,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getStatus: () => ({ pid: process.pid, socketPath, uptime: 0, connections: 0 }) as any,
    shutdown: async () => {},
    version: '0.0.8',
    startedAt: new Date(),
  });
  registerGraphMethods({ server, locationResolver: locResolver });
  registerToolsMethods({ server, locationResolver: locResolver });
  await server.start();

  return {
    socket: socketPath,
    otDir,
    async stop() {
      try {
        await store.flush();
      } catch {
        /* best effort */
      }
      try {
        await server.stop();
      } catch {
        /* best effort */
      }
      try {
        await store.close();
      } catch {
        /* best effort */
      }
    },
  };
}

/** idealab_keys of the spec nodes currently in a location's graph, sorted. */
async function ideaKeys(loc: Location): Promise<string[]> {
  const graph = await daemonGetGraph(loc.socket, loc.otDir, { includeArchived: true });
  return graph.nodes
    .map((n) => (n.metadata as Record<string, unknown> | undefined)?.idealab_key)
    .filter((k): k is string => typeof k === 'string')
    .sort();
}

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('idea-lab git-synced shared graph', () => {
  it('objectives authored on the hub converge to an agent, and the idea back', async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });

    // ── 1. The shared remote — a bare repo is the source of truth.
    execFileSync('git', ['init', '--bare', REMOTE], { env: GIT_ENV, stdio: 'pipe' });

    // ── 2. HUB clone authors two objectives, commits, pushes.
    execFileSync('git', ['clone', REMOTE, HUB], { env: GIT_ENV, stdio: 'pipe' });
    const hubOt = path.join(HUB, '.opentasks');
    let hub = await startLocation(hubOt);
    await daemonCreateSpec(
      hub.socket,
      { title: 'Objective Alpha', content: 'north-star one', metadata: { idealab_key: 'objective:alpha', idealab: { tier: 'anchored' } } },
      hubOt,
    );
    await daemonCreateSpec(
      hub.socket,
      { title: 'Objective Beta', content: 'north-star two', metadata: { idealab_key: 'objective:beta', idealab: { tier: 'anchored' } } },
      hubOt,
    );
    await hub.stop();
    expect(fs.statSync(path.join(hubOt, 'graph.jsonl')).size).toBeGreaterThan(0);

    git(HUB, 'add', '.opentasks/graph.jsonl');
    git(HUB, 'commit', '-m', 'hub: seed objectives');
    git(HUB, 'branch', '-M', 'main');
    git(HUB, 'push', '-u', 'origin', 'main');
    // Point the bare remote's HEAD at main so a fresh clone checks it out.
    git(REMOTE, 'symbolic-ref', 'HEAD', 'refs/heads/main');

    // ── 3. AGENT clone (a fresh swarm) pulls, READS the objectives, authors
    // a derived idea, commits, pushes.
    execFileSync('git', ['clone', REMOTE, AGENT], { env: GIT_ENV, stdio: 'pipe' });
    const agentOt = path.join(AGENT, '.opentasks');
    const agent = await startLocation(agentOt);

    const agentSees = await ideaKeys(agent);
    expect(agentSees, 'agent should read the hub-authored objectives').toEqual([
      'objective:alpha',
      'objective:beta',
    ]);

    await daemonCreateSpec(
      agent.socket,
      {
        title: 'Idea derived from Alpha',
        content: 'a novel direction advancing objective alpha',
        metadata: { idealab_key: 'idea:001', idealab: { tier: 'anchored', derived_from: 'objective:alpha' } },
      },
      agentOt,
    );
    await agent.stop();

    git(AGENT, 'add', '.opentasks/graph.jsonl');
    git(AGENT, 'commit', '-m', 'agent: author derived idea');
    git(AGENT, 'push', 'origin', 'main');

    // ── 4. HUB pulls → READS the agent's idea (plus its own objectives).
    git(HUB, 'pull', 'origin', 'main');
    hub = await startLocation(hubOt); // fresh store → loads updated graph.jsonl
    const hubSees = await ideaKeys(hub);
    await hub.stop();

    expect(hubSees, 'hub should read the agent-authored idea after pull').toEqual([
      'idea:001',
      'objective:alpha',
      'objective:beta',
    ]);
  }, 60_000);
});
