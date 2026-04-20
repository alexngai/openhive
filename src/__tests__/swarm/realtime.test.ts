/**
 * E2E Tests: Swarm Realtime WebSocket Events
 *
 * Verifies that clients subscribed to `map:discovery` receive real-time
 * events when swarm state changes, without needing to poll or refresh:
 *
 *   1. Connect WS client, subscribe to map:discovery
 *   2. Spawn a swarm → receive `swarm_spawned` event
 *   3. Stop the swarm  → receive `swarm_stopped` event
 *   4. Verify unsubscribed clients do NOT receive events
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { SwarmManager } from '../../swarm/manager.js';
import { setupWebSocket } from '../../realtime/index.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import * as dal from '../../swarm/dal.js';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('swarm-realtime');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'realtime.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const MAP_SERVER_SCRIPT = path.join(FIXTURES_DIR, 'map-server.js');

const PORT_RANGE_MIN = 19600;
const PORT_RANGE_MAX = 19610;
const SERVER_PORT = 19699;

// ============================================================================
// Helpers
// ============================================================================

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: { name: 'Realtime Test', description: 'Realtime e2e test instance' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      openswarm_command: `node ${MAP_SERVER_SCRIPT}`,
      data_dir: TEST_DATA_DIR,
      port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX],
      max_swarms: 5,
      health_check_interval: 600000,
      max_health_failures: 3,
      auto_restart: false,
    },
  });
}

/** Wait for a condition to become true, polling every `intervalMs`. */
async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

interface ParsedWSEvent {
  type: string;
  channel?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

/** Connect a WS client and wait for the welcome message. */
function connectWS(token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = token
      ? `ws://127.0.0.1:${SERVER_PORT}/ws?token=${encodeURIComponent(token)}`
      : `ws://127.0.0.1:${SERVER_PORT}/ws`;

    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS connection timeout'));
    }, 5000);

    ws.on('message', () => {
      // Welcome message received
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Subscribe to channels and wait for the subscription ack. */
function subscribe(ws: WebSocket, channels: string[]): Promise<ParsedWSEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Subscribe ack timeout')), 5000);

    const handler = (data: Buffer | string) => {
      const msg: ParsedWSEvent = JSON.parse(data.toString());
      if (msg.data && 'subscribed' in msg.data) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'subscribe', channels }));
  });
}

/** Collect all WS events of a given type until timeout. */
function waitForEvent(
  ws: WebSocket,
  eventType: string,
  timeoutMs = 15000,
): Promise<ParsedWSEvent | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(null);
    }, timeoutMs);

    const handler = (data: Buffer | string) => {
      const msg: ParsedWSEvent = JSON.parse(data.toString());
      if (msg.type === eventType) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };

    ws.on('message', handler);
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('E2E: Swarm Realtime WebSocket Events', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let testAgent: { id: string; apiKey: string; name: string };
  const agentsByKey = new Map<string, { id: string; name: string }>();

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initTokenService(undefined, TEST_ROOT);
    config = createTestConfig();

    // Create test agent
    const agentResult = await agentsDAL.createAgent({
      name: 'realtime-test-agent',
      description: 'Agent for realtime E2E tests',
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey, name: 'realtime-test-agent' };
    agentsByKey.set(agentResult.apiKey, { id: agentResult.agent.id, name: 'realtime-test-agent' });

    // Initialize SwarmManager
    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );

    // Build Fastify app
    app = Fastify({ logger: false });
    app.decorateRequest('agent');

    app.addHook('preHandler', async (request: any) => {
      const auth = request.headers.authorization;
      if (auth && auth.startsWith('Bearer ')) {
        const token = auth.slice(7);
        const agent = agentsByKey.get(token);
        if (agent) request.agent = agent;
      }
    });

    (app as any).swarmManager = swarmManager;

    await app.register(websocket);

    // Register the real WebSocket handler (map:discovery channel support)
    setupWebSocket(app);

    // Register swarm hosting routes
    await app.register(
      async (api) => {
        await api.register(swarmHostingRoutes, { config });
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 30000);

  afterAll(async () => {
    await swarmManager.shutdown();
    await app.close();
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ==========================================================================
  // 1. Subscribed client receives swarm_spawned event
  // ==========================================================================

  describe('swarm_spawned event', () => {
    let spawnedId: string;
    let wsClient: WebSocket;

    afterAll(() => {
      if (wsClient?.readyState === WebSocket.OPEN) wsClient.close();
    });

    it('should deliver swarm_spawned to a subscribed WS client', async () => {
      // Connect and subscribe
      wsClient = await connectWS(testAgent.apiKey);
      await subscribe(wsClient, ['map:discovery']);

      // Start listening for the event before spawning
      const eventPromise = waitForEvent(wsClient, 'swarm_spawned', 35000);

      // Spawn via API
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'realtime-spawn-test', adapter: 'macro-agent' },
      });

      expect(response.statusCode).toBe(201);
      spawnedId = JSON.parse(response.body).id;

      // Wait for the swarm to reach running state (triggers broadcast)
      const isRunning = await waitFor(() => {
        const hosted = dal.findHostedSwarmById(spawnedId);
        return hosted?.state === 'running';
      }, 35000);
      expect(isRunning).toBe(true);

      // Verify the WS event was received
      const event = await eventPromise;
      expect(event).not.toBeNull();
      expect(event!.type).toBe('swarm_spawned');
      expect(event!.channel).toBe('map:discovery');
      expect(event!.data?.hosted_swarm_id).toBe(spawnedId);
    }, 60000);

    // ========================================================================
    // 2. Subscribed client receives swarm_stopped event
    // ========================================================================

    it('should deliver swarm_stopped when the swarm is stopped', async () => {
      // Start listening before stopping
      const eventPromise = waitForEvent(wsClient, 'swarm_stopped', 15000);

      // Stop via API
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${spawnedId}/stop`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);

      // Verify the WS event was received
      const event = await eventPromise;
      expect(event).not.toBeNull();
      expect(event!.type).toBe('swarm_stopped');
      expect(event!.channel).toBe('map:discovery');
      expect(event!.data?.hosted_swarm_id).toBe(spawnedId);
    }, 20000);
  });

  // ==========================================================================
  // 3. Unsubscribed client does NOT receive events
  // ==========================================================================

  describe('unsubscribed client', () => {
    let wsClient: WebSocket;

    afterAll(() => {
      if (wsClient?.readyState === WebSocket.OPEN) wsClient.close();
    });

    it('should NOT receive swarm_spawned if not subscribed to map:discovery', async () => {
      // Connect but do NOT subscribe to map:discovery
      wsClient = await connectWS(testAgent.apiKey);

      // Listen for any swarm event
      const eventPromise = waitForEvent(wsClient, 'swarm_spawned', 10000);

      // Spawn via API
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'realtime-no-sub-test', adapter: 'macro-agent' },
      });

      expect(response.statusCode).toBe(201);
      const spawnedId = JSON.parse(response.body).id;

      // Wait for running state to ensure the event would have been broadcast
      await waitFor(() => {
        const hosted = dal.findHostedSwarmById(spawnedId);
        return hosted?.state === 'running';
      }, 35000);

      // The event should NOT have arrived
      const event = await eventPromise;
      expect(event).toBeNull();
    }, 60000);
  });
});
