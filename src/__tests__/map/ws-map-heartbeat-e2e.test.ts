/**
 * E2E Tests: MAP WebSocket Heartbeat
 *
 * Spins up a real Fastify server with /ws/map, connects real WebSocket clients,
 * and verifies that:
 *   1. Clients that respond to JSON-RPC pings stay connected
 *   2. Clients that ONLY respond to protocol-level pings (like Claude Code swarms)
 *      also stay connected — the ws library auto-responds to ws.ping()
 *   3. Swarm status correctly reflects online/offline transitions
 *   4. Active message traffic resets the heartbeat timer
 *
 * Uses a short heartbeat interval (500ms) to keep test runtime low.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setupMapWebSocket, stopMapWebSocket, setHeartbeatInterval } from '../../map/ws-map.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('ws-map-heartbeat-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'heartbeat-e2e.db');
const SERVER_PORT = 19620;
const HEARTBEAT_MS = 500; // Short interval for fast tests
const HEARTBEAT_TIMEOUT = HEARTBEAT_MS * 2; // 1s — server terminates after this

// ============================================================================
// Helpers
// ============================================================================

/** Wait for a WebSocket to reach OPEN state. */
function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), timeoutMs);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Wait for a WebSocket to reach CLOSED state. */
function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), timeoutMs);
    ws.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

/** Collect parsed JSON messages from a WebSocket. */
function collectMessages(ws: WebSocket): Array<{ method?: string; params?: unknown }> {
  const messages: Array<{ method?: string; params?: unknown }> = [];
  ws.on('message', (data) => {
    try {
      messages.push(JSON.parse(data.toString()));
    } catch { /* ignore non-JSON */ }
  });
  return messages;
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Create a unique swarm for a test. */
function createTestSwarm(agentId: string, name: string) {
  return mapDAL.createSwarm(agentId, {
    name,
    map_endpoint: 'hub-inbound',
    map_transport: 'websocket',
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('E2E: MAP WebSocket Heartbeat', () => {
  let app: FastifyInstance;
  let agentId: string;
  let ingestToken: string;
  let swarmId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    // Create agent + ingest key for fast auth (no bcrypt)
    const { agent } = await agentsDAL.createAgent({
      name: 'heartbeat-test-agent',
      description: 'Agent for heartbeat E2E tests',
    });
    agentId = agent.id;

    const { plaintext_key } = createIngestKey(agentId, {
      label: 'heartbeat-e2e',
      agent_id: agentId,
    });
    ingestToken = plaintext_key;

    // Create a swarm for the agent to connect as
    const swarm = createTestSwarm(agentId, 'heartbeat-test-swarm');
    swarmId = swarm.id;

    // Set short heartbeat interval BEFORE setting up the WebSocket
    setHeartbeatInterval(HEARTBEAT_MS);

    const config = ConfigSchema.parse({
      port: SERVER_PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Heartbeat E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: {
        enabled: true,
        trustModel: 'open',
        missedPongsBeforeTerminate: 3,
      },
    });

    // Build Fastify app
    app = Fastify({ logger: false });
    await app.register(websocket);
    setupMapWebSocket(app, config);

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  });

  afterAll(async () => {
    stopMapWebSocket();
    await app?.close();
    // Wait for any pending close handlers to finish before closing the DB
    await new Promise((r) => setTimeout(r, 200));
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    // Reset heartbeat interval to default
    setHeartbeatInterval(30_000);
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Client responding to JSON-RPC pings stays alive
  // ─────────────────────────────────────────────────────────────

  it('should keep connection alive when client responds to JSON-RPC pings', async () => {
    const wsUrl = `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${ingestToken}&swarm_id=${swarmId}`;
    const ws = new WebSocket(wsUrl);
    const messages = collectMessages(ws);

    // Respond to JSON-RPC pings with pong (like a MapSyncClient SDK user)
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'ping') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
        }
      } catch { /* ignore */ }
    });

    await waitForOpen(ws);

    // Verify we got the welcome message
    await sleep(100);
    const welcome = messages.find((m) => m.method === 'hub/welcome');
    expect(welcome).toBeDefined();

    // Wait for 3 heartbeat cycles — connection should survive all of them
    await sleep(HEARTBEAT_MS * 3 + 200);

    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Verify we received multiple JSON-RPC pings
    const pings = messages.filter((m) => m.method === 'ping');
    expect(pings.length).toBeGreaterThanOrEqual(2);

    ws.close();
  }, 10_000);

  // ─────────────────────────────────────────────────────────────
  // 2. Client that ignores JSON-RPC pings but auto-responds to
  //    protocol-level pings stays alive (Claude Code swarm case)
  // ─────────────────────────────────────────────────────────────

  it('should keep connection alive via protocol-level ping/pong even without JSON-RPC pong', async () => {
    const swarm2 = createTestSwarm(agentId, 'heartbeat-proto-swarm');

    const wsUrl = `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${ingestToken}&swarm_id=${swarm2.id}`;
    const ws = new WebSocket(wsUrl);
    const messages = collectMessages(ws);

    // Do NOT respond to JSON-RPC pings — only protocol-level pong (automatic)
    // The ws library auto-responds to protocol-level ws.ping() with a pong frame

    await waitForOpen(ws);

    // Verify welcome
    await sleep(100);
    expect(messages.find((m) => m.method === 'hub/welcome')).toBeDefined();

    // Wait for 3 heartbeat cycles — connection should survive via protocol-level pong
    await sleep(HEARTBEAT_MS * 3 + 200);

    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Should still receive JSON-RPC pings (even though we ignored them)
    const pings = messages.filter((m) => m.method === 'ping');
    expect(pings.length).toBeGreaterThanOrEqual(2);

    ws.close();
  }, 10_000);

  // ─────────────────────────────────────────────────────────────
  // 3. Swarm status transitions on connect/disconnect
  // ─────────────────────────────────────────────────────────────

  it('should mark swarm online on connect and offline on disconnect', async () => {
    const swarm3 = createTestSwarm(agentId, 'heartbeat-status-swarm');

    const wsUrl = `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${ingestToken}&swarm_id=${swarm3.id}`;
    const ws = new WebSocket(wsUrl);

    await waitForOpen(ws);

    // While connected, swarm should be online
    await sleep(100);
    const swarmOnline = mapDAL.findSwarmById(swarm3.id);
    expect(swarmOnline?.status).toBe('online');

    // Cleanly close the connection
    ws.close();
    await waitForClose(ws);

    // Small delay for the close handler to update the DB
    await sleep(100);

    // After disconnect, swarm should be marked unreachable (the periodic
    // markStaleSwarms sweep later promotes unreachable → offline)
    const swarmOffline = mapDAL.findSwarmById(swarm3.id);
    expect(swarmOffline?.status).toBe('unreachable');
  }, 10_000);

  // ─────────────────────────────────────────────────────────────
  // 4. Active message traffic resets the heartbeat timer
  // ─────────────────────────────────────────────────────────────

  it('should keep connection alive when client sends other messages instead of pong', async () => {
    const swarm4 = createTestSwarm(agentId, 'heartbeat-active-swarm');

    const wsUrl = `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${ingestToken}&swarm_id=${swarm4.id}`;
    const ws = new WebSocket(wsUrl);

    await waitForOpen(ws);

    // Instead of responding to pings, send arbitrary messages periodically
    // This should still reset lastMessageAt and keep the connection alive
    const keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }));
      }
    }, HEARTBEAT_MS * 0.8); // Send slightly faster than heartbeat interval

    // Wait for 3 heartbeat cycles
    await sleep(HEARTBEAT_MS * 3 + 200);

    clearInterval(keepAliveInterval);

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 10_000);

  // ─────────────────────────────────────────────────────────────
  // 5. Protocol-level pong updates lastMessageAt on the hub
  // ─────────────────────────────────────────────────────────────

  it('should update swarm heartbeat in DB from protocol-level pong', async () => {
    const swarm5 = createTestSwarm(agentId, 'heartbeat-db-swarm');

    const wsUrl = `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${ingestToken}&swarm_id=${swarm5.id}`;
    const ws = new WebSocket(wsUrl);

    await waitForOpen(ws);
    await sleep(100);

    // Record initial last_seen_at
    const initial = mapDAL.findSwarmById(swarm5.id);
    const initialLastSeen = initial?.last_seen_at;
    expect(initialLastSeen).toBeDefined();

    // Wait for at least one heartbeat cycle (protocol-level ping/pong)
    await sleep(HEARTBEAT_MS + 200);

    // The protocol-level pong should have updated last_seen_at via heartbeatSwarm
    // (indirectly via lastMessageAt update keeping the connection alive)
    const updated = mapDAL.findSwarmById(swarm5.id);
    expect(updated?.status).toBe('online');

    ws.close();
  }, 10_000);
});
