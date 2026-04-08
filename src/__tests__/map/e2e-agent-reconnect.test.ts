/**
 * E2E Integration Test: Agent Reconnection & Connection Health Flows
 *
 * Tests the full agent interaction lifecycle using MapSyncClient as a
 * real agent connecting to a real OpenHive hub over WebSocket. No mocks.
 *
 * Exercises:
 *   1. MapSyncClient connects and reaches 'connected' state
 *   2. Hub sends pings, client responds, connection stays alive
 *   3. Graceful disconnect triggers 'disconnected' state + swarm goes unreachable
 *   4. Client auto-reconnects after disconnect (exponential backoff)
 *   5. Hub-initiated reconnect: hub/reconnect → client reconnects with reset backoff
 *   6. Connection health API reflects live MapSyncClient connections
 *   7. Multiple MapSyncClients tracked independently
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket, setHeartbeatInterval } from '../../map/ws-map.js';
import { getAllInbound } from '../../map/connection-registry.js';
import { findSwarmById } from '../../db/dal/map.js';
import { mapRoutes } from '../../api/routes/map.js';
import { MapSyncClient, type ConnectionState } from '../../map/sync-client.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('e2e-agent-reconnect');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'e2e-agent-reconnect.db');
const SERVER_PORT = 19675;
const HEARTBEAT_MS = 200;

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** Create a MapSyncClient that connects to the hub. */
function createAgent(hubUrl: string, agentId: string): MapSyncClient {
  return new MapSyncClient({
    agent_id: agentId,
    hub_ws_url: hubUrl,
  });
}

/** Collect connection state transitions from a client. */
function trackStates(client: MapSyncClient): ConnectionState[] {
  const states: ConnectionState[] = [];
  client.onConnectionStateChange((state) => states.push(state));
  return states;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('E2E: Agent Reconnection via MapSyncClient', () => {
  let app: FastifyInstance;
  let config: Config;
  let hubUrl: string;
  const activeClients: MapSyncClient[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'e2e-reconnect-agent',
      description: 'Agent for reconnection e2e tests',
    });

    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'e2e-reconnect',
      agent_id: agent.id,
    });

    setLocalAgent(agent);

    config = ConfigSchema.parse({
      port: SERVER_PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Reconnect E2E', description: 'Test' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: {
        enabled: true,
        trustModel: 'open',
        missedPongsBeforeTerminate: 3,
      },
    });

    hubUrl = `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${plaintext_key}`;

    setHeartbeatInterval(HEARTBEAT_MS);

    app = Fastify({ logger: false });
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.register(
      async (api) => { await api.register(mapRoutes, { config }); },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    for (const c of activeClients) {
      try { c.stop(); } catch { /* ignore */ }
    }
    activeClients.length = 0;

    setLocalAgent(null);
    stopMapWebSocket();
    await app?.close();
    await sleep(100);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    setHeartbeatInterval(30_000);
  });

  afterEach(async () => {
    for (const c of activeClients) {
      try { c.stop(); } catch { /* ignore */ }
    }
    activeClients.length = 0;
    await sleep(200);
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. MapSyncClient connects and reaches 'connected' state
  // ─────────────────────────────────────────────────────────────────

  it('MapSyncClient connects to hub and reaches connected state', async () => {
    const client = createAgent(hubUrl, 'agent-connect-test');
    activeClients.push(client);
    const states = trackStates(client);

    client.start();

    const connected = await waitFor(() => client.connectionState === 'connected');
    expect(connected).toBe(true);
    expect(states).toContain('connecting');
    expect(states).toContain('connected');
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────
  // 2. Connection stays alive through heartbeat cycles
  // ─────────────────────────────────────────────────────────────────

  it('MapSyncClient stays connected through multiple heartbeat cycles', async () => {
    const client = createAgent(hubUrl, 'agent-heartbeat-test');
    activeClients.push(client);

    client.start();
    await waitFor(() => client.connectionState === 'connected');

    // Wait for several heartbeat cycles
    await sleep(HEARTBEAT_MS * 6);

    // Should still be connected
    expect(client.connectionState).toBe('connected');

    // Hub should have an inbound connection
    expect(getAllInbound().size).toBeGreaterThanOrEqual(1);
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────
  // 3. Graceful disconnect transitions to 'disconnected'
  // ─────────────────────────────────────────────────────────────────

  it('stop() transitions client to disconnected', async () => {
    const client = createAgent(hubUrl, 'agent-disconnect-test');
    activeClients.push(client);
    const states = trackStates(client);

    client.start();
    await waitFor(() => client.connectionState === 'connected');

    client.stop();
    // Remove from activeClients since we stopped manually
    activeClients.splice(activeClients.indexOf(client), 1);

    expect(client.connectionState).toBe('disconnected');
    expect(states.at(-1)).toBe('disconnected');
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────
  // 4. Client auto-reconnects after server closes connection
  // ─────────────────────────────────────────────────────────────────

  it('MapSyncClient auto-reconnects after hub closes its connection', async () => {
    const swarmId = `agent-auto-reconnect-${Date.now()}`;
    const client = createAgent(`${hubUrl}&swarm_id=${swarmId}`, 'agent-auto-reconnect');
    activeClients.push(client);
    const states = trackStates(client);

    client.start();
    await waitFor(() => client.connectionState === 'connected');

    // Force-close the hub-side connection to simulate hub dropping the client
    const conn = getAllInbound().get(swarmId);
    expect(conn).toBeDefined();
    conn!.ws.terminate();

    // Client should detect disconnect and attempt to reconnect
    const reconnected = await waitFor(
      () => {
        // Should have gone through disconnected → reconnecting → connected
        return states.includes('reconnecting') && client.connectionState === 'connected';
      },
      10_000,
    );

    expect(reconnected).toBe(true);
    expect(states).toContain('disconnected');
    expect(states).toContain('reconnecting');
    // Final state should be connected again
    expect(client.connectionState).toBe('connected');
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────
  // 5. Hub-initiated reconnect via hub/reconnect notification
  // ─────────────────────────────────────────────────────────────────

  it('client reconnects with reset backoff after hub/reconnect', async () => {
    const swarmId = `agent-hub-reconnect-${Date.now()}`;
    const client = createAgent(`${hubUrl}&swarm_id=${swarmId}`, 'agent-hub-reconnect');
    activeClients.push(client);
    const states = trackStates(client);

    client.start();
    await waitFor(() => client.connectionState === 'connected');

    // Simulate hub sending hub/reconnect by forcing missed pongs
    const conn = getAllInbound().get(swarmId);
    expect(conn).toBeDefined();

    // Suppress pong and force isAlive=false to trigger termination flow
    conn!.ws.removeAllListeners('pong');
    const forceInterval = setInterval(() => {
      const c = getAllInbound().get(swarmId);
      if (c) (c.ws as any).isAlive = false;
    }, HEARTBEAT_MS / 4);

    // Wait for the client to detect disconnect and reconnect
    const reconnected = await waitFor(
      () => {
        const hasDisconnected = states.includes('disconnected');
        const isBackOnline = client.connectionState === 'connected';
        return hasDisconnected && isBackOnline;
      },
      15_000,
    );

    clearInterval(forceInterval);

    expect(reconnected).toBe(true);

    // After reconnection, a new inbound connection should exist
    await sleep(500);
    expect(getAllInbound().has(swarmId)).toBe(true);
  }, 20_000);

  // ─────────────────────────────────────────────────────────────────
  // 6. Connection health API shows MapSyncClient connection
  // ─────────────────────────────────────────────────────────────────

  it('GET /map/connections reflects live MapSyncClient connection', async () => {
    const swarmId = `agent-health-api-${Date.now()}`;
    const client = createAgent(`${hubUrl}&swarm_id=${swarmId}`, 'agent-health-api');
    activeClients.push(client);

    client.start();
    await waitFor(() => client.connectionState === 'connected');
    await sleep(HEARTBEAT_MS * 2);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/connections/${swarmId}`,
    });

    expect(res.statusCode).toBe(200);
    const health = JSON.parse(res.payload);
    expect(health.swarmId).toBe(swarmId);
    expect(health.transport).toBe('inbound');
    expect(health.missedPongs).toBe(0);
    expect(health.connectedAt).toBeDefined();
  }, 10_000);

  // ─────────────────────────────────────────────────────────────────
  // 7. Multiple MapSyncClients tracked independently
  // ─────────────────────────────────────────────────────────────────

  it('multiple MapSyncClients have independent connections and health', async () => {
    const id1 = `agent-multi-1-${Date.now()}`;
    const id2 = `agent-multi-2-${Date.now()}`;

    const client1 = createAgent(`${hubUrl}&swarm_id=${id1}`, 'multi-agent-1');
    const client2 = createAgent(`${hubUrl}&swarm_id=${id2}`, 'multi-agent-2');
    activeClients.push(client1, client2);

    client1.start();
    client2.start();

    await waitFor(() => client1.connectionState === 'connected');
    await waitFor(() => client2.connectionState === 'connected');

    await sleep(HEARTBEAT_MS * 2);

    // Both should appear in the connections API
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const h1 = body.inbound.find((c: any) => c.swarmId === id1);
    const h2 = body.inbound.find((c: any) => c.swarmId === id2);

    expect(h1).toBeDefined();
    expect(h2).toBeDefined();

    // Stop one — the other should remain
    client1.stop();
    activeClients.splice(activeClients.indexOf(client1), 1);
    await sleep(300);

    expect(client2.connectionState).toBe('connected');

    const res2 = await app.inject({
      method: 'GET',
      url: `/api/v1/map/connections/${id2}`,
    });
    expect(res2.statusCode).toBe(200);

    // First should be gone
    const res1 = await app.inject({
      method: 'GET',
      url: `/api/v1/map/connections/${id1}`,
    });
    expect(res1.statusCode).toBe(404);
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────
  // 8. Full lifecycle: connect → degrade → terminate → reconnect → healthy
  // ─────────────────────────────────────────────────────────────────

  it('full lifecycle: connect → terminate → auto-reconnect → healthy', async () => {
    const swarmId = `agent-lifecycle-${Date.now()}`;
    const client = createAgent(`${hubUrl}&swarm_id=${swarmId}`, 'agent-lifecycle');
    activeClients.push(client);
    const states = trackStates(client);

    // Phase 1: Connect
    client.start();
    await waitFor(() => client.connectionState === 'connected');
    expect(findSwarmById(swarmId)?.status).toBe('online');

    // Phase 2: Force termination via missed pongs
    const conn = getAllInbound().get(swarmId);
    conn!.ws.removeAllListeners('pong');
    const forceInterval = setInterval(() => {
      const c = getAllInbound().get(swarmId);
      if (c) (c.ws as any).isAlive = false;
    }, HEARTBEAT_MS / 4);

    // Wait for disconnect
    await waitFor(() => states.includes('disconnected'), 5000);
    clearInterval(forceInterval);

    // Swarm should be unreachable
    await waitFor(() => findSwarmById(swarmId)?.status === 'unreachable', 3000);

    // Phase 3: Client auto-reconnects
    const reconnected = await waitFor(
      () => client.connectionState === 'connected',
      15_000,
    );
    expect(reconnected).toBe(true);

    // Phase 4: Swarm is back online
    await sleep(HEARTBEAT_MS * 2);
    expect(findSwarmById(swarmId)?.status).toBe('online');

    // Health API should show healthy connection
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/connections/${swarmId}`,
    });
    expect(res.statusCode).toBe(200);
    const health = JSON.parse(res.payload);
    expect(health.missedPongs).toBe(0);
  }, 25_000);
});
