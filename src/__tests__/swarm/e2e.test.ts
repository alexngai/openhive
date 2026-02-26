/**
 * End-to-End Tests: Swarm Hosting + Terminal WebSocket
 *
 * These tests spawn a real Fastify server with SwarmManager, a mock OpenSwarm
 * MAP server (fixtures/map-server.js), and verify the full flow:
 *
 *   1. Spawn a hosted swarm via the API → mock MAP server starts
 *   2. Verify it reaches "running" state with health checks passing
 *   3. Fetch terminal-info for the running swarm
 *   4. Connect to /ws/terminal and verify PTY session lifecycle
 *   5. Verify the MAP endpoint URL uses the /map path
 *   6. Stop the swarm and verify cleanup
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { SwarmManager } from '../../swarm/manager.js';
import * as dal from '../../swarm/dal.js';
import { PtyManager, handleTerminalWebSocket } from '../../terminal/index.js';
import type { Config } from '../../config.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('swarm-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'e2e.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const MAP_SERVER_SCRIPT = path.join(FIXTURES_DIR, 'map-server.js');

// Use a high port range to avoid conflicts with other tests
const PORT_RANGE_MIN = 19500;
const PORT_RANGE_MAX = 19510;
const SERVER_PORT = 19599;

// ============================================================================
// Helpers
// ============================================================================

function createTestConfig(): Config {
  return {
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: {
      name: 'E2E Test OpenHive',
      description: 'E2E test instance',
      public: true,
    },
    admin: { createOnStartup: false },
    verification: { strategy: 'open', options: {} },
    rateLimit: { enabled: false, max: 100, timeWindow: '1 minute' },
    federation: { enabled: false, peers: [] },
    cors: { enabled: false, origin: true },
    email: { enabled: false, from: 'noreply@test.local' },
    jwt: { secret: 'e2e-test-secret-key', expiresIn: '7d' },
    githubApp: { enabled: false },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      openswarm_command: `node ${MAP_SERVER_SCRIPT}`,
      data_dir: TEST_DATA_DIR,
      port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX] as [number, number],
      max_swarms: 5,
      health_check_interval: 600000, // Very long — we don't need periodic checks
      max_health_failures: 3,
      auto_restart: false,
    },
  } as Config;
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

/** Collect WebSocket messages until a predicate matches or timeout. */
function collectWsMessages(
  ws: WebSocket,
  predicate: (messages: string[]) => boolean,
  timeoutMs = 10000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const timer = setTimeout(() => {
      ws.removeAllListeners('message');
      resolve(messages); // resolve with what we got even on timeout
    }, timeoutMs);

    ws.on('message', (data: Buffer | string) => {
      messages.push(data.toString());
      if (predicate(messages)) {
        clearTimeout(timer);
        ws.removeAllListeners('message');
        resolve(messages);
      }
    });
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('E2E: Swarm Hosting + Terminal WebSocket', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let ptyManager: PtyManager;
  let testAgent: { id: string; apiKey: string; name: string };
  let otherAgent: { id: string; apiKey: string; name: string };
  const agentsByKey = new Map<string, { id: string; name: string }>();

  let serverAddress: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    config = createTestConfig();

    // Create test agents
    const agentResult = await agentsDAL.createAgent({
      name: 'e2e-test-agent',
      description: 'Agent for E2E tests',
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey, name: 'e2e-test-agent' };
    agentsByKey.set(agentResult.apiKey, { id: agentResult.agent.id, name: 'e2e-test-agent' });

    const otherResult = await agentsDAL.createAgent({
      name: 'e2e-other-agent',
      description: 'Non-owner agent for E2E tests',
    });
    otherAgent = { id: otherResult.agent.id, apiKey: otherResult.apiKey, name: 'e2e-other-agent' };
    agentsByKey.set(otherResult.apiKey, { id: otherResult.agent.id, name: 'e2e-other-agent' });

    // Create test hive
    hivesDAL.createHive({
      name: 'e2e-test-hive',
      description: 'Test hive for E2E tests',
      owner_id: testAgent.id,
    });

    // Initialize SwarmManager
    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );

    // Initialize PTY Manager
    ptyManager = new PtyManager();

    // Build Fastify app with auth, websocket, routes
    app = Fastify({ logger: false });
    app.decorateRequest('agent', null);

    // Simple auth hook mapping Bearer tokens → agents
    app.addHook('preHandler', async (request: any) => {
      const auth = request.headers.authorization;
      if (auth && auth.startsWith('Bearer ')) {
        const token = auth.slice(7);
        const agent = agentsByKey.get(token);
        if (agent) request.agent = agent;
      }
    });

    // Attach managers
    (app as any).swarmManager = swarmManager;

    // Register WebSocket plugin
    await app.register(websocket);

    // Register terminal WebSocket at /ws/terminal
    app.get('/ws/terminal', { websocket: true }, (socket, request) => {
      const ws = socket as unknown as import('ws').WebSocket;
      const query = request.query as Record<string, string>;
      handleTerminalWebSocket(ws, query, ptyManager);
    });

    // Register API routes
    await app.register(
      async (api) => {
        await api.register(swarmHostingRoutes, { config });
      },
      { prefix: '/api/v1' },
    );

    // Start listening
    serverAddress = await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 30000);

  afterAll(async () => {
    ptyManager.destroyAll();
    await swarmManager.shutdown();
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ==========================================================================
  // 1. Spawn + Health Check → "running" state
  // ==========================================================================

  describe('Spawn and lifecycle', () => {
    let spawnedId: string;
    let spawnedPort: number;

    it('should spawn a hosted swarm that reaches "running" state', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: {
          name: 'e2e-lifecycle-test',
          adapter: 'macro-agent',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.id).toMatch(/^hswarm_/);
      expect(body.provider).toBe('local');
      expect(body.assigned_port).toBeGreaterThanOrEqual(PORT_RANGE_MIN);
      expect(body.assigned_port).toBeLessThanOrEqual(PORT_RANGE_MAX);

      spawnedId = body.id;
      spawnedPort = body.assigned_port;

      // The swarm should reach "running" state (health check passes because
      // the map-server.js fixture serves /health on port+1)
      const isRunning = await waitFor(() => {
        const hosted = dal.findHostedSwarmById(spawnedId);
        return hosted?.state === 'running';
      }, 35000);

      expect(isRunning).toBe(true);

      const hosted = dal.findHostedSwarmById(spawnedId)!;
      expect(hosted.state).toBe('running');
      expect(hosted.endpoint).toContain(`ws://127.0.0.1:${spawnedPort}`);
    }, 40000);

    it('should return the running swarm via GET /map/hosted/:id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${spawnedId}`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(spawnedId);
      expect(body.state).toBe('running');
      expect(body.pid).toBeGreaterThan(0);
      expect(body.spawned_by).toBe(testAgent.id);
    });

    it('should list the swarm when filtering by mine=true', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/map/hosted?mine=true',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      const found = body.data.find((h: any) => h.id === spawnedId);
      expect(found).toBeDefined();
      expect(found.state).toBe('running');
    });

    it('should stop the swarm and transition to "stopped"', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${spawnedId}/stop`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.state).toBe('stopped');
    }, 15000);

    it('should reject stop from non-owner', async () => {
      // Spawn a new swarm for this test
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'e2e-ownership-test' },
      });
      const spawned = JSON.parse(spawnRes.body);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${spawned.id}/stop`,
        headers: { authorization: `Bearer ${otherAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(403);

      // Clean up
      await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${spawned.id}/stop`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });
    }, 40000);
  });

  // ==========================================================================
  // 2. Terminal-Info Endpoint
  // ==========================================================================

  describe('Terminal-info endpoint', () => {
    let runningSwarmId: string;
    let runningSwarmPort: number;

    beforeAll(async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'e2e-terminal-info-swarm' },
      });

      const body = JSON.parse(response.body);
      runningSwarmId = body.id;
      runningSwarmPort = body.assigned_port;

      // Wait for running state
      await waitFor(() => {
        const hosted = dal.findHostedSwarmById(runningSwarmId);
        return hosted?.state === 'running';
      }, 35000);
    }, 40000);

    afterAll(async () => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${runningSwarmId}/stop`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });
    });

    it('should return terminal-info with /map endpoint path', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${runningSwarmId}/terminal-info`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // The endpoint must use /map path (not /acp)
      expect(body.endpoint).toBe(`ws://127.0.0.1:${runningSwarmPort}/map`);

      // The args should include --url with /map and --auto-connect
      if (body.available) {
        expect(body.args).toContain('--auto-connect');
        const urlArg = body.args[body.args.indexOf('--url') + 1];
        expect(urlArg).toContain('/map');
        expect(urlArg).not.toContain('/acp');
      }
    });

    it('should return 409 for stopped swarm terminal-info', async () => {
      // Use the swarm we stopped in the lifecycle test (first one spawned)
      const stoppedSwarms = dal.listHostedSwarms({ state: 'stopped' as any, limit: 1 });
      if (stoppedSwarms.data.length === 0) return; // skip if none stopped yet

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${stoppedSwarms.data[0].id}/terminal-info`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(409);
    });

    it('should return 404 for non-existent swarm terminal-info', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/map/hosted/hswarm_nonexistent/terminal-info',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ==========================================================================
  // 3. MAP WebSocket connectivity (verify /map path works)
  // ==========================================================================

  describe('MAP WebSocket endpoint', () => {
    let runningSwarmPort: number;
    let runningSwarmId: string;

    beforeAll(async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'e2e-map-ws-test' },
      });

      const body = JSON.parse(response.body);
      runningSwarmId = body.id;
      runningSwarmPort = body.assigned_port;

      await waitFor(() => {
        const hosted = dal.findHostedSwarmById(runningSwarmId);
        return hosted?.state === 'running';
      }, 35000);
    }, 40000);

    afterAll(async () => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${runningSwarmId}/stop`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });
    });

    it('should accept WebSocket connection on /map path', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${runningSwarmPort}/map`);

      const connected = await new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true));
        ws.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 5000);
      });

      expect(connected).toBe(true);

      // Send a MAP connect message and verify we get a response
      if (connected) {
        const responsePromise = new Promise<any>((resolve) => {
          ws.on('message', (data) => {
            try {
              resolve(JSON.parse(data.toString()));
            } catch {
              // ignore non-JSON
            }
          });
          setTimeout(() => resolve(null), 5000);
        });

        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'map/connect',
          params: { name: 'e2e-test-client' },
        }));

        const response = await responsePromise;
        expect(response).not.toBeNull();
        expect(response.id).toBe(1);
        expect(response.result).toBeDefined();
        expect(response.result.sessionId).toBeDefined();
      }

      ws.close();
    }, 15000);

    it('should accept WebSocket connection on /acp path', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${runningSwarmPort}/acp`);

      const connected = await new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true));
        ws.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 5000);
      });

      expect(connected).toBe(true);
      ws.close();
    }, 10000);

    it('should reject WebSocket on unknown path', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${runningSwarmPort}/unknown`);

      const result = await new Promise<string>((resolve) => {
        ws.on('open', () => resolve('open'));
        ws.on('error', () => resolve('error'));
        ws.on('close', () => resolve('closed'));
        setTimeout(() => resolve('timeout'), 5000);
      });

      // The server sends 404 and destroys the socket — expect error or close
      expect(['error', 'closed']).toContain(result);
    }, 10000);
  });

  // ==========================================================================
  // 4. Terminal WebSocket (/ws/terminal) PTY Sessions
  // ==========================================================================

  describe('Terminal WebSocket PTY', () => {
    it('should create a PTY session and receive output', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${SERVER_PORT}/ws/terminal?cols=80&rows=24&command=bash`,
      );

      // Register message listener BEFORE waiting for open so we don't miss
      // the "connected" message sent immediately on connection.
      const allMessages: string[] = [];
      ws.on('message', (data: Buffer | string) => {
        allMessages.push(data.toString());
      });

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (err) => reject(err));
        setTimeout(() => reject(new Error('WS open timeout')), 5000);
      });

      // Wait until we've received the connected message
      await waitFor(() => {
        return allMessages.some((m) => {
          try { return JSON.parse(m).type === 'connected'; } catch { return false; }
        });
      }, 5000, 100);

      const connectedMsg = allMessages.find((m) => {
        try { return JSON.parse(m).type === 'connected'; } catch { return false; }
      });
      expect(connectedMsg).toBeDefined();

      const parsed = JSON.parse(connectedMsg!);
      expect(parsed.sessionId).toBeDefined();
      expect(typeof parsed.sessionId).toBe('string');

      // Send a command and wait for output containing the marker
      ws.send('echo "__E2E_MARKER__"\n');

      await waitFor(() => {
        return allMessages.some((m) => m.includes('__E2E_MARKER__'));
      }, 5000, 100);

      const hasMarker = allMessages.some((m) => m.includes('__E2E_MARKER__'));
      expect(hasMarker).toBe(true);

      ws.close();
    }, 15000);

    it('should support resize control messages', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${SERVER_PORT}/ws/terminal?cols=80&rows=24`,
      );

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (err) => reject(err));
        setTimeout(() => reject(new Error('WS open timeout')), 5000);
      });

      // Wait for connected message
      await collectWsMessages(
        ws,
        (msgs) => msgs.some((m) => {
          try { return JSON.parse(m).type === 'connected'; } catch { return false; }
        }),
        5000,
      );

      // Send resize — should not crash
      ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

      // Give a moment for resize to process, then verify session is still alive
      await new Promise((r) => setTimeout(r, 500));
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    }, 10000);

    it('should reject disallowed commands', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${SERVER_PORT}/ws/terminal?command=/usr/bin/evil-binary`,
      );

      const messages = await new Promise<string[]>((resolve) => {
        const msgs: string[] = [];
        ws.on('message', (data) => {
          msgs.push(data.toString());
        });
        ws.on('close', () => resolve(msgs));
        setTimeout(() => resolve(msgs), 3000);
      });

      const errorMsg = messages.find((m) => {
        try { return JSON.parse(m).type === 'error'; } catch { return false; }
      });
      expect(errorMsg).toBeDefined();

      const parsed = JSON.parse(errorMsg!);
      expect(parsed.message).toContain('not allowed');
    }, 10000);

    it('should handle exit when PTY process terminates', async () => {
      // Spawn a short-lived command that exits immediately
      const ws = new WebSocket(
        `ws://127.0.0.1:${SERVER_PORT}/ws/terminal?cols=80&rows=24&command=bash`,
      );

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (err) => reject(err));
        setTimeout(() => reject(new Error('WS open timeout')), 5000);
      });

      // Wait for connected
      await collectWsMessages(
        ws,
        (msgs) => msgs.some((m) => {
          try { return JSON.parse(m).type === 'connected'; } catch { return false; }
        }),
        5000,
      );

      // Tell bash to exit
      ws.send('exit\n');

      // Should receive an exit message
      const exitMessages = await collectWsMessages(
        ws,
        (msgs) => msgs.some((m) => {
          try { return JSON.parse(m).type === 'exit'; } catch { return false; }
        }),
        10000,
      );

      const exitMsg = exitMessages.find((m) => {
        try { return JSON.parse(m).type === 'exit'; } catch { return false; }
      });
      expect(exitMsg).toBeDefined();

      const parsed = JSON.parse(exitMsg!);
      expect(parsed.exitCode).toBe(0);

      ws.close();
    }, 15000);
  });

  // ==========================================================================
  // 5. Full flow: Spawn → Terminal-Info → Connect MAP WebSocket
  // ==========================================================================

  describe('Full integration flow', () => {
    it('should spawn swarm, get terminal-info, and connect to MAP endpoint', async () => {
      // Step 1: Spawn
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'e2e-full-flow' },
      });

      expect(spawnRes.statusCode).toBe(201);
      const spawned = JSON.parse(spawnRes.body);

      // Step 2: Wait for running
      const isRunning = await waitFor(() => {
        const hosted = dal.findHostedSwarmById(spawned.id);
        return hosted?.state === 'running';
      }, 35000);
      expect(isRunning).toBe(true);

      // Step 3: Get terminal-info
      const infoRes = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${spawned.id}/terminal-info`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(infoRes.statusCode).toBe(200);
      const info = JSON.parse(infoRes.body);
      expect(info.endpoint).toContain('/map');
      expect(info.endpoint).not.toContain('/acp');

      // Step 4: Connect to the MAP endpoint from terminal-info
      const ws = new WebSocket(info.endpoint);

      const connected = await new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true));
        ws.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 5000);
      });

      expect(connected).toBe(true);

      // Step 5: Verify MAP protocol works
      const responsePromise = new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          try { resolve(JSON.parse(data.toString())); } catch { /* skip */ }
        });
        setTimeout(() => resolve(null), 5000);
      });

      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'map/connect',
        params: { name: 'e2e-full-flow-client' },
      }));

      const response = await responsePromise;
      expect(response).not.toBeNull();
      expect(response.id).toBe(42);
      expect(response.result.sessionId).toBeDefined();

      ws.close();

      // Step 6: Clean up
      await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${spawned.id}/stop`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });
    }, 60000);
  });

  // ==========================================================================
  // 6. Cleanup: DELETE stopped swarm
  // ==========================================================================

  describe('DELETE /map/hosted/:id', () => {
    it('should remove a stopped swarm record', async () => {
      // Spawn and stop a swarm
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'e2e-delete-test' },
      });
      const spawned = JSON.parse(spawnRes.body);

      await waitFor(() => {
        const h = dal.findHostedSwarmById(spawned.id);
        return h?.state === 'running';
      }, 35000);

      await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${spawned.id}/stop`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      // DELETE it
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/map/hosted/${spawned.id}`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(deleteRes.statusCode).toBe(204);

      // Verify it's gone (DAL returns null for missing records)
      const hosted = dal.findHostedSwarmById(spawned.id);
      expect(hosted).toBeNull();
    }, 50000);

    it('should reject DELETE for running swarm', async () => {
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: {
          authorization: `Bearer ${testAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: { name: 'e2e-delete-running' },
      });
      const spawned = JSON.parse(spawnRes.body);

      await waitFor(() => {
        const h = dal.findHostedSwarmById(spawned.id);
        return h?.state === 'running';
      }, 35000);

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/map/hosted/${spawned.id}`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(deleteRes.statusCode).toBe(409);

      // Clean up
      await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${spawned.id}/stop`,
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
      });
    }, 50000);
  });
});
