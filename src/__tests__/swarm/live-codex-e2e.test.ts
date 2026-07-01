/**
 * Live Agent E2E: kind='codex' Hosted Swarm Lifecycle
 *
 * Sister test to live-claude-code-e2e.test.ts. Differences:
 *
 *   - Codex has no openhive-aware plugin yet, so there's no sidecar to
 *     wait for during spawn. The row flips to `running` as soon as the
 *     PTY is up. We also don't assert MAP capabilities on the sidecar
 *     (there isn't one).
 *
 *   - Codex stores per-project trust in `~/.codex/config.toml` under
 *     `[projects."<realpath>"] trust_level = "trusted"`. The spawn
 *     pipeline pre-writes that stanza so the TUI doesn't gate at the
 *     "Trust this folder?" prompt — same shape as the claude pre-trust,
 *     different file.
 *
 *   - Stop / restart / crash mirror claude-code's behavior: the TUI is
 *     PtyManager-owned, the row state derives from the PTY's exit code
 *     (or signal), and operator-stop deletes the session-map entry
 *     before destroying the PTY so the exit handler returns early.
 *
 *   - terminal-info?mode=tui returns `binding: 'attach'` with the live
 *     PtyManager session id, same as claude-code.
 *
 * Prerequisites: `codex` on PATH and the user logged in (`codex login`).
 *
 * REQUIRES: LIVE_AGENT_E2E=true
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { SwarmManager } from '../../swarm/manager.js';
import { resolveCodexBinary } from '../../swarm/codex-binary.js';
import * as swarmDAL from '../../swarm/dal.js';
import { PtyManager, handleTerminalWebSocket } from '../../terminal/index.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE_AGENT ? describe : describe.skip;

const TEST_ROOT = testRoot('live-codex');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-codex.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19994;
const PORT_RANGE_MAX = 20000;
const SERVER_PORT = 20002;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: {
      name: 'Live codex E2E',
      description: 'Test',
      url: `http://127.0.0.1:${SERVER_PORT}`,
    },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    mapHub: {
      enabled: true,
      trustModel: 'open',
      iamSecret: 'test-iam-secret-codex',
    },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      swarm_runner_command: 'echo unused',
      data_dir: TEST_DATA_DIR,
      port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX],
      max_swarms: 2,
      health_check_interval: 600_000,
      max_health_failures: 3,
      auto_restart: false,
      credentials: { inherit_env: true },
    },
  });
}

describeIf('Live Agent E2E — kind=codex hosted swarm lifecycle', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let ptyManager: PtyManager;
  let testAgent: { id: string; apiKey: string };
  let hostedSwarmId: string | undefined;
  let preRegisteredSwarmId: string | undefined;
  const agentsByKey = new Map<string, { id: string; name: string }>();
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

    initDatabase(TEST_DB_PATH);

    if (!resolveCodexBinary()) {
      throw new Error('codex binary not found on PATH. Install Codex before running this test.');
    }

    config = createTestConfig();
    initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

    const agentResult = await agentsDAL.createAgent({
      name: 'live-codex-owner',
      description: 'Owner for live codex E2E',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    agentsByKey.set(testAgent.apiKey, { id: testAgent.id, name: 'live-codex-owner' });
    setLocalAgent(agentResult.agent);

    hivesDAL.createHive({
      name: 'live-codex-hive',
      description: 'Hive for live codex E2E',
      owner_id: testAgent.id,
    });

    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );
    ptyManager = new PtyManager();
    swarmManager.setPtyManager(ptyManager);

    app = Fastify({ logger: false });
    app.decorateRequest('agent');

    app.addHook(
      'preHandler',
      async (request: { headers: { authorization?: string }; agent?: unknown }) => {
        const auth = request.headers.authorization;
        if (auth?.startsWith('Bearer ')) {
          const token = auth.slice(7);
          const agent = agentsByKey.get(token);
          if (agent) request.agent = agent;
        }
      },
    );

    (app as unknown as { swarmManager: SwarmManager }).swarmManager = swarmManager;

    await app.register(fastifyWebsocket);
    setupMapWebSocket(app, config);

    app.get('/ws/terminal', { websocket: true }, (socket, request) => {
      const ws = socket as unknown as import('ws').WebSocket;
      const query = request.query as Record<string, string>;
      handleTerminalWebSocket(ws, query, ptyManager);
    });

    await app.register(
      async (api) => {
        await api.register(swarmHostingRoutes, { config } as never);
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
    console.log(`[live-codex] OpenHive listening on port ${SERVER_PORT}`);
  }, 30_000);

  afterAll(async () => {
    if (hostedSwarmId) {
      try { await swarmManager.stop(hostedSwarmId, testAgent.id); } catch { /* best-effort */ }
    }
    ptyManager?.destroyAll();
    await swarmManager?.shutdown();
    stopMapWebSocket();
    if (app) await app.close();
    setLocalAgent(null);
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  }, 30_000);

  // ── 1. Spawn → state=running ─────────────────────────────────────────────

  it('spawns kind=codex and reaches state=running (no sidecar wait)', async () => {
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'codex',
        mode: 'tui',
        name: 'live-codex-swarm',
        description: 'Live e2e — codex',
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const body = spawnRes.json() as {
      id: string;
      state: string;
      swarm_id: string | null;
    };
    hostedSwarmId = body.id;
    preRegisteredSwarmId = body.swarm_id ?? undefined;

    const row = swarmDAL.findHostedSwarmById(body.id);
    expect(row?.kind).toBe('codex');

    if (body.state !== 'running') {
      throw new Error(
        `Expected state=running after spawn, got state=${body.state}. ` +
          `error=${row?.error ?? '(no error)'}.`,
      );
    }
    expect(body.state).toBe('running');
    expect(preRegisteredSwarmId).toBeTruthy();
  }, 60_000);

  // ── 2. terminal-info attach binding ──────────────────────────────────────

  it('terminal-info?mode=tui returns binding=attach with the live PTY sessionId', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/hosted/${hostedSwarmId}/terminal-info?mode=tui`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const info = res.json() as {
      mode: string;
      binding: string;
      available: boolean;
      sessionId: string | null;
    };
    expect(info.mode).toBe('tui');
    expect(info.binding).toBe('attach');
    expect(info.available).toBe(true);
    expect(info.sessionId).toBeTruthy();

    const managerSessionId = swarmManager.getTuiPtySessionId(hostedSwarmId!);
    expect(info.sessionId).toBe(managerSessionId);

    const sessionInfo = ptyManager.getInfo(info.sessionId!);
    expect(sessionInfo).toBeTruthy();
    expect(sessionInfo!.status).toBe('running');
  });

  // ── 3. getLogs ──────────────────────────────────────────────────────────

  it('getLogs returns the codex-specific message (no scrollback)', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/hosted/${hostedSwarmId}/logs?lines=50`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/codex logs stream live/);
  });

  // ── 4. Browser WS attach ────────────────────────────────────────────────

  it('a browser WS connection attaches to the codex PTY by sessionId', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const sid = swarmManager.getTuiPtySessionId(hostedSwarmId!);
    expect(sid).toBeTruthy();

    const url = `ws://127.0.0.1:${SERVER_PORT}/ws/terminal?sessionId=${sid}&cols=120&rows=40`;
    const ws = new WebSocket(url);

    type WsMsg = { type: string; sessionId?: string; message?: string };
    let connectedSeen = false;
    let bytesSeen = 0;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS attach timed out')), 10_000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      });
      ws.on('message', (raw) => {
        const data = raw.toString();
        if (data.startsWith('{')) {
          try {
            const msg = JSON.parse(data) as WsMsg;
            if (msg.type === 'connected') {
              connectedSeen = true;
              expect(msg.sessionId).toBe(sid);
            }
            if (msg.type === 'error') {
              clearTimeout(timer);
              reject(new Error(`server error: ${msg.message}`));
              return;
            }
          } catch {
            bytesSeen += data.length;
          }
        } else {
          bytesSeen += data.length;
        }
        if (connectedSeen && bytesSeen > 0) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    expect(connectedSeen).toBe(true);
    expect(bytesSeen).toBeGreaterThan(0);

    ws.close();
    await sleep(200);
    const after = ptyManager.getInfo(sid!);
    expect(after?.status).toBe('running');
  }, 15_000);

  // ── 5. Restart cycles the PTY (no sidecar wait) ──────────────────────────

  it('restart() reboots the PTY against the same row', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const oldSessionId = swarmManager.getTuiPtySessionId(hostedSwarmId!);
    expect(oldSessionId).toBeTruthy();
    const oldRow = swarmDAL.findHostedSwarmById(hostedSwarmId!)!;

    const restartRes = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/restart`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(restartRes.statusCode).toBe(200);
    const body = restartRes.json() as { state: string };
    expect(body.state).toBe('running');

    const newSessionId = swarmManager.getTuiPtySessionId(hostedSwarmId!);
    expect(newSessionId).toBeTruthy();
    expect(newSessionId).not.toBe(oldSessionId);

    const newRow = swarmDAL.findHostedSwarmById(hostedSwarmId!)!;
    expect(newRow.id).toBe(oldRow.id);
    expect(newRow.swarm_id).toBe(oldRow.swarm_id);
    expect(newRow.kind).toBe('codex');
  }, 60_000);

  // ── 6. Stop ──────────────────────────────────────────────────────────────

  it('stop() destroys the PTY and lands the row at state=stopped', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const sessionIdBefore = swarmManager.getTuiPtySessionId(hostedSwarmId!);
    expect(sessionIdBefore).toBeTruthy();

    const stopRes = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/stop`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(stopRes.statusCode).toBe(200);
    const body = stopRes.json() as { state: string };
    expect(body.state).toBe('stopped');

    const sessionAfter = ptyManager.getInfo(sessionIdBefore!);
    if (sessionAfter) expect(sessionAfter.status).not.toBe('running');
    expect(swarmManager.getTuiPtySessionId(hostedSwarmId!)).toBeNull();

    hostedSwarmId = undefined;
  }, 30_000);

  // ── 7. SIGKILL → state=failed ────────────────────────────────────────────

  it('forced PTY crash (SIGKILL) flips the row to state=failed', async () => {
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'codex',
        mode: 'tui',
        name: 'live-codex-crash-victim',
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const spawned = spawnRes.json() as { id: string; state: string };
    expect(spawned.state).toBe('running');
    hostedSwarmId = spawned.id;

    const sid = swarmManager.getTuiPtySessionId(spawned.id);
    expect(sid).toBeTruthy();
    const ptyInfo = ptyManager.getInfo(sid!);
    expect(ptyInfo?.pid).toBeGreaterThan(0);
    process.kill(ptyInfo!.pid, 'SIGKILL');

    const deadline = Date.now() + 10_000;
    let row = swarmDAL.findHostedSwarmById(spawned.id);
    while (Date.now() < deadline) {
      row = swarmDAL.findHostedSwarmById(spawned.id);
      if (row?.state === 'failed' || row?.state === 'stopped') break;
      await sleep(150);
    }

    expect(row).toBeTruthy();
    expect(row!.state).toBe('failed');
    expect(row!.error).toMatch(/exited with code/);
    expect(swarmManager.getTuiPtySessionId(spawned.id)).toBeNull();

    hostedSwarmId = undefined;
  }, 60_000);

  // ── 8. Initial prompt ────────────────────────────────────────────────────

  it('initial_prompt is passed to codex as a positional arg', async () => {
    const initialPrompt = 'Find and fix the auth bug';
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'codex',
        mode: 'tui',
        name: 'live-codex-with-prompt',
        initial_prompt: initialPrompt,
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const spawned = spawnRes.json() as { id: string; state: string };
    expect(spawned.state).toBe('running');
    hostedSwarmId = spawned.id;

    const sid = swarmManager.getTuiPtySessionId(spawned.id);
    const info = ptyManager.getInfo(sid!);
    expect(info!.args).toEqual([initialPrompt]);

    await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${spawned.id}/stop`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    hostedSwarmId = undefined;
  }, 60_000);

  // ── 9. Workspace clone ───────────────────────────────────────────────────

  it('workspace.repos clones into data_dir before codex launches', async () => {
    const fixtureRoot = path.join(TEST_ROOT, 'workspace-fixture-codex');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'README.md'), '# clone-me-codex\n', 'utf8');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixtureRoot });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], { cwd: fixtureRoot });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], { cwd: fixtureRoot });
    const fixtureUrl = `file://${fixtureRoot}`;

    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'codex',
        mode: 'tui',
        name: 'live-codex-with-workspace',
        workspace: { repos: [{ url: fixtureUrl, branch: 'main' }] },
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const spawned = spawnRes.json() as { id: string; state: string };
    expect(spawned.state).toBe('running');
    hostedSwarmId = spawned.id;

    const row = swarmDAL.findHostedSwarmById(spawned.id)!;
    const dataDir = row.config!.data_dir;
    const clonedReadme = path.join(dataDir, 'README.md');
    expect(fs.existsSync(clonedReadme)).toBe(true);
    expect(fs.readFileSync(clonedReadme, 'utf8')).toBe('# clone-me-codex\n');
    expect(fs.existsSync(path.join(dataDir, '.git'))).toBe(true);

    await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${spawned.id}/stop`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    hostedSwarmId = undefined;
  }, 90_000);
});
