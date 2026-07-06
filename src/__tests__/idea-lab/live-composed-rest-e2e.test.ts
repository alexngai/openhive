/**
 * Composed live e2e (REST interface) — the full idea-lab loop with a REAL agent,
 * green in this environment.
 *
 * A real Claude Code session reads a hub-authored objective out of the shared
 * lab graph and writes a derived idea back into it, both over the hub's
 * opentasks REST interface (`/resources/:id/content/opentasks/{graph,tasks}`),
 * which runs against the hub's working in-process daemon. This composes every
 * link with a live agent: read a shared objective → reason → write a shared idea
 * → the hub sees it.
 *
 * Proof of READ + WRITE without trusting the model's narration: the objective's
 * title carries a random read-token; the agent is told to echo that exact token
 * (plus a fixed marker) into the idea it authors. The assertion requires a node
 * in the hub graph carrying BOTH — so the agent must have actually read the
 * objective and written the idea.
 *
 * This uses the REST agent-interface (one of the three real paths). The
 * git-sync-native interface is exercised by live-composed-gitsync-e2e.test.ts.
 *
 * Gated behind LIVE_AGENT_TEST=1 (real Claude Code CLI + LLM calls).
 * Short /tmp root — macOS Unix-socket length cap.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { setupWebSocket, stopHeartbeat } from '../../realtime/index.js';
import { ConfigSchema } from '../../config.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
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
let CLI_AVAILABLE = false;
try {
  execSync('which claude', { stdio: 'ignore' });
  CLI_AVAILABLE = true;
} catch {
  CLI_AVAILABLE = false;
}

const TEST_ROOT = path.join('/tmp', `il-rest-${process.pid}`);
const DB_PATH = path.join(TEST_ROOT, 'rest.db');
const LAB_OT_DIR = path.join(TEST_ROOT, 'lab', '.opentasks');
const SERVER_PORT = 19684;

// Random-ish token embedded in the objective; the agent must echo it back to
// prove it read the objective. Fixed marker proves it authored the idea.
const READ_TOKEN = 'OBJ_READ_TOKEN_A7F3';
const IDEA_MARKER = 'IDEA_LAB_REST_OK_Q7R2';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseStreamJson(stdout: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      messages.push(JSON.parse(t));
    } catch {
      /* skip non-json lines */
    }
  }
  return messages;
}

function toolNames(messages: Array<Record<string, unknown>>): string[] {
  const names: string[] = [];
  for (const msg of messages) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (msg as any).message?.content ?? (msg as any).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use') names.push(block.name);
      }
    }
  }
  return names;
}

function runClaude(
  prompt: string,
  opts: { cwd: string; timeout?: number },
): Promise<{ messages: Array<Record<string, unknown>>; exitCode: number; stdout: string; stderr: string }> {
  const { cwd, timeout = 150_000 } = opts;
  const env = { ...process.env } as Record<string, string>;
  for (const k of Object.keys(env)) {
    if (['CLAUDECODE', 'CLAUDE_CODE_', 'CLAUDE_SESSION', 'CLAUDE_CONVERSATION'].some((p) => k.startsWith(p))) {
      delete env[k];
    }
  }
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    process.env.E2E_MODEL || 'sonnet',
    '--max-turns',
    '12',
    '--no-session-persistence',
    '--dangerously-skip-permissions',
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let killed = false;
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf-8');
      resolve({
        messages: parseStreamJson(stdout),
        exitCode: killed ? 143 : code || 0,
        stdout,
        stderr: Buffer.concat(err).toString('utf-8'),
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ messages: [], exitCode: 1, stdout: '', stderr: e.message });
    });
  });
}

describe.skipIf(!LIVE || !CLI_AVAILABLE)(
  'Composed live e2e (REST) — agent reads objective + writes idea into the shared lab graph',
  { timeout: 300_000 },
  () => {
    let app: FastifyInstance;
    let otStore: GraphStore;
    let otServer: IPCServer;
    let labSocket: string;
    let resourceId: string;
    let agentFull: unknown;
    let workspaceDir: string;

    beforeAll(async () => {
      fs.mkdirSync(LAB_OT_DIR, { recursive: true });
      initDatabase(DB_PATH);
      const a = await agentsDAL.createAgent({ name: 'il-rest-owner', is_admin: true });
      agentFull = a.agent;

      // ── In-process opentasks daemon for the lab graph.
      labSocket = path.join(LAB_OT_DIR, 'daemon.sock');
      const locationHash = `il-rest-${process.pid}`;
      fs.writeFileSync(
        path.join(LAB_OT_DIR, 'config.json'),
        JSON.stringify({
          version: '1.0',
          location: { hash: locationHash, uuid: locationHash, name: 'idea-lab' },
          daemon: { socketPath: labSocket },
        }),
      );
      fs.writeFileSync(path.join(LAB_OT_DIR, 'graph.jsonl'), '');
      const sqlite = createSQLitePersister(LAB_OT_DIR);
      await sqlite.initialize();
      const jsonl = createJSONLPersister(LAB_OT_DIR);
      const jsonlPath = path.join(LAB_OT_DIR, 'graph.jsonl');
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
        { basePath: LAB_OT_DIR, flush: { debounceMs: 50, maxDelayMs: 100 } },
        sqlite,
        jsonlLoad,
        jsonlSave,
      );
      await otStore.initialize();
      const registry = createProviderRegistry();
      registry.register(createNativeProvider(otStore));
      const providerStore = createProviderAwareStore(otStore, { registry });
      const flushMgr = createDaemonFlushManager({ debounceMs: 50, maxDelayMs: 100 }, async () => {
        await otStore.flush();
      });
      otServer = createIPCServer(labSocket);
      const locState = {
        hash: locationHash,
        opentasksPath: LAB_OT_DIR,
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
        list: () => [{ hash: locationHash, opentasksPath: LAB_OT_DIR, primary: true, healthy: true }],
        has: (h: string) => h === locationHash,
        add: () => {},
        remove: async () => {},
      };
      registerLifecycleMethods({
        server: otServer,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getStatus: () => ({ pid: process.pid, socketPath: labSocket, uptime: 0, connections: 0 }) as any,
        shutdown: async () => {},
        version: '0.0.8',
        startedAt: new Date(),
      });
      registerGraphMethods({ server: otServer, locationResolver: locResolver });
      registerToolsMethods({ server: otServer, locationResolver: locResolver });
      await otServer.start();

      // ── Register the lab graph as a (local, writable) task resource.
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'idea-lab/graph',
        description: 'Idea-lab graph (REST composed e2e)',
        git_remote_url: LAB_OT_DIR,
        visibility: 'public',
        owner_agent_id: (agentFull as { id: string }).id,
        sync_strategy: 'local',
        local_path: LAB_OT_DIR,
        metadata: { opentasks: true, idea_lab: true, location_hash: locationHash },
      });
      resourceId = resource.id;

      // ── Seed one objective carrying the read-token.
      await daemonCreateSpec(
        labSocket,
        {
          title: `Objective Alpha [${READ_TOKEN}]`,
          content: 'north-star the anchored tier must advance',
          metadata: { idealab_key: 'objective:alpha', idealab: { tier: 'anchored' } },
        },
        LAB_OT_DIR,
      );

      // ── Hub server.
      const config = ConfigSchema.parse({
        port: SERVER_PORT,
        host: '127.0.0.1',
        database: DB_PATH,
        instance: { name: 'Idea-Lab REST Composed E2E' },
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
      setLocalAgent(agentFull as never); // local mode → agent's curl auto-authed
      await app.register(
        async (api) => {
          await api.register(resourceContentRoutes, { config });
        },
        { prefix: '/api/v1' },
      );
      await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });

      workspaceDir = fs.mkdtempSync(path.join('/tmp', 'il-rest-ws-'));
    }, 60_000);

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
      stopMapWebSocket();
      stopHeartbeat();
      await app?.close();
      await sleep(200);
      try {
        closeDatabase();
      } catch {
        /* best effort */
      }
      try {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }, 15_000);

    it('reads the hub objective and writes a derived idea back into the shared graph', async () => {
      const base = `http://127.0.0.1:${SERVER_PORT}/api/v1/resources/${resourceId}/content/opentasks`;
      const prompt = [
        'You are validating an idea lab over its HTTP API. Use Bash + curl. Do EXACTLY these two steps.',
        '',
        'STEP 1 — read the current objectives:',
        `  curl -s ${base}/graph`,
        'The JSON response has a "nodes" array. Find the node whose title starts with "Objective".',
        'Its title contains a bracketed token like [OBJ_READ_TOKEN_XXXX]. Note that exact token.',
        '',
        'STEP 2 — author ONE derived idea by POSTing a task. Its title MUST contain BOTH the exact',
        `bracketed token you found in step 1 AND the literal marker ${IDEA_MARKER}:`,
        `  curl -s -X POST ${base}/tasks -H 'Content-Type: application/json' \\`,
        `    -d '{"title":"Idea derived from the objective [<TOKEN>] ${IDEA_MARKER}","description":"a novel direction"}'`,
        '',
        'Replace <TOKEN> with the actual token you read in step 1. Do nothing else.',
      ].join('\n');

      const run = await runClaude(prompt, { cwd: workspaceDir, timeout: 150_000 });
      console.log(`[il-rest] exit=${run.exitCode} tools=${toolNames(run.messages).join(',')}`);
      if (run.stderr) console.log(`[il-rest] stderr: ${run.stderr.slice(-500)}`);

      // ── Read the shared graph back and look for the agent-authored idea.
      const graph = await daemonGetGraph(labSocket, LAB_OT_DIR, { includeArchived: true });
      const titles = graph.nodes.map((n) => String(n.title ?? ''));
      console.log(`[il-rest] graph titles: ${JSON.stringify(titles)}`);

      const ideaNode = graph.nodes.find((n) => {
        const t = String(n.title ?? '');
        return t.includes(IDEA_MARKER);
      });

      // The idea exists → agent WROTE into the shared graph.
      expect(ideaNode, 'agent should have authored an idea node with the marker').toBeTruthy();
      // The idea carries the objective's read-token → agent READ the objective first.
      expect(
        String(ideaNode!.title).includes(READ_TOKEN),
        'the authored idea must echo the objective read-token (proves the agent read the objective)',
      ).toBe(true);
      // And it is a distinct node from the objective.
      expect(String(ideaNode!.title).startsWith('Objective')).toBe(false);
    });
  },
);
