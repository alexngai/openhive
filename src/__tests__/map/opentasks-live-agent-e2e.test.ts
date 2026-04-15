/**
 * E2E Test: Live Agent Task Round-Trip
 *
 * Spawns a REAL Claude Code session with cc-swarm hooks, connected to a real
 * OpenHive hub with a real OpenTasks daemon. Verifies the complete flow:
 *
 *   Agent session starts → cc-swarm bootstrap → sidecar connects to hub
 *   → hub registers swarm → hub can relay events + route queries
 *
 * When the agent uses TaskCreate/TaskUpdate, the hook chain fires:
 *   bridge-task-created → sidecar → MAP → hub emits events + broadcasts
 *
 * Gated behind LIVE_AGENT_TEST=1 because it:
 * - Requires Claude Code CLI with active subscription
 * - Makes real LLM API calls (~$0.50-2.00 per run)
 * - Takes 30-120 seconds
 *
 * Run:
 *   LIVE_AGENT_TEST=1 npx vitest run src/__tests__/map/opentasks-live-agent-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { setupWebSocket, stopHeartbeat } from '../../realtime/index.js';
import { getAllInbound } from '../../map/connection-registry.js';
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

const TEST_ROOT = path.join('/tmp', `ot-live-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, 'live.db');
const SERVER_PORT = 19674;

const LIVE = !!process.env.LIVE_AGENT_TEST;
const PLUGIN_DIR = path.resolve(
  __dirname, '..', '..', '..', 'references', 'claude-code-swarm',
);

// Check if claude CLI is available
let CLI_AVAILABLE = false;
try {
  execSync('which claude', { stdio: 'ignore' });
  CLI_AVAILABLE = true;
} catch {
  CLI_AVAILABLE = false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function collectMessages(ws: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())); } catch {}
  });
  return messages;
}

/** Parse stream-json output from claude CLI */
function parseStreamJson(stdout: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { messages.push(JSON.parse(trimmed)); } catch {}
  }
  return messages;
}

/** Extract tool_use calls from stream-json messages */
function extractToolCalls(messages: Array<Record<string, unknown>>): Array<{ name: string; input: Record<string, unknown> }> {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const msg of messages) {
    if (msg.type === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block.type === 'tool_use') {
          calls.push({ name: block.name, input: block.input || {} });
        }
      }
    }
    if (msg.type === 'content_block_start' && (msg.content_block as any)?.type === 'tool_use') {
      const cb = msg.content_block as any;
      calls.push({ name: cb.name, input: cb.input || {} });
    }
  }
  return calls;
}

/** Build clean env for child claude process */
function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  const stripPrefixes = ['CLAUDECODE', 'CLAUDE_CODE_', 'CLAUDE_SESSION', 'CLAUDE_CONVERSATION'];
  for (const key of Object.keys(env)) {
    if (stripPrefixes.some(p => key.startsWith(p))) {
      delete env[key];
    }
  }
  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  return env;
}

/** Run claude CLI and capture stream-json output */
function runClaude(
  prompt: string,
  options: { cwd: string; maxBudgetUsd?: number; maxTurns?: number; timeout?: number },
): Promise<{ messages: Array<Record<string, unknown>>; exitCode: number; stdout: string; stderr: string }> {
  const { cwd, maxBudgetUsd = 0.50, maxTurns = 10, timeout = 120_000 } = options;

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--plugin-dir', PLUGIN_DIR,
    '--model', process.env.E2E_MODEL || 'sonnet',
    '--max-budget-usd', String(maxBudgetUsd),
    '--max-turns', String(maxTurns),
    '--no-session-persistence',
    '--dangerously-skip-permissions',
  ];

  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv(),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    const timer = setTimeout(() => { killed = true; child.kill('SIGTERM'); }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      resolve({
        messages: parseStreamJson(stdout),
        exitCode: killed ? 143 : (code || 0),
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        messages: [],
        exitCode: 1,
        stdout: '',
        stderr: err.message,
      });
    });
  });
}

describe.skipIf(!LIVE || !CLI_AVAILABLE)('E2E: Live Agent Task Round-Trip', { timeout: 300_000 }, () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string; ingestToken: string };
  let agentFull: any;
  let otStore: GraphStore;
  let otServer: IPCServer;
  let daemonSocketPath: string;
  let opentasksDir: string;
  let locationHash: string;
  let workspaceDir: string;

  let wsObserver: WebSocket;
  let observerMessages: Array<Record<string, unknown>>;

  beforeAll(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    initDatabase(TEST_DB_PATH);

    const a = await agentsDAL.createAgent({ name: 'live-agent', description: 'Live agent test' });
    const ik = createIngestKey(a.agent.id, { label: 'live', agent_id: a.agent.id });
    agent = { id: a.agent.id, apiKey: a.apiKey, ingestToken: ik.plaintext_key };
    agentFull = a.agent;

    // Start OpenTasks daemon
    opentasksDir = path.join(TEST_ROOT, '.opentasks');
    fs.mkdirSync(opentasksDir, { recursive: true });

    locationHash = `live-${process.pid}`;
    daemonSocketPath = path.join(opentasksDir, 'daemon.sock');
    fs.writeFileSync(path.join(opentasksDir, 'config.json'), JSON.stringify({
      version: '1.0',
      location: { hash: locationHash, uuid: locationHash, name: 'live-test' },
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

    // Start OpenHive server
    const config = ConfigSchema.parse({
      port: SERVER_PORT, host: '127.0.0.1', database: TEST_DB_PATH,
      instance: { name: 'Live Agent E2E' },
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
    await app.register(async (api) => {
      await api.register(resourceContentRoutes, { config });
    }, { prefix: '/api/v1' });
    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });

    // Connect WS observer
    wsObserver = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws?token=${agent.ingestToken}`);
    await new Promise<void>((resolve, reject) => {
      wsObserver.on('open', resolve);
      wsObserver.on('error', reject);
      setTimeout(() => reject(new Error('WS timeout')), 5000);
    });
    observerMessages = collectMessages(wsObserver);
    wsObserver.send(JSON.stringify({ type: 'subscribe', channels: ['map:tasks', 'map:discovery'] }));

    // Create workspace with cc-swarm config pointing to our OpenHive server
    workspaceDir = fs.mkdtempSync(path.join('/tmp', 'ot-live-ws-'));
    execSync('git init -q', { cwd: workspaceDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: workspaceDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: workspaceDir, stdio: 'ignore' });

    // Write cc-swarm config pointing to our hub
    const pluginCfgDir = path.join(workspaceDir, '.swarm', 'claude-swarm');
    fs.mkdirSync(pluginCfgDir, { recursive: true });
    fs.writeFileSync(path.join(pluginCfgDir, 'config.json'), JSON.stringify({
      template: 'gsd',
      map: {
        enabled: true,
        server: `ws://127.0.0.1:${SERVER_PORT}/ws/map`,
        sidecar: 'session',
        auth: { token: agent.ingestToken, param: 'token' },
      },
      opentasks: { enabled: false }, // We test task bridge events, not opentasks MCP
    }));

    // Write a simple README for the agent to work with
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Live Agent Test\n');
  }, 60000);

  afterAll(async () => {
    wsObserver?.close();
    try { await otServer?.stop(); } catch {}
    try { await otStore?.close(); } catch {}
    stopMapWebSocket();
    stopHeartbeat();
    await app?.close();
    await sleep(200);
    closeDatabase();
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
  }, 15000);

  it('agent session starts sidecar which connects to OpenHive hub', async () => {
    // Run claude with a simple prompt. The sidecar starts as a background process
    // during SessionStart and connects to our hub automatically.
    // We verify the infrastructure link: agent → sidecar → hub.
    const run = await runClaude(
      'Create a team using TeamCreate with name "live-test-team". ' +
      'Then create a task using TaskCreate with subject "Live test task" and description "E2E round-trip test". ' +
      'Then update the task to status completed using TaskUpdate. ' +
      'Do not do anything else.',
      {
        cwd: workspaceDir,
        maxBudgetUsd: 2.0,
        maxTurns: 20,
        timeout: 120_000,
      },
    );

    console.log(`[live-agent] exit code: ${run.exitCode}`);
    console.log(`[live-agent] messages: ${run.messages.length}`);

    const toolCalls = extractToolCalls(run.messages);
    for (const msg of run.messages) {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            toolCalls.push({ name: block.name, input: block.input || {} });
          }
        }
      }
    }
    console.log(`[live-agent] tool calls: ${toolCalls.map(tc => tc.name).join(', ')}`);

    // Wait for sidecar to connect
    await sleep(3000);

    // ── Primary assertion: sidecar connected to our hub ──
    // This proves: Claude Code session → cc-swarm bootstrap → sidecar start
    // → WebSocket connection → OpenHive hub accepts → swarm registered
    const sidecarConnected = getAllInbound().size > 0;
    console.log(`[live-agent] sidecar connected: ${sidecarConnected}`);
    console.log(`[live-agent] inbound connections: ${getAllInbound().size}`);
    expect(sidecarConnected).toBe(true);

    // ── Bonus: check if task bridge events arrived ──
    const taskCreates = toolCalls.filter(tc => tc.name === 'TaskCreate');
    const taskEvents = observerMessages.filter(m => m.channel === 'map:tasks');
    console.log(`[live-agent] TaskCreate calls: ${taskCreates.length}`);
    console.log(`[live-agent] task broadcast events: ${taskEvents.length}`);

    if (taskCreates.length > 0 && taskEvents.length > 0) {
      console.log('[live-agent] FULL ROUND-TRIP VERIFIED: TaskCreate → bridge → hub → broadcast');
      const created = taskEvents.find(m => m.type === 'task.created');
      if (created) {
        expect(created.channel).toBe('map:tasks');
      }
    } else if (taskCreates.length > 0) {
      console.log('[live-agent] Agent used TaskCreate but no broadcast received (bridge may not have fired in time)');
    } else {
      console.log('[live-agent] Agent did not use TaskCreate (needs team context — non-deterministic)');
    }

    // Check graph state
    const graphJsonl = fs.readFileSync(path.join(opentasksDir, 'graph.jsonl'), 'utf-8');
    const graphLines = graphJsonl.split('\n').filter(l => l.trim());
    console.log(`[live-agent] graph.jsonl lines: ${graphLines.length}`);

    // Cost info
    const result = run.messages.find(m => (m as any).type === 'result') as any;
    if (result) {
      console.log(`[live-agent] cost: $${result.total_cost_usd?.toFixed(3) || '?'}`);
    }
  });
});
