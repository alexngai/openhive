/**
 * Multi-Coordinator ACP Routing E2E
 *
 * Spawns a real macro-agent + two coordinators at the SAME cwd, then opens
 * an ACP session targeting the SECOND coordinator. Verifies the routing fix
 * (per-stream `targetAgentId` plumbed through MacroAgent) — the ACP session
 * should bind to the targeted coordinator's local agent id, not whichever
 * head manager `getOrCreateHeadManager(cwd)` would have returned first.
 *
 * Without the fix, when two coordinators share a cwd, `session/new` falls
 * through to cwd-based head-manager lookup and may pick the wrong one.
 *
 * REQUIRES: LIVE_AGENT_E2E=true (spawns real macro-agent + Claude Code subprocess).
 *
 * Run:
 *   LIVE_AGENT_E2E=true npx vitest run src/__tests__/map/multi-coordinator-routing-e2e.test.ts
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
import { getAllInbound } from '../../map/connection-registry.js';
import { SwarmManager } from '../../swarm/manager.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { mapRoutes } from '../../api/routes/map.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { initMail } from '../../mail/index.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const TEST_ROOT = testRoot('e2e-multi-coord-routing');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'multi-coord.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');
const TEST_RUN_TAG = `mc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_CWD = path.join(TEST_ROOT, `multi-coord-${TEST_RUN_TAG}`);
const SOLO_PROJECT_CWD = path.join(TEST_ROOT, `solo-${TEST_RUN_TAG}`);

const PORT_RANGE_MIN = 19880;
const PORT_RANGE_MAX = 19895;
const SERVER_PORT = 19896;
const SC_PREFIX = '/api/swarmcraft';
const SC_WS_PATH = '/ws/swarmcraft';

// ============================================================================
// Helpers
// ============================================================================

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 300,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await fn()) return true; } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Query macro-agent's local MAP server for the live ACP stream → local agent
 * bindings. This is the authoritative source — it reflects exactly which
 * agent each per-stream MacroAgent was constructed against, which is what
 * `session/new` then binds to.
 *
 * Exposed as `_macro/getAcpStreamBindings` extension on macro-agent's MAP
 * server.
 */
async function getStreamBindings(
  app: FastifyInstance,
  swarmId: string,
): Promise<Array<{ streamId: string; peerAgentId: string }>> {
  const sc = (app as any).swarmcraft;
  const client = sc?.mapClientManager?.getClient(swarmId);
  if (!client) throw new Error(`No MAP client for swarm ${swarmId}`);
  const result = (await client.callExtension('_macro/getAcpStreamBindings', {})) as {
    bindings?: Array<{ streamId: string; peerAgentId: string }>;
  };
  return result?.bindings ?? [];
}

// ============================================================================
// Tests
// ============================================================================

const describeIf = LIVE_AGENT ? describe : describe.skip;

describeIf('E2E — Multi-Coordinator ACP Routing through OpenHive', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let testAgent: { id: string; apiKey: string };
  let swarmId: string | undefined;
  let assignedPort: number | undefined;
  let bridgeServerId: string | undefined;
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_PROJECT_CWD, { recursive: true });
    fs.mkdirSync(SOLO_PROJECT_CWD, { recursive: true });

    initDatabase(TEST_DB_PATH);
    await initMail();

    config = ConfigSchema.parse({
      port: SERVER_PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'multi-coord routing', description: 'Test', url: `http://127.0.0.1:${SERVER_PORT}` },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      cors: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open' },
      swarmcraft: { enabled: true, prefix: SC_PREFIX, wsPath: SC_WS_PATH },
      swarmHosting: {
        enabled: true,
        default_provider: 'local',
        openswarm_command: 'npx openswarm serve',
        data_dir: TEST_DATA_DIR,
        port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX],
        max_swarms: 2,
        health_check_interval: 600000,
        max_health_failures: 3,
        auto_restart: false,
        credentials: { inherit_env: true },
      },
    });

    const ar = await agentsDAL.createAgent({
      name: 'multi-coord-owner',
      description: 'owner',
      is_admin: true,
    });
    testAgent = { id: ar.agent.id, apiKey: ar.apiKey };
    setLocalAgent(ar.agent);

    hivesDAL.createHive({
      name: 'multi-coord-hive',
      description: 'test hive',
      owner_id: testAgent.id,
    });

    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(fastifyWebsocket);
    setupMapWebSocket(app, config);

    // SwarmCraft plugin — needed for acpStreamManager + mapClientManager
    const { swarmcraftPlugin } = await import('swarmcraft/plugin');
    await app.register(swarmcraftPlugin, {
      database: { type: 'sqlite', path: TEST_DB_PATH, tablePrefix: 'sc_' },
      prefix: SC_PREFIX,
      wsPath: SC_WS_PATH,
      logLevel: 'warn',
    });

    const { setupOpenHiveBridge } = await import('../../swarmcraft/bridge.js');
    const sc = (app as any).swarmcraft;
    await setupOpenHiveBridge({
      db: sc.db, wsHub: sc.wsHub,
      positionService: sc.positionService,
      trajectoryService: sc.trajectoryService,
      mapClientManager: sc.mapClientManager,
      pipelineService: sc.pipelineService,
    });

    await app.register(
      async (api) => {
        await api.register(mapRoutes, { config });
        await api.register(sessionsRoutes, { config });
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });

    // Spawn macro-agent
    const hosted = await swarmManager.spawn(testAgent.id, {
      name: 'multi-coord-swarm',
      adapter: 'macro-agent',
      hive: 'multi-coord-hive',
    });
    assignedPort = hosted.assigned_port!;

    // Wait for sidecar to register on the hub
    const sidecarReady = await waitFor(() => {
      for (const [id, conn] of getAllInbound()) {
        if (conn.registeredAgents.size > 0) { swarmId = id; return true; }
      }
      return false;
    }, 45_000);
    expect(sidecarReady).toBe(true);
    expect(swarmId).toBeDefined();

    // Let identity stabilize after sidecar reconnects
    await sleep(2000);
    for (const [id, conn] of getAllInbound()) {
      if (conn.registeredAgents.size > 0) swarmId = id;
    }

    // Reconnect MAP client to the macro-agent's MAP server (port+2 by openswarm convention)
    // so acp-connect's `_macro/spawnAgent` and `acpStreamManager.newSession` calls can route.
    const mapPort = assignedPort + 2;

    let agents: any[] = [];
    if (typeof sc.db.agents.getAll === 'function') {
      agents = await sc.db.agents.getAll();
    } else if (typeof sc.db.agents.list === 'function') {
      const res = await sc.db.agents.list();
      agents = Array.isArray(res) ? res : (res?.agents ?? []);
    }
    const swarmAgent = agents.find((a: any) => a.type === 'swarm');
    bridgeServerId = swarmAgent?.mapServerId ?? swarmId;

    try {
      try { await sc.mapClientManager.disconnect(bridgeServerId); await sleep(300); } catch { /* ignore */ }
      await sc.mapClientManager.connect({
        id: bridgeServerId,
        name: 'multi-coord-swarm',
        url: `ws://127.0.0.1:${mapPort}/map`,
        auth: { method: 'none' },
        skipSubscription: true,
      } as any);
    } catch (err) {
      console.warn(`[multi-coord] MAPClientManager reconnect: ${(err as Error).message}`);
    }

    // The OpenHive routes look up the SwarmCraft MAP client via the swarm id
    // we surface to clients. The bridge often projects under a different
    // server id than swarmId; mirror it under both ids so getClient(swarmId)
    // resolves.
    if (bridgeServerId && swarmId && bridgeServerId !== swarmId) {
      try {
        await sc.mapClientManager.connect({
          id: swarmId,
          name: 'multi-coord-swarm-mirror',
          url: `ws://127.0.0.1:${mapPort}/map`,
          auth: { method: 'none' },
          skipSubscription: true,
        } as any);
      } catch { /* ignore */ }
    }

    await sleep(1000);
  }, 90_000);

  afterAll(async () => {
    if (swarmManager) await swarmManager.shutdown();
    stopMapWebSocket();
    if (app) await app.close();
    setLocalAgent(null);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  }, 30_000);

  it('routes ACP session to the targeted coordinator when multiple share a cwd', async () => {
    expect(swarmId).toBeDefined();

    // ── Spawn TWO coordinators at the SAME cwd ─────────────────────────
    const spawnA = await app.inject({
      method: 'POST',
      url: `/api/v1/map/swarms/${swarmId}/agents`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
      payload: { role: 'coordinator', cwd: TEST_PROJECT_CWD, task: 'agent-A' },
    });
    expect(spawnA.statusCode).toBe(200);
    const a = spawnA.json() as { agent_id: string; peer_map_id: string };

    const spawnB = await app.inject({
      method: 'POST',
      url: `/api/v1/map/swarms/${swarmId}/agents`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
      payload: { role: 'coordinator', cwd: TEST_PROJECT_CWD, task: 'agent-B' },
    });
    expect(spawnB.statusCode).toBe(200);
    const b = spawnB.json() as { agent_id: string; peer_map_id: string };

    expect(a.agent_id).not.toBe(b.agent_id);

    // Resolve A and B's *internal* local agent ids (what macro-agent's
    // store and the ACP bridge use). The hub publishes these in
    // registered_agents[].metadata.peerAgentId. Distinct from peer_map_id
    // returned by /agents (which is the MAP server's ULID for the agent).
    const reg = await app.inject({
      method: 'GET',
      url: `/api/v1/map/swarms/${swarmId}`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    const swarmInfo = reg.json() as { registered_agents: Array<{ id: string; role: string; metadata?: any }> };
    const coordIds = swarmInfo.registered_agents.filter((x) => x.role === 'coordinator').map((x) => x.id);
    expect(coordIds).toContain(a.agent_id);
    expect(coordIds).toContain(b.agent_id);

    const aPeerAgentId = (swarmInfo.registered_agents.find((x) => x.id === a.agent_id)
      ?.metadata as any)?.peerAgentId as string | undefined;
    const bPeerAgentId = (swarmInfo.registered_agents.find((x) => x.id === b.agent_id)
      ?.metadata as any)?.peerAgentId as string | undefined;
    expect(aPeerAgentId).toBeDefined();
    expect(bPeerAgentId).toBeDefined();
    expect(aPeerAgentId).not.toBe(bPeerAgentId);

    // ── Connect ACP targeting B specifically ────────────────────────────
    const connect = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
      payload: { swarm_id: swarmId, agent_id: b.agent_id, cwd: TEST_PROJECT_CWD },
    });
    expect(connect.statusCode).toBe(200);
    const ses = connect.json() as { acp_session_id: string; acp_stream_id: string };
    expect(ses.acp_session_id).toBeTruthy();
    expect(ses.acp_stream_id).toBeTruthy();

    // Give the bridge a moment to wire up the stream ↔ agent binding
    await sleep(500);

    // ── Verify the per-stream binding via macro-agent's MAP server ─────
    // _macro/getAcpStreamBindings reports streamId → internal local agent
    // id, which is exactly what MacroAgent.initConfig.targetAgentId gets set
    // to and what newSession's getActiveAgentSession() looks up. This is the
    // authoritative source for proving the routing fix.
    const bindings = await getStreamBindings(app, swarmId!);
    const myBinding = bindings.find((x) => x.streamId === ses.acp_stream_id);
    expect(myBinding).toBeDefined();

    // The bound agent must be B's local agent id, NOT A's — even though
    // both share the same cwd. This is the crux of the fix: without
    // targetAgentId plumbing, cwd-fallback could have returned A.
    expect(myBinding!.peerAgentId).toBe(bPeerAgentId);
    expect(myBinding!.peerAgentId).not.toBe(aPeerAgentId);
  }, 60_000);

  it('still works for the single-coordinator (cwd-fallback) case', async () => {
    expect(swarmId).toBeDefined();

    const spawn = await app.inject({
      method: 'POST',
      url: `/api/v1/map/swarms/${swarmId}/agents`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
      payload: { role: 'coordinator', cwd: SOLO_PROJECT_CWD, task: 'solo' },
    });
    expect(spawn.statusCode).toBe(200);
    const s = spawn.json() as { agent_id: string };

    const reg = await app.inject({
      method: 'GET',
      url: `/api/v1/map/swarms/${swarmId}`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    const swarmInfo = reg.json() as { registered_agents: Array<{ id: string; metadata?: any }> };
    const peerAgentId = (swarmInfo.registered_agents.find((x) => x.id === s.agent_id)
      ?.metadata as any)?.peerAgentId as string | undefined;
    expect(peerAgentId).toBeDefined();

    const connect = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
      payload: { swarm_id: swarmId, agent_id: s.agent_id, cwd: SOLO_PROJECT_CWD },
    });
    expect(connect.statusCode).toBe(200);
    const ses = connect.json() as { acp_session_id: string; acp_stream_id: string };

    await sleep(500);
    const bindings = await getStreamBindings(app, swarmId!);
    const myBinding = bindings.find((x) => x.streamId === ses.acp_stream_id);
    expect(myBinding).toBeDefined();
    expect(myBinding!.peerAgentId).toBe(peerAgentId);
  }, 30_000);
});
