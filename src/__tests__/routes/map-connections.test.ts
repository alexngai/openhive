/**
 * Tests for GET /map/connections and GET /map/connections/:swarmId endpoints.
 *
 * Verifies live connection health data is exposed via the API.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { getOrCreateLocalAgent } from '../../db/dal/agents.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { mapRoutes } from '../../api/routes/map.js';
import { ConfigSchema, type Config } from '../../config.js';
import {
  registerInbound,
  unregisterInbound,
  getAllInbound,
  type MapInboundConnection,
} from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel and sync-listener
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

vi.mock('../../map/sync-listener.js', () => ({
  hasOutboundConnection: vi.fn().mockReturnValue(false),
  getSyncListenerStatus: vi.fn().mockReturnValue({
    connected: 1,
    reconnecting: 0,
    connections: [
      { swarmId: 'outbound-1', name: 'Remote Swarm', status: 'connected' },
    ],
  }),
  handleSyncMessage: vi.fn(),
  isMapSyncMessage: vi.fn().mockReturnValue(false),
}));

const TEST_ROOT = testRoot('map-connections');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'map-connections.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

function createMockWs(missedPongs = 0): any {
  return {
    readyState: 1, // WebSocket.OPEN
    missedPongs,
    isAlive: true,
    close() { /* noop */ },
    terminate() { /* noop */ },
    ping() { /* noop */ },
    send() { /* noop */ },
    on() { /* noop */ },
    removeListener() { /* noop */ },
  };
}

function registerTestConnection(
  swarmId: string,
  opts: { missedPongs?: number; agentId?: string; tokenExpiresAt?: string } = {},
) {
  const ws = createMockWs(opts.missedPongs ?? 0);
  const conn: MapInboundConnection = {
    ws,
    agentId: opts.agentId ?? 'agent-1',
    swarmId,
    connectedAt: '2026-04-06T10:00:00.000Z',
    lastMessageAt: '2026-04-06T10:05:00.000Z',
    tokenExpiresAt: opts.tokenExpiresAt,
    registeredAgents: new Map(),
  };
  registerInbound(swarmId, conn);
  return conn;
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    async (api) => {
      await api.register(mapRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('GET /map/connections', () => {
  let app: FastifyInstance;
  let config: Config;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    config = createTestConfig();

    const agent = await getOrCreateLocalAgent();
    setLocalAgent(agent);

    app = await createTestApp(config);
  });

  afterEach(() => {
    // Clean up inbound connections between tests
    for (const [id] of getAllInbound()) {
      unregisterInbound(id);
    }
  });

  afterAll(async () => {
    setLocalAgent(null);
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('returns empty inbound list when no connections', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.inbound).toEqual([]);
    expect(body.summary.inbound_count).toBe(0);
    expect(body.summary.degraded).toBe(0);
  });

  it('returns inbound connections with health data', async () => {
    registerTestConnection('swarm-healthy', { missedPongs: 0 });
    registerTestConnection('swarm-degraded', { missedPongs: 2 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.inbound.length).toBe(2);
    expect(body.summary.inbound_count).toBe(2);
    expect(body.summary.degraded).toBe(1);

    const healthy = body.inbound.find((c: any) => c.swarmId === 'swarm-healthy');
    expect(healthy).toBeDefined();
    expect(healthy.missedPongs).toBe(0);
    expect(healthy.connectedAt).toBe('2026-04-06T10:00:00.000Z');

    const degraded = body.inbound.find((c: any) => c.swarmId === 'swarm-degraded');
    expect(degraded).toBeDefined();
    expect(degraded.missedPongs).toBe(2);
  });

  it('includes outbound connection status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections',
    });

    const body = JSON.parse(res.payload);
    expect(body.outbound.length).toBe(1);
    expect(body.outbound[0].swarmId).toBe('outbound-1');
    expect(body.outbound[0].status).toBe('connected');
    expect(body.summary.outbound_connected).toBe(1);
  });

  it('uses configured missedPongsBeforeTerminate as maxMissedPongs', async () => {
    registerTestConnection('swarm-config-test');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections',
    });

    const body = JSON.parse(res.payload);
    const conn = body.inbound[0];
    expect(conn.maxMissedPongs).toBe(config.mapHub.missedPongsBeforeTerminate);
  });
});

describe('GET /map/connections/:swarmId', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const config = createTestConfig();

    const agent = await getOrCreateLocalAgent();
    setLocalAgent(agent);

    app = await createTestApp(config);
  });

  afterEach(() => {
    for (const [id] of getAllInbound()) {
      unregisterInbound(id);
    }
  });

  afterAll(async () => {
    setLocalAgent(null);
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('returns 404 for unknown swarm', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections/nonexistent-swarm',
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('Not Found');
  });

  it('returns connection health for a specific swarm', async () => {
    registerTestConnection('swarm-detail', {
      missedPongs: 1,
      tokenExpiresAt: '2026-04-06T12:00:00.000Z',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections/swarm-detail',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.swarmId).toBe('swarm-detail');
    expect(body.missedPongs).toBe(1);
    expect(body.tokenExpiresAt).toBe('2026-04-06T12:00:00.000Z');
    expect(body.transport).toBe('inbound');
    expect(body.registeredAgentCount).toBe(0);
  });
});
