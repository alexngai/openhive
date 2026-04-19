/**
 * Tests for the split agent lifecycle + ACP-connect routes:
 *   POST /map/swarms/:id/agents            — spawn agent (lifecycle only)
 *   POST /map/swarms/:id/agents/:aid/stop  — terminate agent
 *   POST /sessions/acp-connect             — open ACP session against an existing agent
 *
 * These were previously bundled into POST /sessions/create-acp, which was
 * renamed and split so spawn and connect are independent primitives.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDal from '../../db/dal/map.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { mapRoutes } from '../../api/routes/map.js';
import { ConfigSchema, type Config } from '../../config.js';
import { initializeLocalSessionStorage } from '../../sessions/storage/index.js';
import {
  registerInbound,
  unregisterInbound,
  getAllInbound,
  type MapInboundConnection,
} from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Keep the realtime broadcast a no-op — these routes emit WS events on success
// but the tests assert on HTTP response bodies, not delivery.
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

vi.mock('../../map/sync-listener.js', () => ({
  hasOutboundConnection: vi.fn().mockReturnValue(false),
  getSyncListenerStatus: vi.fn().mockReturnValue({ connected: 0, reconnecting: 0, connections: [] }),
  handleSyncMessage: vi.fn(),
  isMapSyncMessage: vi.fn().mockReturnValue(false),
}));

const TEST_ROOT = testRoot('agent-lifecycle-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'agent-lifecycle-routes.db');
const TEST_STORAGE_PATH = path.join(TEST_ROOT, 'sessions-storage');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

// Mock WebSocket — swarm connection-registry stores a ws handle on each
// inbound connection, but these routes never invoke it, so a stub suffices.
function createMockWs(): any {
  return {
    readyState: 1,
    isAlive: true,
    close() {},
    terminate() {},
    ping() {},
    send() {},
    on() {},
    removeListener() {},
  };
}

/** Seed a macro-agent style inbound connection with a sidecar + optional coordinator. */
function seedInboundConnection(
  swarmId: string,
  opts: {
    withCoordinator?: {
      hubId: string;
      peerMapId: string;
      name?: string;
      providerSessionId?: string;
    };
  } = {},
): MapInboundConnection {
  const conn: MapInboundConnection = {
    ws: createMockWs(),
    agentId: 'hub-agent-1',
    swarmId,
    connectedAt: '2026-04-13T00:00:00.000Z',
    lastMessageAt: '2026-04-13T00:01:00.000Z',
    registeredAgents: new Map(),
  };

  // Always register a sidecar
  conn.registeredAgents.set('sidecar-id', {
    id: 'sidecar-id',
    name: `${swarmId}-sidecar`,
    role: 'sidecar',
    state: 'registered',
    scopes: [],
    capabilities: { messaging: { canSend: true, canReceive: true } },
    metadata: { canHostAcp: true },
  });

  if (opts.withCoordinator) {
    const { hubId, peerMapId, name, providerSessionId } = opts.withCoordinator;
    conn.registeredAgents.set(hubId, {
      id: hubId,
      name: name ?? 'test-coord',
      role: 'coordinator',
      state: 'registered',
      scopes: [],
      capabilities: {
        messaging: { canReceive: true },
        protocols: ['acp'],
        acp: { version: '2024-10-07' },
      },
      metadata: {
        peerMapId,
        peerAgentId: 'agent_local_1',
        ...(providerSessionId ? { provider_session_id: providerSessionId } : {}),
      },
    });
  }

  registerInbound(swarmId, conn);
  return conn;
}

// ────────────────────────────────────────────────────────────────
// SwarmCraft stub used by the routes
// ────────────────────────────────────────────────────────────────

interface SwarmCraftStub {
  mapClientManager: {
    getClient: ReturnType<typeof vi.fn>;
  };
  acpStreamManager: {
    listStreams: ReturnType<typeof vi.fn>;
    closeStream: ReturnType<typeof vi.fn>;
    createStream: ReturnType<typeof vi.fn>;
    initialize: ReturnType<typeof vi.fn>;
    newSession: ReturnType<typeof vi.fn>;
  };
}

function createSwarmCraftStub(
  overrides: {
    callExtension?: ReturnType<typeof vi.fn>;
    newSessionId?: string;
    streamId?: string;
  } = {},
): SwarmCraftStub {
  const callExtension =
    overrides.callExtension ??
    vi.fn(async (_method: string, _params: any) => {
      // Default: _macro/spawnAgent returns an agent with a fresh ULID
      return { agent: { id: 'spawn-local-ulid', name: 'spawned', localId: 'agent_local_1' } };
    });

  const mapClient = { callExtension, isConnected: true };

  return {
    mapClientManager: {
      getClient: vi.fn().mockReturnValue(mapClient),
    },
    acpStreamManager: {
      listStreams: vi.fn().mockReturnValue([]),
      closeStream: vi.fn().mockResolvedValue(undefined),
      createStream: vi
        .fn()
        .mockResolvedValue({ streamId: overrides.streamId ?? 'acp-stream-1' }),
      initialize: vi.fn().mockResolvedValue({}),
      newSession: vi
        .fn()
        .mockResolvedValue({ sessionId: overrides.newSessionId ?? 'session_abc123' }),
    },
  };
}

async function createTestApp(config: Config, sc: SwarmCraftStub): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Routes read SwarmCraft off `(fastify as any).swarmcraft`; simulate that.
  (app as any).swarmcraft = sc;

  await app.register(
    async (api) => {
      await api.register(mapRoutes, { config });
      await api.register(sessionsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );

  return app;
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('agent lifecycle + ACP-connect routes', () => {
  let ownerAgent: { id: string; apiKey: string };
  let config: Config;
  let app: FastifyInstance;
  let sc: SwarmCraftStub;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initializeLocalSessionStorage({ type: 'local', basePath: TEST_STORAGE_PATH });

    const ownerResult = await agentsDAL.createAgent({
      name: 'owner',
      description: 'Test owner',
    });
    ownerAgent = { id: ownerResult.agent.id, apiKey: ownerResult.apiKey };
    config = createTestConfig();
  });

  beforeEach(async () => {
    sc = createSwarmCraftStub();
    app = await createTestApp(config, sc);
  });

  afterEach(async () => {
    // Unregister inbound test connections between tests
    for (const [id] of getAllInbound()) unregisterInbound(id);
    await app.close();
  });

  afterAll(async () => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  function auth() {
    return { authorization: `Bearer ${ownerAgent.apiKey}` };
  }

  // ── POST /map/swarms/:id/agents (spawn) ────────────────────

  describe('POST /map/swarms/:id/agents', () => {
    it('returns 404 when the swarm does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/swarms/does-not-exist/agents',
        headers: auth(),
        payload: { role: 'coordinator' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 503 when SwarmCraft MAP client is not connected', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'no-client',
        map_endpoint: 'ws://127.0.0.1:9900',
      });

      // Simulate no MAP client connected for this swarm
      sc.mapClientManager.getClient.mockReturnValueOnce(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/map/swarms/${swarm.id}/agents`,
        headers: auth(),
        payload: { role: 'coordinator' },
      });
      expect(res.statusCode).toBe(503);
    });

    it('proxies to _macro/spawnAgent and returns agent ids + resolved cwd', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'spawn-test',
        map_endpoint: 'ws://127.0.0.1:9901',
        metadata: { cwd: '/tmp/spawn-test' },
      });

      // Seed the inbound connection so the poll can resolve a hub agent id
      // once _macro/spawnAgent "completes".
      const spawnLocalUlid = '01TESTLOCALULIDXXXXXXXXX1';
      const spawnHubUlid = '01TESTHUBULIDXXXXXXXXXXXX1';

      sc.mapClientManager.getClient.mockReturnValueOnce({
        callExtension: vi.fn(async (method: string) => {
          expect(method).toBe('_macro/spawnAgent');
          // Simulate the sidecar's lifecycle bridge registering the agent
          // on the hub shortly after _macro/spawnAgent returns.
          setTimeout(() => {
            seedInboundConnection(swarm.id, {
              withCoordinator: { hubId: spawnHubUlid, peerMapId: spawnLocalUlid, name: 'spawned' },
            });
          }, 10);
          return { agent: { id: spawnLocalUlid, name: 'spawned', localId: 'agent_local_1' } };
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/map/swarms/${swarm.id}/agents`,
        headers: auth(),
        payload: { role: 'coordinator', task: 'Test' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.agent_id).toBe(spawnHubUlid);
      expect(body.peer_map_id).toBe(spawnLocalUlid);
      expect(body.role).toBe('coordinator');
      // cwd should have been resolved from swarm.metadata.cwd
      expect(body.cwd).toBe('/tmp/spawn-test');
    });

    it('falls back to spawnedId as agent_id if hub registration never lands', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'no-hub-registration',
        map_endpoint: 'ws://127.0.0.1:9902',
      });

      // Do not seed an inbound connection → poll times out → we use spawnedId.
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/map/swarms/${swarm.id}/agents`,
        headers: auth(),
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Default role when omitted
      expect(body.role).toBe('coordinator');
      // Stub returns 'spawn-local-ulid' — no hub id available, so it's echoed
      expect(body.agent_id).toBe('spawn-local-ulid');
      expect(body.peer_map_id).toBe('spawn-local-ulid');
      // Falls back to '.' when neither body nor swarm metadata supply a cwd
      expect(body.cwd).toBe('.');
    });
  });

  // ── POST /map/swarms/:id/agents/:agentId/stop ──────────────

  describe('POST /map/swarms/:id/agents/:agentId/stop', () => {
    it('returns 503 when no MAP client is connected', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'stop-no-client',
        map_endpoint: 'ws://127.0.0.1:9903',
      });
      sc.mapClientManager.getClient.mockReturnValueOnce(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/map/swarms/${swarm.id}/agents/any-id/stop`,
        headers: auth(),
        payload: { reason: 'cancelled' },
      });
      expect(res.statusCode).toBe(503);
    });

    it('resolves the agent peerMapId from metadata before terminating', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'stop-success',
        map_endpoint: 'ws://127.0.0.1:9904',
      });
      seedInboundConnection(swarm.id, {
        withCoordinator: { hubId: 'hub-1', peerMapId: 'local-1', name: 'agent-1' },
      });

      const callExtension = vi.fn(async (method: string, params: any) => {
        expect(method).toBe('_macro/terminateAgent');
        expect(params.agentId).toBe('local-1'); // peerMapId, not the hub id
        return { success: true };
      });
      sc.mapClientManager.getClient.mockReturnValueOnce({ callExtension });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/map/swarms/${swarm.id}/agents/hub-1/stop`,
        headers: auth(),
        payload: { reason: 'cancelled' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(callExtension).toHaveBeenCalledOnce();
    });

    it('uses the provided id as a fallback when no peerMapId is present', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'stop-no-localmap',
        map_endpoint: 'ws://127.0.0.1:9905',
      });
      // No coordinator seeded, no metadata to look up.

      const callExtension = vi.fn(async (_method: string, params: any) => {
        expect(params.agentId).toBe('unregistered-agent-id');
        return { success: true };
      });
      sc.mapClientManager.getClient.mockReturnValueOnce({ callExtension });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/map/swarms/${swarm.id}/agents/unregistered-agent-id/stop`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ── POST /sessions/acp-connect ─────────────────────────────

  describe('POST /sessions/acp-connect', () => {
    it('requires swarm_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/acp-connect',
        headers: auth(),
        payload: { agent_id: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/swarm_id/);
    });

    it('requires agent_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/acp-connect',
        headers: auth(),
        payload: { swarm_id: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/agent_id/);
    });

    it('returns 404 when swarm does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/acp-connect',
        headers: auth(),
        payload: { swarm_id: 'nope', agent_id: 'x' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when agent is not registered on the swarm', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'no-agent',
        map_endpoint: 'ws://127.0.0.1:9906',
      });
      seedInboundConnection(swarm.id); // sidecar only

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/acp-connect',
        headers: auth(),
        payload: { swarm_id: swarm.id, agent_id: 'ghost' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/not registered/);
    });

    it('returns 400 when the targeted agent does not advertise ACP', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'no-acp',
        map_endpoint: 'ws://127.0.0.1:9907',
      });
      const conn = seedInboundConnection(swarm.id);
      // Add a coordinator without ACP protocol
      conn.registeredAgents.set('no-acp-agent', {
        id: 'no-acp-agent',
        name: 'worker',
        role: 'worker',
        state: 'registered',
        scopes: [],
        capabilities: { messaging: { canReceive: true } }, // no protocols: ['acp']
        metadata: { peerMapId: 'local-noacp' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/acp-connect',
        headers: auth(),
        payload: { swarm_id: swarm.id, agent_id: 'no-acp-agent' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/ACP/);
    });

    it('accepts a peerMapId as agent_id and normalizes to it for the stream', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'acp-localmap',
        map_endpoint: 'ws://127.0.0.1:9908',
      });
      seedInboundConnection(swarm.id, {
        withCoordinator: {
          hubId: 'hub-acp-1',
          peerMapId: 'local-acp-1',
          name: 'coord',
          providerSessionId: 'provider-xyz',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/acp-connect',
        headers: auth(),
        // Caller supplies the peerMapId — handler should accept and use it
        payload: { swarm_id: swarm.id, agent_id: 'local-acp-1' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.acp_session_id).toBe('session_abc123');
      expect(body.acp_stream_id).toBe('acp-stream-1');
      expect(body.session_resource_id).toMatch(/^res_/);

      // createStream was called with the peerMapId
      expect(sc.acpStreamManager.createStream).toHaveBeenCalledWith(swarm.id, 'local-acp-1');
    });

    it('does NOT spawn an agent — no _macro/spawnAgent call is made on connect', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'no-spawn-on-connect',
        map_endpoint: 'ws://127.0.0.1:9909',
      });
      seedInboundConnection(swarm.id, {
        withCoordinator: { hubId: 'hub-ns', peerMapId: 'local-ns' },
      });

      const callExtension = vi.fn(async (..._args: any[]) => ({ agent: { id: 'should-not-be-called' } }));
      sc.mapClientManager.getClient.mockReturnValue({ callExtension });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/acp-connect',
        headers: auth(),
        payload: { swarm_id: swarm.id, agent_id: 'hub-ns' },
      });

      expect(res.statusCode).toBe(200);
      // The connect path must never call _macro/spawnAgent
      const spawnCalls = callExtension.mock.calls.filter((c: any[]) => c[0] === '_macro/spawnAgent');
      expect(spawnCalls).toHaveLength(0);
    });

    // TODO: this test pins the OLD acp-connect contract (close every peer
    // stream on the same swarm before creating a new one). The route was
    // since refactored to support multi-tab session sharing (Option 1B):
    // a second tab connecting to the same target REUSES the existing live
    // stream/session via findLiveAcpSession instead of closing it. The
    // close-and-create path now relies on acp-manager's per-target dedup
    // for orphan cleanup, not on the route enumerating + closing streams.
    // Rewrite this test (or split it) to verify the reuse behavior, then
    // remove `.skip`.
    it.skip('closes pre-existing streams on the same swarm before creating a new one', async () => {
      const swarm = mapDal.createSwarm(ownerAgent.id, {
        name: 'close-existing',
        map_endpoint: 'ws://127.0.0.1:9910',
      });
      seedInboundConnection(swarm.id, {
        withCoordinator: { hubId: 'hub-ce', peerMapId: 'local-ce' },
      });

      sc.acpStreamManager.listStreams.mockReturnValueOnce([
        { streamId: 'old-1', serverId: swarm.id, isClosed: false },
        { streamId: 'old-2', serverId: swarm.id, isClosed: false },
        { streamId: 'unrelated', serverId: 'other-swarm', isClosed: false },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/acp-connect',
        headers: auth(),
        payload: { swarm_id: swarm.id, agent_id: 'hub-ce' },
      });

      expect(res.statusCode).toBe(200);
      // Close called for both same-swarm streams, not for the unrelated one
      expect(sc.acpStreamManager.closeStream).toHaveBeenCalledWith('old-1');
      expect(sc.acpStreamManager.closeStream).toHaveBeenCalledWith('old-2');
      expect(sc.acpStreamManager.closeStream).not.toHaveBeenCalledWith('unrelated');
    });
  });
});
