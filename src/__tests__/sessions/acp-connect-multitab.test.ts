/**
 * E2E: /sessions/acp-connect multi-tab session sharing (Option 1B)
 *
 * Exercises the lookup-then-create + in-flight mutex behaviour against a
 * real Fastify instance with a mocked SwarmCraft acpStreamManager. We can
 * count manager calls because the mock records every invocation.
 *
 * What we verify:
 *  1. First call: full path runs once (createStream + initialize + newSession,
 *     persists session resource with acp_target_agent_id metadata).
 *  2. Second call (same owner+swarm+target): returns identical IDs and
 *     created=false; the manager was NOT called again.
 *  3. Concurrent calls share one in-flight Promise; the manager runs once.
 *  4. Cross-owner isolation: another user calling with the same swarm/agent
 *     gets a fresh session, not the first user's.
 *  5. After the in-memory stream is dropped (simulating a hub restart) the
 *     next call falls through to recreate.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { createSwarm } from '../../db/dal/map.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { ConfigSchema, type Config } from '../../config.js';
import { registerInbound, unregisterInbound } from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('acp-connect-multitab');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'acp-connect-multitab.db');

interface MockStreamState {
  serverId: string;
  targetAgent: string;
  isClosed?: boolean;
  initialized?: boolean;
}
interface MockCounters {
  createStream: number;
  initialize: number;
  newSession: number;
  /** Streams that have been created (by streamId). Mock can drop entries to
   *  simulate hub restart / stream death, or flip `isClosed` / `initialized`
   *  to simulate mid-flight failure / unfinished handshake. */
  streams: Map<string, MockStreamState>;
  /** Outbound MAP connection state. Toggle to simulate the socket dropping
   *  under a live stream — liveness check should detect this. */
  mapConnected: Map<string, boolean>;
  newSessionInputs: Array<{ cwd: string; mcpServers: unknown[] }>;
}

function createMockAcpManager(counters: MockCounters) {
  let nextStreamSeq = 0;
  let nextSessionSeq = 0;
  return {
    /** The inflight-mutex test depends on parallel POSTs reaching the
     *  manager's createStream simultaneously. Add a tiny artificial delay so
     *  both POSTs land in the critical section before either resolves. */
    streams: counters.streams,
    getStreamInfo: (streamId: string) => {
      const s = counters.streams.get(streamId);
      if (!s) return null;
      return {
        streamId,
        serverId: s.serverId,
        targetAgent: s.targetAgent,
        isClosed: s.isClosed ?? false,
        initialized: s.initialized ?? true,
      };
    },
    createStream: async (serverId: string, targetAgent: string) => {
      counters.createStream++;
      await new Promise((r) => setTimeout(r, 50));
      const streamId = `mock-stream-${++nextStreamSeq}`;
      counters.streams.set(streamId, {
        serverId,
        targetAgent,
        isClosed: false,
        initialized: false,
      });
      return { streamId, serverId, targetAgent };
    },
    initialize: async (streamId: string) => {
      counters.initialize++;
      const s = counters.streams.get(streamId);
      if (s) s.initialized = true;
    },
    newSession: async (_streamId: string, opts: { cwd: string; mcpServers: unknown[] }) => {
      counters.newSession++;
      counters.newSessionInputs.push(opts);
      return { sessionId: `mock-session-${++nextSessionSeq}` };
    },
  };
}

function createMockMapClientManager(counters: MockCounters) {
  return {
    isConnected: (serverId: string) => counters.mapConnected.get(serverId) ?? true,
  };
}

function buildConfig(): Config {
  return ConfigSchema.parse({
    port: 0,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: { name: 'multitab-test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
  });
}

describe('E2E: /sessions/acp-connect multi-tab session sharing', () => {
  let app: FastifyInstance;
  let counters: MockCounters;
  let owner: { id: string; apiKey: string };
  let other: { id: string; apiKey: string };
  const SWARM_ID = 'swarm_test_multitab';
  const ACP_AGENT_ID = 'agent_acp_target';

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const a = await agentsDAL.createAgent({ name: 'owner-tab' });
    const b = await agentsDAL.createAgent({ name: 'other-user' });
    owner = { id: a.agent.id, apiKey: a.apiKey };
    other = { id: b.agent.id, apiKey: b.apiKey };
    setLocalAgent(a.agent);

    // A swarm record is required by the route's findSwarmById guard.
    createSwarm(owner.id, {
      id: SWARM_ID,
      name: 'test-swarm',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
    });

    // The route resolves the ACP target through the connection registry's
    // findAcpAgent helper, which requires a live inbound connection with a
    // matching ACP-capable RegisteredAgent. Construct a minimal stub.
    registerInbound(SWARM_ID, {
      // ws is typed as the ws library's WebSocket (not the browser's) in the
      // connection registry; cast through unknown for the minimal stub.
      ws: { readyState: 1 } as never,
      agentId: owner.id,
      swarmId: SWARM_ID,
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map([[ACP_AGENT_ID, {
        id: ACP_AGENT_ID,
        name: 'mock-acp-coord',
        role: 'coordinator',
        state: 'idle',
        scopes: [],
        capabilities: { protocols: ['acp'] },
      }]]),
    });

    counters = {
      createStream: 0,
      initialize: 0,
      newSession: 0,
      streams: new Map(),
      mapConnected: new Map([[SWARM_ID, true]]),
      newSessionInputs: [],
    };

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    // Stub SwarmCraft plugin context with the mock manager.
    (app as unknown as { swarmcraft: unknown }).swarmcraft = {
      acpStreamManager: createMockAcpManager(counters),
      mapClientManager: createMockMapClientManager(counters),
    };
    await app.register(sessionsRoutes, { prefix: '/api/v1', config: buildConfig() });
    await app.ready();
  }, 15000);

  afterAll(async () => {
    setLocalAgent(null);
    unregisterInbound(SWARM_ID);
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    // Reset counters + persisted session resources between tests so each
    // case starts from a clean lookup state.
    counters.createStream = 0;
    counters.initialize = 0;
    counters.newSession = 0;
    counters.streams.clear();
    counters.newSessionInputs = [];
    counters.mapConnected.clear();
    counters.mapConnected.set(SWARM_ID, true);
    getDatabase().prepare(`DELETE FROM syncable_resources WHERE resource_type = 'session'`).run();
  });

  it('first connect runs createStream + initialize + newSession exactly once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.created).toBe(true);
    expect(body.acp_stream_id).toBe('mock-stream-1');
    expect(body.acp_session_id).toBe('mock-session-1');
    expect(body.session_resource_id).toMatch(/^res_/);

    expect(counters.createStream).toBe(1);
    expect(counters.initialize).toBe(1);
    expect(counters.newSession).toBe(1);
  });

  it('second connect with same owner+swarm+target reuses without touching the manager', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const aBody = JSON.parse(a.body);
    expect(a.statusCode).toBe(200);

    const b = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const bBody = JSON.parse(b.body);

    expect(b.statusCode).toBe(200);
    expect(bBody.created).toBe(false);
    expect(bBody.session_resource_id).toBe(aBody.session_resource_id);
    expect(bBody.acp_session_id).toBe(aBody.acp_session_id);
    expect(bBody.acp_stream_id).toBe(aBody.acp_stream_id);

    // Manager was NOT called for the second request.
    expect(counters.createStream).toBe(1);
    expect(counters.newSession).toBe(1);
  });

  it('does not reuse a live ACP session for a different cwd', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID, cwd: '/workspace/project-a' },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID, cwd: '/workspace/project-b' },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);

    expect(secondBody.created).toBe(true);
    expect(secondBody.session_resource_id).not.toBe(firstBody.session_resource_id);
    expect(secondBody.acp_session_id).not.toBe(firstBody.acp_session_id);
    expect(secondBody.acp_stream_id).not.toBe(firstBody.acp_stream_id);
    expect(counters.newSession).toBe(2);
    expect(counters.newSessionInputs.map((input) => input.cwd)).toEqual([
      '/workspace/project-a',
      '/workspace/project-b',
    ]);

    const secondResource = resourcesDAL.findResourceById(secondBody.session_resource_id);
    expect((secondResource?.metadata as Record<string, unknown>).projectPath).toBe('/workspace/project-b');
  });

  it('concurrent connects share the in-flight Promise (manager runs once)', async () => {
    const [a, b, c] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/sessions/acp-connect', payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID } }),
      app.inject({ method: 'POST', url: '/api/v1/sessions/acp-connect', payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID } }),
      app.inject({ method: 'POST', url: '/api/v1/sessions/acp-connect', payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID } }),
    ]);

    const aBody = JSON.parse(a.body);
    const bBody = JSON.parse(b.body);
    const cBody = JSON.parse(c.body);

    // All three return the same IDs.
    expect(bBody.acp_stream_id).toBe(aBody.acp_stream_id);
    expect(cBody.acp_stream_id).toBe(aBody.acp_stream_id);
    expect(bBody.acp_session_id).toBe(aBody.acp_session_id);
    expect(cBody.acp_session_id).toBe(aBody.acp_session_id);
    expect(bBody.session_resource_id).toBe(aBody.session_resource_id);
    expect(cBody.session_resource_id).toBe(aBody.session_resource_id);

    // Only the inflight leader actually built the session — the others
    // piggybacked. Manager calls should be 1, not 3.
    expect(counters.createStream).toBe(1);
    expect(counters.newSession).toBe(1);
  });

  it('different owner does not piggyback — gets a fresh session', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);

    // Switch to a different local agent — second request authenticates as them
    setLocalAgent(await agentsDAL.findAgentById(other.id) as never);
    try {
      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/acp-connect',
        payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
      });
      expect(second.statusCode).toBe(200);
      const secondBody = JSON.parse(second.body);
      expect(secondBody.created).toBe(true);
      expect(secondBody.acp_session_id).not.toBe(firstBody.acp_session_id);
      expect(secondBody.acp_stream_id).not.toBe(firstBody.acp_stream_id);
      expect(secondBody.session_resource_id).not.toBe(firstBody.session_resource_id);
    } finally {
      // Restore the test owner for subsequent tests.
      setLocalAgent(await agentsDAL.findAgentById(owner.id) as never);
    }

    // Manager ran twice (one per owner).
    expect(counters.createStream).toBe(2);
    expect(counters.newSession).toBe(2);
  });

  // ── Liveness check layers (7a) ──
  //
  // Each of these simulates a failure mode where the cached stream entry
  // exists in the manager's Map but is no longer usable. The route must
  // detect each case and fall through to a fresh create instead of handing
  // a corpse to the tab.

  it('falls through to recreate when cached stream is marked closed mid-flight', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const firstBody = JSON.parse(first.body);

    // Simulate the stream closing but the close-listener not having fired
    // yet (there's a brief async window where streams.has(id) is still true
    // but isClosed flipped).
    const state = counters.streams.get(firstBody.acp_stream_id);
    if (state) state.isClosed = true;

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const secondBody = JSON.parse(second.body);
    expect(second.statusCode).toBe(200);
    expect(secondBody.created).toBe(true);
    expect(secondBody.acp_stream_id).not.toBe(firstBody.acp_stream_id);
    expect(counters.createStream).toBe(2);
  });

  it('falls through to recreate when cached stream never completed its init handshake', async () => {
    // Plant a stream directly in the manager that's present but not yet
    // initialized — mimicking a createStream that crashed between the
    // createStream() return and a retry's subsequent initialize() call.
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const firstBody = JSON.parse(first.body);

    const state = counters.streams.get(firstBody.acp_stream_id);
    if (state) state.initialized = false;

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const secondBody = JSON.parse(second.body);
    expect(second.statusCode).toBe(200);
    expect(secondBody.created).toBe(true);
    expect(secondBody.acp_stream_id).not.toBe(firstBody.acp_stream_id);
  });

  it('falls through to recreate when the underlying MAP client is no longer connected', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const firstBody = JSON.parse(first.body);

    // Outbound connection dropped — stream entry still in the Map + looks
    // healthy, but nothing can actually reach the agent.
    counters.mapConnected.set(SWARM_ID, false);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const secondBody = JSON.parse(second.body);
    expect(second.statusCode).toBe(200);
    expect(secondBody.created).toBe(true);
    expect(secondBody.acp_stream_id).not.toBe(firstBody.acp_stream_id);

    // Restore connection for subsequent tests.
    counters.mapConnected.set(SWARM_ID, true);
  });

  it('falls through to recreate when the in-memory stream has died', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const firstBody = JSON.parse(first.body);
    expect(firstBody.created).toBe(true);

    // Simulate hub restart: stream gone, but persisted resource still says
    // it exists. The route's `streams.has(...)` check should detect this
    // and recreate.
    counters.streams.clear();

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const secondBody = JSON.parse(second.body);
    expect(second.statusCode).toBe(200);
    expect(secondBody.created).toBe(true);
    expect(secondBody.acp_stream_id).not.toBe(firstBody.acp_stream_id);
    expect(secondBody.acp_session_id).not.toBe(firstBody.acp_session_id);

    // Manager ran twice — once per real create.
    expect(counters.createStream).toBe(2);
    expect(counters.newSession).toBe(2);
  });

  it('persists acp_target_agent_id in metadata for future lookups', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/acp-connect',
      payload: { swarm_id: SWARM_ID, agent_id: ACP_AGENT_ID },
    });
    const body = JSON.parse(res.body);
    const found = resourcesDAL.findLiveAcpSession({
      ownerAgentId: owner.id,
      swarmId: SWARM_ID,
      acpTargetAgentId: ACP_AGENT_ID,
    });
    expect(found?.id).toBe(body.session_resource_id);
    expect((found?.metadata as Record<string, unknown>).acp_target_agent_id).toBe(ACP_AGENT_ID);
    expect((found?.metadata as Record<string, unknown>).source_swarm_id).toBe(SWARM_ID);
  });
});
