/**
 * Live Agent E2E: kind='codex' + mode='rpc' Hosted Swarm Lifecycle
 *
 * Companion to live-codex-e2e.test.ts (TUI mode). The two modes operate on
 * INDEPENDENT threads: codex's app-server holds thread state in-memory and
 * persists snapshots; `codex resume` reads those snapshots into a separate
 * in-memory copy, and the two diverge after that point. The probe at
 * `docs/HOSTED_SWARM_KINDS_DESIGN.md` "codex — programmatic mode" confirmed
 * that openhive can't bridge them without upstream changes. So this test
 * exercises the RPC path end-to-end as its own surface.
 *
 *   1. spawn kind=codex with mode=rpc → codex app-server child is up,
 *      `thread/start` returned a thread id, row state=running
 *   2. `getCodexRpcSessionId` returns a live session id; the manager's
 *      app-server pool reports the session as `running` with a thread id
 *   3. `sendTurn` against the session produces streaming notifications
 *      (`item/agentMessage/delta`, `turn/completed`)
 *   4. terminal-info: NOT applicable for rpc mode (no PTY); we don't
 *      assert this path here.
 *   5. stop() → codex child SIGTERM, ws closed, row=stopped, manager
 *      session map cleared
 *   6. SIGKILL the codex child → handleCodexRpcExit flips row=failed
 *
 * Prerequisites: `codex` on PATH, codex login completed.
 *
 * REQUIRES: LIVE_AGENT_E2E=true
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { SwarmManager } from '../../swarm/manager.js';
import { resolveCodexBinary } from '../../swarm/codex-binary.js';
import { CodexAppServerManager } from '../../swarm/codex-app-server-manager.js';
import * as swarmDAL from '../../swarm/dal.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE_AGENT ? describe : describe.skip;

const TEST_ROOT = testRoot('live-codex-rpc');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-codex-rpc.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 20010;
const PORT_RANGE_MAX = 20020;
const SERVER_PORT = 20022;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: {
      name: 'Live codex-rpc E2E',
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
      iamSecret: 'test-iam-secret-codex-rpc',
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

describeIf('Live Agent E2E — kind=codex + mode=rpc hosted swarm lifecycle', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let codexAppServerManager: CodexAppServerManager;
  let testAgent: { id: string; apiKey: string };
  let hostedSwarmId: string | undefined;
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
      name: 'live-codex-rpc-owner',
      description: 'Owner for live codex-rpc E2E',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    agentsByKey.set(testAgent.apiKey, { id: testAgent.id, name: 'live-codex-rpc-owner' });
    setLocalAgent(agentResult.agent);

    hivesDAL.createHive({
      name: 'live-codex-rpc-hive',
      description: 'Hive for live codex-rpc E2E',
      owner_id: testAgent.id,
    });

    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );
    codexAppServerManager = new CodexAppServerManager();
    swarmManager.setCodexAppServerManager(codexAppServerManager);

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

    await app.register(
      async (api) => {
        await api.register(swarmHostingRoutes, { config } as never);
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
    console.log(`[live-codex-rpc] OpenHive listening on port ${SERVER_PORT}`);
  }, 30_000);

  afterAll(async () => {
    if (hostedSwarmId) {
      try { await swarmManager.stop(hostedSwarmId, testAgent.id); } catch { /* best-effort */ }
    }
    codexAppServerManager?.destroyAll();
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

  // ── 1. Spawn → state=running, thread id captured ─────────────────────────

  it('spawns kind=codex with mode=rpc and reaches state=running with a thread id', async () => {
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'codex',
        mode: 'rpc',
        name: 'live-codex-rpc-swarm',
        description: 'Live e2e — codex rpc',
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const body = spawnRes.json() as { id: string; state: string; swarm_id: string | null };
    hostedSwarmId = body.id;

    const row = swarmDAL.findHostedSwarmById(body.id);
    expect(row?.kind).toBe('codex');
    expect(row?.config?.mode).toBe('rpc');

    if (body.state !== 'running') {
      throw new Error(
        `Expected state=running after spawn, got state=${body.state}. error=${row?.error ?? '(no error)'}.`,
      );
    }
    expect(body.state).toBe('running');

    // Manager's session map should hold a session id; that session should
    // have a thread id (set by thread/start during create()).
    const sid = swarmManager.getCodexRpcSessionId(body.id);
    expect(sid).toBeTruthy();
    const info = codexAppServerManager.getInfo(sid!);
    expect(info).toBeTruthy();
    expect(info!.status).toBe('running');
    expect(info!.threadId).toBeTruthy();
    expect(info!.listenUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    console.log(`[live-codex-rpc] Spawn OK: thread=${info!.threadId} listen=${info!.listenUrl}`);
  }, 90_000);

  // ── 2. Send a turn → see streaming notifications + completion ────────────

  it('sendTurn produces streaming agent-message deltas and a turn/completed', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const sid = swarmManager.getCodexRpcSessionId(hostedSwarmId!)!;

    const deltas: string[] = [];
    let turnCompleted = false;

    const onNotification = (event: { sessionId: string; method: string; params?: { delta?: string } }) => {
      if (event.sessionId !== sid) return;
      if (event.method === 'item/agentMessage/delta' && typeof event.params?.delta === 'string') {
        deltas.push(event.params.delta);
      }
      if (event.method === 'turn/completed') turnCompleted = true;
    };
    codexAppServerManager.on('notification', onNotification);

    try {
      const turnAck = await codexAppServerManager.sendTurn(
        sid,
        'reply with exactly: HELLO-FROM-OPENHIVE',
      );
      expect(turnAck.turn.id).toBeTruthy();

      // Wait for turn/completed up to 90s.
      const deadline = Date.now() + 90_000;
      while (!turnCompleted && Date.now() < deadline) {
        await sleep(200);
      }
      expect(turnCompleted).toBe(true);
      expect(deltas.length).toBeGreaterThan(0);
      const assembled = deltas.join('');
      console.log(`[live-codex-rpc] Streamed ${deltas.length} deltas: ${JSON.stringify(assembled.slice(0, 80))}`);
      // We don't strictly assert exact text — model output varies — but the
      // assembled message shouldn't be empty.
      expect(assembled.length).toBeGreaterThan(0);
    } finally {
      codexAppServerManager.off('notification', onNotification);
    }
  }, 120_000);

  // ── 3. getLogs returns the codex-rpc-specific hint ───────────────────────

  it('getLogs returns the codex-rpc-specific message', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/hosted/${hostedSwarmId}/logs?lines=50`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/codex-rpc output streams live/);
  });

  // ── 4. Stop → row=stopped, manager session map cleared ───────────────────

  it('stop() destroys the app-server child and lands the row at state=stopped', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const sidBefore = swarmManager.getCodexRpcSessionId(hostedSwarmId!);
    expect(sidBefore).toBeTruthy();
    const pid = codexAppServerManager.getInfo(sidBefore!)?.pid;
    expect(pid).toBeGreaterThan(0);

    const stopRes = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/stop`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(stopRes.statusCode).toBe(200);
    const body = stopRes.json() as { state: string };
    expect(body.state).toBe('stopped');

    expect(swarmManager.getCodexRpcSessionId(hostedSwarmId!)).toBeNull();
    // The session is removed from the manager's pool by destroy().
    expect(codexAppServerManager.getInfo(sidBefore!)).toBeNull();

    hostedSwarmId = undefined;
  }, 30_000);

  // ── 5. SIGKILL → handleCodexRpcExit flips state=failed ───────────────────

  it('forced child crash (SIGKILL) flips the row to state=failed', async () => {
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'codex',
        mode: 'rpc',
        name: 'live-codex-rpc-crash-victim',
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const spawned = spawnRes.json() as { id: string; state: string };
    expect(spawned.state).toBe('running');
    hostedSwarmId = spawned.id;

    const sid = swarmManager.getCodexRpcSessionId(spawned.id);
    expect(sid).toBeTruthy();
    const pid = codexAppServerManager.getInfo(sid!)?.pid;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid!, 'SIGKILL');

    const deadline = Date.now() + 10_000;
    let row = swarmDAL.findHostedSwarmById(spawned.id);
    while (Date.now() < deadline) {
      row = swarmDAL.findHostedSwarmById(spawned.id);
      if (row?.state === 'failed' || row?.state === 'stopped') break;
      await sleep(150);
    }
    expect(row).toBeTruthy();
    expect(row!.state).toBe('failed');
    expect(row!.error).toMatch(/codex app-server exited/);
    expect(swarmManager.getCodexRpcSessionId(spawned.id)).toBeNull();
    hostedSwarmId = undefined;
  }, 90_000);
});
