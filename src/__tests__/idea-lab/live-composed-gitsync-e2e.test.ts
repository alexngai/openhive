/**
 * Composed live e2e (git-sync-native) — the PRODUCTION-faithful path.
 *
 * The idea-lab's real design: the lab graph is a git-synced task resource; the
 * hub and every role swarm hold a clone; a role agent reads objectives and
 * writes ideas with its NATIVE opentasks tools, and git-sync converges everyone.
 * This test stands that up end-to-end with a real Claude Code + cc-swarm agent:
 *
 *   1. bare git repo = the shared lab-graph remote
 *   2. HUB seeds an objective into its clone → commit → push
 *   3. AGENT workspace = a git-synced clone; a real agent reads the objective
 *      via opentasks and authors a derived idea → git-sync commits + pushes
 *   4. HUB pulls → the agent's idea has converged into the lab graph
 *
 * ── WHY THIS IS GATED SEPARATELY (IDEA_LAB_GITSYNC_E2E=1) ──
 * Unlike the REST composed test (live-composed-rest-e2e.test.ts, which is green
 * anywhere), this path needs the AGENT-SIDE opentasks daemon to actually run
 * with git-sync. That standalone daemon does not start in every environment —
 * it needs HOME/OPENHIVE_HOME set (the production image does this; a bare local
 * checkout often does not), and cc-swarm swallows the failure
 * (`ensureDaemon(config).catch(()=>{})`, opentasks-client `.swarm/opentasks`
 * layout). So this is the DURABLE PRODUCTION ARTIFACT: run it in a
 * daemon-capable environment (CI image / prod). In constrained local envs it
 * will not converge — the composed loop is instead proven there by the REST
 * test, and the git-sync transport itself by git-sync-convergence.test.ts.
 *
 * Gated behind BOTH LIVE_AGENT_TEST=1 (real Claude Code) AND
 * IDEA_LAB_GITSYNC_E2E=1 (explicit opt-in, daemon-capable env). Short /tmp root.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync, execFileSync } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { setupWebSocket, stopHeartbeat } from '../../realtime/index.js';
import { ConfigSchema } from '../../config.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
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
  type GraphStore,
  type IPCServer,
} from 'opentasks';

const LIVE = !!process.env.LIVE_AGENT_TEST;
const OPT_IN = !!process.env.IDEA_LAB_GITSYNC_E2E;
let CLI_AVAILABLE = false;
try {
  execSync('which claude', { stdio: 'ignore' });
  CLI_AVAILABLE = true;
} catch {
  CLI_AVAILABLE = false;
}

const PLUGIN_DIR = path.resolve(__dirname, '..', '..', '..', 'references', 'claude-code-swarm');
const TEST_ROOT = path.join('/tmp', `il-gs-e2e-${process.pid}`);
const DB_PATH = path.join(TEST_ROOT, 'gs.db');
const REMOTE = path.join(TEST_ROOT, 'lab-remote.git');
const HUB = path.join(TEST_ROOT, 'hub'); // hub clone; store files at its root
const SERVER_PORT = 19694;

const READ_TOKEN = 'OBJ_READ_TOKEN_G4K2';
const IDEA_MARKER = 'IDEA_LAB_GITSYNC_OK_M9P1';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** In-process opentasks daemon at `dir` (store files live directly in `dir`). */
async function startDaemon(dir: string): Promise<{ socket: string; stop: () => Promise<void> }> {
  fs.mkdirSync(dir, { recursive: true });
  const socket = path.join(dir, 'daemon.sock');
  const hash = `gs-${path.basename(dir)}`;
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ version: '1.0', location: { hash, uuid: hash, name: 'il' }, daemon: { socketPath: socket } }),
  );
  const jsonlPath = path.join(dir, 'graph.jsonl');
  if (!fs.existsSync(jsonlPath)) fs.writeFileSync(jsonlPath, '');
  const sqlite = createSQLitePersister(dir);
  await sqlite.initialize();
  const jsonl = createJSONLPersister(dir);
  const load = async () => {
    try {
      return fs.existsSync(jsonlPath) ? await jsonl.load() : { nodes: [], edges: [] };
    } catch {
      return { nodes: [], edges: [] };
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const save = async (n: any[], e: any[]) => {
    await jsonl.save(n, e);
  };
  const store: GraphStore = createGraphStore({ basePath: dir, flush: { debounceMs: 50, maxDelayMs: 100 } }, sqlite, load, save);
  await store.initialize();
  const registry = createProviderRegistry();
  registry.register(createNativeProvider(store));
  const providerStore = createProviderAwareStore(store, { registry });
  const flushMgr = createDaemonFlushManager({ debounceMs: 50, maxDelayMs: 100 }, async () => {
    await store.flush();
  });
  const server: IPCServer = createIPCServer(socket);
  const locState = {
    hash,
    opentasksPath: dir,
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
    list: () => [{ hash, opentasksPath: dir, primary: true, healthy: true }],
    has: (h: string) => h === hash,
    add: () => {},
    remove: async () => {},
  };
  registerLifecycleMethods({
    server,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getStatus: () => ({ pid: process.pid, socketPath: socket, uptime: 0, connections: 0 }) as any,
    shutdown: async () => {},
    version: '0.0.8',
    startedAt: new Date(),
  });
  registerGraphMethods({ server, locationResolver: locResolver });
  registerToolsMethods({ server, locationResolver: locResolver });
  await server.start();
  return {
    socket,
    async stop() {
      try {
        await store.flush();
      } catch {
        /* ignore */
      }
      try {
        await server.stop();
      } catch {
        /* ignore */
      }
      try {
        await store.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function runClaude(prompt: string, cwd: string, timeout = 180_000): Promise<{ exitCode: number; stderr: string }> {
  const env = { ...process.env } as Record<string, string>;
  for (const k of Object.keys(env)) {
    if (['CLAUDECODE', 'CLAUDE_CODE_', 'CLAUDE_SESSION', 'CLAUDE_CONVERSATION'].some((p) => k.startsWith(p))) delete env[k];
  }
  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--plugin-dir',
    PLUGIN_DIR,
    '--model',
    process.env.E2E_MODEL || 'sonnet',
    '--max-turns',
    '20',
    '--no-session-persistence',
    '--dangerously-skip-permissions',
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    const err: Buffer[] = [];
    let killed = false;
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: killed ? 143 : code || 0, stderr: Buffer.concat(err).toString('utf-8') });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stderr: e.message });
    });
  });
}

describe.skipIf(!LIVE || !OPT_IN || !CLI_AVAILABLE)(
  'Composed live e2e (git-sync-native) — agent reads objective + writes idea via git-synced opentasks',
  { timeout: 420_000 },
  () => {
    let app: FastifyInstance;
    let agentFull: unknown;
    let ingestToken: string;
    let workspaceDir: string;

    beforeAll(async () => {
      fs.mkdirSync(TEST_ROOT, { recursive: true });
      initDatabase(DB_PATH);
      const a = await agentsDAL.createAgent({ name: 'il-gs-owner', is_admin: true });
      agentFull = a.agent;
      ingestToken = createIngestKey(a.agent.id, { label: 'gs', agent_id: a.agent.id }).plaintext_key;

      // ── 1. Shared lab-graph remote.
      execFileSync('git', ['init', '--bare', REMOTE], { env: GIT_ENV, stdio: 'pipe' });

      // ── 2. HUB seeds an objective (store files at clone root) → push.
      execFileSync('git', ['clone', REMOTE, HUB], { env: GIT_ENV, stdio: 'pipe' });
      const hub = await startDaemon(HUB);
      await daemonCreateSpec(
        hub.socket,
        { title: `Objective Alpha [${READ_TOKEN}]`, content: 'north-star', metadata: { idealab_key: 'objective:alpha', idealab: { tier: 'anchored' } } },
        HUB,
      );
      await hub.stop();
      git(HUB, 'add', 'graph.jsonl', 'config.json');
      git(HUB, 'commit', '-m', 'hub: seed objective');
      git(HUB, 'branch', '-M', 'main');
      git(HUB, 'push', '-u', 'origin', 'main');
      git(REMOTE, 'symbolic-ref', 'HEAD', 'refs/heads/main');

      // ── 3. Hub server (so the agent's cc-swarm sidecar can connect).
      const config = ConfigSchema.parse({
        port: SERVER_PORT,
        host: '127.0.0.1',
        database: DB_PATH,
        instance: { name: 'Idea-Lab git-sync composed E2E' },
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
      setLocalAgent(agentFull as never);
      await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });

      // ── 4. Agent workspace: cc-swarm's opentasks location (.swarm/opentasks)
      // IS a git-synced clone of the lab remote. cc-swarm's socket discovery
      // uses `.swarm/opentasks/daemon.sock`; git-sync converges it with the hub.
      workspaceDir = fs.mkdtempSync(path.join('/tmp', 'il-gs-ws-'));
      execSync('git init -q', { cwd: workspaceDir, stdio: 'ignore' });
      execSync('git config user.email t@t && git config user.name t', { cwd: workspaceDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# idea-lab role agent\n');

      const swarmDir = path.join(workspaceDir, '.swarm');
      fs.mkdirSync(swarmDir, { recursive: true });
      execFileSync('git', ['clone', REMOTE, path.join(swarmDir, 'opentasks')], { env: GIT_ENV, stdio: 'pipe' });
      // Enable git-sync on the cloned opentasks location (flat layout).
      const otConfigPath = path.join(swarmDir, 'opentasks', 'config.json');
      const otConfig = JSON.parse(fs.readFileSync(otConfigPath, 'utf-8'));
      otConfig.sync = { git: { enabled: true, remote: 'origin', autoCommit: true, autoPush: true, pullOnStartup: true } };
      fs.writeFileSync(otConfigPath, JSON.stringify(otConfig, null, 2));

      const pluginCfgDir = path.join(swarmDir, 'claude-swarm');
      fs.mkdirSync(pluginCfgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginCfgDir, 'config.json'),
        JSON.stringify({
          template: 'gsd',
          map: { enabled: true, server: `ws://127.0.0.1:${SERVER_PORT}/ws/map`, sidecar: 'session', auth: { token: ingestToken, param: 'token' } },
          opentasks: { enabled: true, autoStart: true },
        }),
      );
    }, 90_000);

    afterAll(async () => {
      stopMapWebSocket();
      stopHeartbeat();
      await app?.close();
      await sleep(200);
      try {
        closeDatabase();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }, 20_000);

    it('agent reads the objective and its idea converges back into the hub lab graph', async () => {
      const prompt = [
        'You are the ideator role in an idea lab. Your tasks live in an opentasks graph.',
        'STEP 1: list the current tasks/contexts. There is an objective whose title contains a',
        'bracketed token like [OBJ_READ_TOKEN_XXXX]. Note that exact token.',
        `STEP 2: create ONE new task (a derived idea). Its title MUST contain BOTH the exact token`,
        `you found AND the literal marker ${IDEA_MARKER}. For example a title like`,
        `"Idea from [<TOKEN>] ${IDEA_MARKER}". Do nothing else.`,
      ].join('\n');

      const run = await runClaude(prompt, workspaceDir, 180_000);
      console.log(`[il-gs] claude exit=${run.exitCode}`);
      if (run.stderr) console.log(`[il-gs] stderr: ${run.stderr.slice(-400)}`);

      // Give git-sync time to auto-commit + push, then converge on the hub.
      await sleep(4000);
      git(HUB, 'pull', 'origin', 'main');
      const hub = await startDaemon(HUB); // fresh store loads the pulled graph.jsonl
      const graph = await daemonGetGraph(hub.socket, HUB, { includeArchived: true });
      await hub.stop();

      const titles = graph.nodes.map((n) => String(n.title ?? ''));
      console.log(`[il-gs] hub graph titles after pull: ${JSON.stringify(titles)}`);

      const idea = graph.nodes.find((n) => String(n.title ?? '').includes(IDEA_MARKER));
      expect(idea, 'agent-authored idea should have converged into the hub lab graph').toBeTruthy();
      expect(
        String(idea!.title).includes(READ_TOKEN),
        'the idea must echo the objective read-token (proves the agent read the shared objective)',
      ).toBe(true);
    });
  },
);
