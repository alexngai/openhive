/**
 * Live Agent E2E: codex-rpc end-to-end through openhive's chat plumbing.
 *
 * The codex-rpc backend is exercised in isolation by live-codex-rpc-e2e.test.ts
 * (manager + CodexAppServerManager). This test exercises the FULL openhive
 * stack a UI client would touch:
 *
 *   1. Spawn `kind: 'codex'` `mode: 'rpc'` via REST
 *   2. Open openhive's `/ws` WebSocket and subscribe to
 *      `codex-rpc:<hostedSwarmId>`
 *   3. POST a turn to `/api/v1/map/hosted/:id/chat/turn`
 *   4. Observe streaming `item/agentMessage/delta` and `turn/completed`
 *      arrive on the WS channel
 *   5. Assert the assembled agent message is non-empty
 *   6. Stop via REST
 *
 * What this proves: a frontend chat adapter built against the same WS
 * channel + REST endpoint will work end-to-end. The remaining work to
 * surface this in openhive's Threads UI is presentational (rendering
 * deltas as ChatMessages, mapping codex method names → events the
 * existing chat components understand).
 *
 * REQUIRES: LIVE_AGENT_E2E=true
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { setupWebSocket } from '../../realtime/index.js';
import { SwarmManager } from '../../swarm/manager.js';
import { resolveCodexBinary } from '../../swarm/codex-binary.js';
import { CodexAppServerManager } from '../../swarm/codex-app-server-manager.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE_AGENT ? describe : describe.skip;

const TEST_ROOT = testRoot('live-codex-rpc-chat');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-codex-rpc-chat.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 20030;
const PORT_RANGE_MAX = 20040;
const SERVER_PORT = 20042;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: {
      name: 'Live codex-rpc chat E2E',
      description: 'Test',
      url: `http://127.0.0.1:${SERVER_PORT}`,
    },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    mapHub: { enabled: true, trustModel: 'open', iamSecret: 'test-iam-codex-rpc-chat' },
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

describeIf('Live Agent E2E — programmatic-mode swarms via openhive hosted-chat plumbing', () => {
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
      name: 'live-codex-rpc-chat-owner',
      description: 'Owner for live codex-rpc chat E2E',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    agentsByKey.set(testAgent.apiKey, { id: testAgent.id, name: 'live-codex-rpc-chat-owner' });
    setLocalAgent(agentResult.agent);

    hivesDAL.createHive({
      name: 'live-codex-rpc-chat-hive',
      description: 'Hive for live codex-rpc chat E2E',
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
    // Realtime WS — `/ws` — is the channel openhive's chat surface
    // subscribes to. Set up here so `codex-rpc:<id>` broadcasts get
    // delivered to test clients.
    setupWebSocket(app);

    await app.register(
      async (api) => {
        await api.register(swarmHostingRoutes, { config } as never);
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
    console.log(`[live-codex-rpc-chat] OpenHive listening on port ${SERVER_PORT}`);
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

  it('REST POST /chat/turn streams normalized hosted-chat events through openhive `/ws`', async () => {
    // 1. Spawn the swarm.
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: { authorization: `Bearer ${testAgent.apiKey}`, 'content-type': 'application/json' },
      payload: { kind: 'codex', mode: 'rpc', name: 'live-codex-rpc-chat-swarm' },
    });
    expect(spawnRes.statusCode).toBe(201);
    const spawned = spawnRes.json() as { id: string; state: string };
    expect(spawned.state).toBe('running');
    hostedSwarmId = spawned.id;

    // 2. Connect to `/ws` and subscribe to the hosted-chat channel for
    //    this swarm. Normalized event shape — provider-agnostic.
    const channel = `hosted-chat:${hostedSwarmId}`;
    const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timed out')), 5_000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (err) => { clearTimeout(timer); reject(err); });
    });

    const deltas: string[] = [];
    let turnCompleted = false;
    let turnId: string | null = null;
    let providerLabel: string | null = null;

    type WsHostedChatMsg = {
      type?: string;
      channel?: string;
      data?: {
        provider?: string;
        event?:
          | { kind: 'message.delta'; itemId: string; delta: string }
          | { kind: 'turn.started'; turnId: string }
          | { kind: 'turn.completed'; turnId: string }
          | { kind: 'message.start' | 'message.complete' | 'error' | 'raw'; [k: string]: unknown };
      };
    };

    ws.on('message', (raw) => {
      let msg: WsHostedChatMsg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'hosted-chat.event' || msg.channel !== channel) return;
      if (msg.data?.provider) providerLabel = msg.data.provider;
      const ev = msg.data?.event;
      if (!ev) return;
      if (ev.kind === 'message.delta' && typeof (ev as { delta?: unknown }).delta === 'string') {
        deltas.push((ev as { delta: string }).delta);
      } else if (ev.kind === 'turn.completed') {
        turnCompleted = true;
      } else if (ev.kind === 'turn.started' && typeof (ev as { turnId?: unknown }).turnId === 'string') {
        turnId = (ev as { turnId: string }).turnId;
      }
    });

    ws.send(JSON.stringify({ type: 'subscribe', channels: [channel] }));
    // Brief pause so the subscribe lands before we POST the turn — otherwise
    // the early notifications could arrive before the channel binding is in
    // place.
    await sleep(150);

    // 3. POST the turn through the provider-agnostic chat endpoint.
    const turnRes = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/chat/turn`,
      headers: { authorization: `Bearer ${testAgent.apiKey}`, 'content-type': 'application/json' },
      payload: { text: 'reply with exactly: HELLO-FROM-OPENHIVE-CHAT' },
    });
    expect(turnRes.statusCode).toBe(200);
    const turnAck = turnRes.json() as { turn_id: string };
    expect(turnAck.turn_id).toBeTruthy();

    // 4. Wait for streaming to complete (codex models can take ~5-10s).
    const deadline = Date.now() + 90_000;
    while (!turnCompleted && Date.now() < deadline) {
      await sleep(200);
    }

    expect(turnCompleted).toBe(true);
    expect(deltas.length).toBeGreaterThan(0);
    const assembled = deltas.join('');
    expect(assembled.length).toBeGreaterThan(0);
    expect(providerLabel).toBe('codex');
    console.log(
      `[live-hosted-chat] streamed ${deltas.length} deltas through /ws (provider=${providerLabel ?? '?'}): ${JSON.stringify(assembled.slice(0, 80))}`,
    );
    if (turnId) console.log(`[live-hosted-chat] turn id observed via WS: ${turnId}`);

    ws.close();
    await sleep(100);

    // 5. Stop via REST.
    const stopRes = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/stop`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(stopRes.statusCode).toBe(200);
    hostedSwarmId = undefined;
  }, 150_000);

  it('REST POST /map/hosted/:id/chat/turn rejects with 422 when text is missing', async () => {
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: { authorization: `Bearer ${testAgent.apiKey}`, 'content-type': 'application/json' },
      payload: { kind: 'codex', mode: 'rpc', name: 'live-codex-rpc-chat-validation' },
    });
    expect(spawnRes.statusCode).toBe(201);
    const spawned = spawnRes.json() as { id: string };
    hostedSwarmId = spawned.id;

    const empty = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/chat/turn`,
      headers: { authorization: `Bearer ${testAgent.apiKey}`, 'content-type': 'application/json' },
      payload: { text: '   ' },
    });
    expect(empty.statusCode).toBe(422);

    await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/stop`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    hostedSwarmId = undefined;
  }, 60_000);

  it('REST POST /map/hosted/:id/chat/turn refuses unknown swarms with 404', async () => {
    // No swarm to spawn — just hit the route with a non-existent id and
    // verify the kind/mode check fires (NOT_FOUND ahead of NOT_IMPLEMENTED
    // is fine for this path; we're verifying the validation chain
    // surfaces, not the exact code).
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/hswarm_does_not_exist/chat/turn',
      headers: { authorization: `Bearer ${testAgent.apiKey}`, 'content-type': 'application/json' },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(404);
  });
});
