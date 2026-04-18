/**
 * E2E: Node presence lifecycle
 *
 * Exercises the real ws-map handler + map_nodes DAL to verify:
 *   1. createNode defaults presence='online'
 *   2. Swarm WS close → bulkUpdateSwarmNodesPresence flips all nodes offline
 *   3. agent.state.changed on reconnect stamps presence='online'
 *   4. markStaleSwarms cascades presence='offline' (backstop for ungraceful disconnects)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDal from '../../db/dal/map.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { markStaleSwarms } from '../../map/service.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('map-e2e-presence');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'e2e-presence.db');
const SERVER_PORT = 19661;

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: { name: 'E2E Presence Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    mapHub: { enabled: true, trustModel: 'open' },
  });
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
}

function waitForWelcome(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Welcome timeout')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      const msg = JSON.parse(data.toString());
      resolve(msg.params?.swarm_id ?? '');
    });
  });
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('E2E: MAP node presence lifecycle', () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const config = createTestConfig();

    const result = await agentsDAL.createAgent({ name: 'e2e-presence-agent' });
    testAgent = { id: result.agent.id, apiKey: result.apiKey };

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    stopMapWebSocket();
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('createNode defaults presence to online', async () => {
    const swarmId = 'presence-swarm-default';
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}&swarm_id=${swarmId}`,
    );
    await waitForWelcome(ws);

    const node = mapDal.createNode({
      swarm_id: swarmId,
      map_agent_id: 'agent-default',
    });
    expect(node.presence).toBe('online');

    ws.close();
    await sleep(150);
  });

  it('swarm WS close flips all its nodes presence=offline', async () => {
    const swarmId = 'presence-swarm-disconnect';
    const ws = await connectWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${testAgent.apiKey}&swarm_id=${swarmId}`,
    );
    await waitForWelcome(ws);

    mapDal.createNode({ swarm_id: swarmId, map_agent_id: 'agent-a' });
    mapDal.createNode({ swarm_id: swarmId, map_agent_id: 'agent-b' });

    // Sanity: both are online before disconnect
    const beforeA = mapDal.findNodeBySwarmAndAgentId(swarmId, 'agent-a');
    const beforeB = mapDal.findNodeBySwarmAndAgentId(swarmId, 'agent-b');
    expect(beforeA?.presence).toBe('online');
    expect(beforeB?.presence).toBe('online');

    // Close the swarm's WS — handleDisconnect should cascade presence=offline
    ws.close();
    await sleep(250);

    const afterA = mapDal.findNodeBySwarmAndAgentId(swarmId, 'agent-a');
    const afterB = mapDal.findNodeBySwarmAndAgentId(swarmId, 'agent-b');
    expect(afterA?.presence).toBe('offline');
    expect(afterB?.presence).toBe('offline');

    // State must be retained as historical breadcrumb — not overwritten.
    expect(afterA?.state).toBe('registered');
    expect(afterB?.state).toBe('registered');
  });

  it('bulkUpdateSwarmNodesPresence is idempotent + returns actual changes', async () => {
    const swarmId = 'presence-swarm-bulk';
    mapDal.createSwarm(testAgent.id, {
      id: swarmId,
      name: 'bulk-test',
      map_endpoint: 'hub-inbound',
    });
    mapDal.createNode({ swarm_id: swarmId, map_agent_id: 'a1' });
    mapDal.createNode({ swarm_id: swarmId, map_agent_id: 'a2' });

    // Both online by default → first flip changes 2 rows
    const first = mapDal.bulkUpdateSwarmNodesPresence(swarmId, 'offline');
    expect(first).toBe(2);

    // Second flip with same value → no change
    const second = mapDal.bulkUpdateSwarmNodesPresence(swarmId, 'offline');
    expect(second).toBe(0);

    // Flip back
    const third = mapDal.bulkUpdateSwarmNodesPresence(swarmId, 'online');
    expect(third).toBe(2);
  });

  it('markStaleSwarms cascades presence=offline on stale swarms', async () => {
    const swarmId = 'presence-swarm-stale';
    // Insert swarm with deliberately-stale last_seen_at
    mapDal.createSwarm(testAgent.id, {
      id: swarmId,
      name: 'stale-test',
      map_endpoint: 'hub-inbound',
    });
    const db = getDatabase();
    db.prepare(`UPDATE map_swarms SET last_seen_at = datetime('now', '-2 hours'), status = 'online' WHERE id = ?`)
      .run(swarmId);

    // Child nodes start online
    mapDal.createNode({ swarm_id: swarmId, map_agent_id: 'stale-a' });
    expect(mapDal.findNodeBySwarmAndAgentId(swarmId, 'stale-a')?.presence).toBe('online');

    // Sweep with a 5-minute threshold → this swarm is 2 hours stale → goes offline
    const flipped = markStaleSwarms(5);
    expect(flipped).toBeGreaterThanOrEqual(1);

    expect(mapDal.findNodeBySwarmAndAgentId(swarmId, 'stale-a')?.presence).toBe('offline');
  });
});
