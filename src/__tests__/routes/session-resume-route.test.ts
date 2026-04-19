/**
 * Tests for POST /sessions/:id/resume — durable resume path that works even
 * after the source swarm has been offline long enough for the registry's
 * stale-grace window to expire.
 *
 * Flow under test:
 *   1. Read provider_session_id + source_swarm_id off the resource metadata.
 *   2. Restart the hosted swarm if stopped (optional; we simulate already-up).
 *   3. Wait for the MAP client to hold a live connection.
 *   4. Call _macro/resumeAgent with provider_session_id.
 *   5. Open ACP stream + loadSession with _meta.provider_session_id.
 *   6. Update resource metadata with new streamId/sessionId.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { ConfigSchema, type Config } from '../../config.js';
import { initializeLocalSessionStorage } from '../../sessions/storage/index.js';
import {
  registerInbound,
  unregisterInbound,
  getAllInbound,
  type MapInboundConnection,
} from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

vi.mock('../../map/sync-listener.js', () => ({
  hasOutboundConnection: vi.fn().mockReturnValue(false),
  getSyncListenerStatus: vi.fn().mockReturnValue({ connected: 0, reconnecting: 0, connections: [] }),
  handleSyncMessage: vi.fn(),
  isMapSyncMessage: vi.fn().mockReturnValue(false),
}));

const TEST_ROOT = testRoot('session-resume-route');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'session-resume-route.db');
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

function createMockWs(): any {
  return {
    readyState: 1,
    isAlive: true,
    close() {}, terminate() {}, ping() {}, send() {}, on() {}, removeListener() {},
  };
}

function seedLiveInbound(swarmId: string): MapInboundConnection {
  const conn: MapInboundConnection = {
    ws: createMockWs(),
    agentId: 'hub-agent-1',
    swarmId,
    connectedAt: '2026-04-15T00:00:00.000Z',
    lastMessageAt: '2026-04-15T00:01:00.000Z',
    registeredAgents: new Map(),
  };
  // Don't seed any registered agents — the resume flow doesn't require
  // them pre-existing (that's the whole point: registry metadata may have
  // been swept). The lifecycle-bridge poll is bounded and will just fall
  // through to opening the ACP stream regardless.
  registerInbound(swarmId, conn);
  return conn;
}

interface SwarmCraftStub {
  mapClientManager: { getClient: ReturnType<typeof vi.fn> };
  acpStreamManager: {
    createStream: ReturnType<typeof vi.fn>;
    initialize: ReturnType<typeof vi.fn>;
    loadSession: ReturnType<typeof vi.fn>;
  };
}

function createSwarmCraftStub(overrides: {
  callExtension?: ReturnType<typeof vi.fn>;
  streamId?: string;
} = {}): SwarmCraftStub {
  const callExtension = overrides.callExtension ??
    vi.fn(async (_method: string, _params: any) => ({
      success: true,
      agent: { id: 'peer-map-ulid', localId: 'agent_local_1', name: 'coord', role: 'coordinator' },
      acpSessionId: 'acp-session-123',
      providerSessionId: 'psid-xyz',
    }));

  return {
    mapClientManager: {
      getClient: vi.fn().mockReturnValue({ callExtension, isConnected: true }),
    },
    acpStreamManager: {
      createStream: vi.fn().mockResolvedValue({ streamId: overrides.streamId ?? 'acp-stream-99' }),
      initialize: vi.fn().mockResolvedValue({}),
      loadSession: vi.fn().mockResolvedValue({}),
    },
  };
}

async function createTestApp(config: Config, sc: SwarmCraftStub): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as any).swarmcraft = sc;
  await app.register(async (api) => {
    await api.register(sessionsRoutes, { config });
  }, { prefix: '/api/v1' });
  return app;
}

describe('POST /sessions/:id/resume', () => {
  let ownerAgent: { id: string; apiKey: string };
  let otherAgent: { id: string; apiKey: string };
  let config: Config;
  let app: FastifyInstance;
  let sc: SwarmCraftStub;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initializeLocalSessionStorage({ type: 'local', basePath: TEST_STORAGE_PATH });

    const owner = await agentsDAL.createAgent({ name: 'owner', description: 'Owner' });
    ownerAgent = { id: owner.agent.id, apiKey: owner.apiKey };
    const other = await agentsDAL.createAgent({ name: 'other', description: 'Other' });
    otherAgent = { id: other.agent.id, apiKey: other.apiKey };
    config = createTestConfig();
  });

  beforeEach(async () => {
    sc = createSwarmCraftStub();
    app = await createTestApp(config, sc);
  });

  afterEach(async () => {
    for (const [id] of getAllInbound()) unregisterInbound(id);
    await app.close();
  });

  afterAll(async () => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  function auth(key?: string) {
    return { authorization: `Bearer ${key ?? ownerAgent.apiKey}` };
  }

  let seedCounter = 0;
  function seedResumableSession(overrides: {
    ownerId?: string;
    swarmId?: string;
    providerSessionId?: string;
    sessionId?: string;
  } = {}) {
    const n = ++seedCounter;
    return resourcesDAL.createResource({
      resource_type: 'session',
      name: `test-session-${n}`,
      description: 'Resumable',
      git_remote_url: `map://session/${overrides.sessionId ?? `acp-session-${n}`}`,
      owner_agent_id: overrides.ownerId ?? ownerAgent.id,
      scope: 'manual',
      metadata: {
        source_swarm_id: overrides.swarmId ?? 'swarm-1',
        provider_session_id: overrides.providerSessionId ?? 'psid-xyz',
        sessionId: overrides.sessionId ?? `acp-session-${n}`,
        projectPath: '/tmp/project',
      },
    });
  }

  it('returns 404 when session resource does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/does-not-exist/resume',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when session is missing provider_session_id', async () => {
    const resource = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'no-psid',
      description: 'no psid',
      git_remote_url: 'map://session/abc',
      owner_agent_id: ownerAgent.id,
      scope: 'manual',
      metadata: { source_swarm_id: 'swarm-1', sessionId: 'acp-session-no-psid' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resource.id}/resume`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'NOT_RESUMABLE' });
  });

  it('returns 403 when a different agent tries to resume a private session', async () => {
    const resource = seedResumableSession();
    // Ensure swarm is live so we don't fail earlier on connection wait.
    seedLiveInbound('swarm-1');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resource.id}/resume`,
      headers: auth(otherAgent.apiKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 504 when the swarm never reconnects', async () => {
    const resource = seedResumableSession();
    // Simulate no MAP client available on the source swarm.
    sc.mapClientManager.getClient.mockReturnValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resource.id}/resume`,
      headers: auth(),
    });
    // The route waits up to 30s; in tests it will eventually 504. We don't
    // want to actually wait 30s — stub the mapClient to be disconnected (returns
    // undefined) and assert the 504. Note: vitest defaults to 5s test timeout —
    // we bump only this test.
    expect(res.statusCode).toBe(504);
  }, 45_000);

  it('returns 502 when macro-agent reports failure', async () => {
    const resource = seedResumableSession();
    seedLiveInbound('swarm-1');

    sc = createSwarmCraftStub({
      callExtension: vi.fn(async () => ({ success: false, error: 'agent not found in store' })),
    });
    // Rebuild the app so the stub swap is picked up by the route closure.
    await app.close();
    app = await createTestApp(config, sc);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resource.id}/resume`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'RESUME_FAILED' });
  });

  it('resumes successfully: calls _macro/resumeAgent, opens stream, loadSession with _meta', async () => {
    const resource = seedResumableSession();
    seedLiveInbound('swarm-1');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resource.id}/resume`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      session_resource_id: resource.id,
      acp_session_id: 'acp-session-123',
      acp_stream_id: 'acp-stream-99',
    });

    // Verify macro-agent was asked to resume by providerSessionId.
    const mapClient = sc.mapClientManager.getClient('swarm-1');
    expect(mapClient.callExtension).toHaveBeenCalledWith('_macro/resumeAgent', expect.objectContaining({
      providerSessionId: 'psid-xyz',
    }));

    // Verify ACP stream was opened against the returned peerMapId.
    expect(sc.acpStreamManager.createStream).toHaveBeenCalledWith('swarm-1', 'peer-map-ulid');
    expect(sc.acpStreamManager.initialize).toHaveBeenCalledWith('acp-stream-99');

    // Verify loadSession was called with _meta.provider_session_id so Claude
    // Code can replay its on-disk JSONL transcript.
    expect(sc.acpStreamManager.loadSession).toHaveBeenCalledWith(
      'acp-stream-99',
      expect.objectContaining({
        sessionId: 'acp-session-123',
        cwd: '/tmp/project',
        _meta: { provider_session_id: 'psid-xyz' },
      }),
    );

    // Verify resource metadata was updated with the new stream.
    const refreshed = resourcesDAL.findResourceById(resource.id)!;
    const meta = refreshed.metadata as Record<string, unknown>;
    expect(meta.acpStreamId).toBe('acp-stream-99');
    expect(meta.sessionId).toBe('acp-session-123');
    expect(meta.provider_session_id).toBe('psid-xyz');
  });

  it('accepts cwd override from request body', async () => {
    const resource = seedResumableSession();
    seedLiveInbound('swarm-1');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resource.id}/resume`,
      headers: auth(),
      payload: { cwd: '/custom/path' },
    });

    expect(res.statusCode).toBe(200);
    expect(sc.acpStreamManager.loadSession).toHaveBeenCalledWith(
      'acp-stream-99',
      expect.objectContaining({ cwd: '/custom/path' }),
    );
  });

  it('falls back to resource metadata sessionId when macro-agent omits acpSessionId', async () => {
    const resource = seedResumableSession({ sessionId: 'stored-acp-id' });
    seedLiveInbound('swarm-1');

    sc = createSwarmCraftStub({
      callExtension: vi.fn(async () => ({
        success: true,
        agent: { id: 'peer-map-ulid', localId: 'agent_local_1' },
        // macro-agent returns no acpSessionId — fall back to stored metadata.
        providerSessionId: 'psid-xyz',
      })),
    });
    await app.close();
    app = await createTestApp(config, sc);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resource.id}/resume`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ acp_session_id: 'stored-acp-id' });
  });

  it('returns 502 when loadSession fails', async () => {
    const resource = seedResumableSession();
    seedLiveInbound('swarm-1');

    sc.acpStreamManager.loadSession = vi.fn().mockRejectedValue(new Error('replay failed'));

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resource.id}/resume`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'LOAD_FAILED' });
  });

  // ────────────────────────────────────────────────────────────────
  // GET /map/swarms/:id/resumable-sessions
  // ────────────────────────────────────────────────────────────────

  describe('GET /map/swarms/:id/resumable-sessions', () => {
    it('returns only sessions on the requested swarm with a provider_session_id', async () => {
      // Seed three sessions: one on the target swarm with psid (resumable),
      // one on the target swarm without psid (NOT resumable — missing the
      // prereq for durable resume), and one on a different swarm (filtered
      // out by source_swarm_id).
      seedResumableSession({ swarmId: 'swarm-target', providerSessionId: 'psid-a' });
      resourcesDAL.createResource({
        resource_type: 'session',
        name: `no-psid-${Date.now()}`,
        description: '',
        git_remote_url: `map://session/no-psid-${Date.now()}`,
        owner_agent_id: ownerAgent.id,
        scope: 'manual',
        metadata: { source_swarm_id: 'swarm-target' /* no psid */ },
      });
      seedResumableSession({ swarmId: 'swarm-other', providerSessionId: 'psid-elsewhere' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/map/swarms/swarm-target/resumable-sessions',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.swarm_id).toBe('swarm-target');
      expect(body.total).toBe(1);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].provider_session_id_prefix).toBe('psid-a');
    });

    it('filters to the caller by default (only their own sessions)', async () => {
      // Owner has one resumable on swarm-scoped; other agent has one too.
      seedResumableSession({ swarmId: 'swarm-scoped', providerSessionId: 'psid-mine' });
      seedResumableSession({ swarmId: 'swarm-scoped', providerSessionId: 'psid-theirs', ownerId: otherAgent.id });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/map/swarms/swarm-scoped/resumable-sessions',
        headers: auth(),
      });
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.sessions[0].provider_session_id_prefix).toBe('psid-mine');
    });

    it('returns empty list for a swarm with no resumable sessions', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/map/swarms/swarm-empty/resumable-sessions',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ swarm_id: 'swarm-empty', total: 0, sessions: [] });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // POST /map/swarms/:id/resume-all
  // ────────────────────────────────────────────────────────────────

  describe('POST /map/swarms/:id/resume-all', () => {
    it('fans out to each session and aggregates the results', async () => {
      const r1 = seedResumableSession({ swarmId: 'swarm-batch', providerSessionId: 'psid-1' });
      const r2 = seedResumableSession({ swarmId: 'swarm-batch', providerSessionId: 'psid-2' });
      const r3 = seedResumableSession({ swarmId: 'swarm-batch', providerSessionId: 'psid-3' });
      seedLiveInbound('swarm-batch');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/swarms/swarm-batch/resume-all',
        headers: auth(),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.succeeded).toHaveLength(3);
      expect(body.failed).toHaveLength(0);
      const successIds = body.succeeded.map((s: { session_resource_id: string }) => s.session_resource_id).sort();
      expect(successIds).toEqual([r1.id, r2.id, r3.id].sort());

      // Each session triggers createStream + loadSession — verify fan-out
      expect(sc.acpStreamManager.createStream).toHaveBeenCalledTimes(3);
      expect(sc.acpStreamManager.loadSession).toHaveBeenCalledTimes(3);
    });

    it('returns partial results when some sessions fail', async () => {
      const r1 = seedResumableSession({ swarmId: 'swarm-partial', providerSessionId: 'psid-ok' });
      const r2 = seedResumableSession({ swarmId: 'swarm-partial', providerSessionId: 'psid-bad' });
      seedLiveInbound('swarm-partial');

      // macro-agent returns success for psid-ok, failure for psid-bad.
      const callExtension = vi.fn(async (_method: string, params: any) => {
        if (params.providerSessionId === 'psid-bad') {
          return { success: false, error: 'agent not in store' };
        }
        return {
          success: true,
          agent: { id: 'peer-ok', localId: 'local-ok' },
          acpSessionId: 'acp-session-ok',
          providerSessionId: params.providerSessionId,
        };
      });
      sc = createSwarmCraftStub({ callExtension });
      await app.close();
      app = await createTestApp(config, sc);
      seedLiveInbound('swarm-partial');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/swarms/swarm-partial/resume-all',
        headers: auth(),
        payload: {},
      });
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.succeeded).toHaveLength(1);
      expect(body.failed).toHaveLength(1);
      expect(body.succeeded[0].session_resource_id).toBe(r1.id);
      expect(body.failed[0]).toMatchObject({
        session_resource_id: r2.id,
        error: 'RESUME_FAILED',
      });
    });

    it('returns an empty batch when the swarm has no resumable sessions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/swarms/swarm-empty-batch/resume-all',
        headers: auth(),
        payload: {},
      });
      const body = res.json();
      expect(body).toMatchObject({ total: 0, succeeded: [], failed: [] });
    });

    it('respects concurrency bound (no more than N in flight at once)', async () => {
      // Seed 6 sessions; limit to concurrency=2. Track active callExtension
      // invocations to verify the cap is honored.
      for (let i = 0; i < 6; i++) {
        seedResumableSession({ swarmId: 'swarm-conc', providerSessionId: `psid-c${i}` });
      }
      seedLiveInbound('swarm-conc');

      let inFlight = 0;
      let maxObserved = 0;
      const slowExtension = vi.fn(async (_method: string, params: any) => {
        inFlight++;
        maxObserved = Math.max(maxObserved, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        return {
          success: true,
          agent: { id: 'p', localId: 'l' },
          acpSessionId: 'acp-' + params.providerSessionId,
          providerSessionId: params.providerSessionId,
        };
      });
      sc = createSwarmCraftStub({ callExtension: slowExtension });
      await app.close();
      app = await createTestApp(config, sc);
      seedLiveInbound('swarm-conc');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/swarms/swarm-conc/resume-all',
        headers: auth(),
        payload: { concurrency: 2 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().succeeded).toHaveLength(6);
      expect(maxObserved).toBeLessThanOrEqual(2);
    });
  });
});
