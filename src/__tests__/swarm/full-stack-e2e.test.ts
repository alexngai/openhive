/**
 * Full Stack E2E: OpenHive → OpenSwarm → macro-agent
 *
 * Tests the complete flow from OpenHive hub to a real OpenSwarm instance
 * running macro-agent as the adapter:
 *
 *   1. Boot OpenHive Fastify server with SwarmManager
 *   2. Spawn a hosted swarm (real OpenSwarm + macro-agent)
 *   3. Wait for health check
 *   4. Connect to the swarm's MAP server via ClientConnection
 *   5. List agents, create ACP stream, prompt agent
 *   6. Verify session updates stream back
 *
 * REQUIRES: FULL_STACK_E2E=true (skipped by default — spawns real processes)
 * REQUIRES: OpenSwarm built (references/openswarm/dist/server.mjs)
 * REQUIRES: macro-agent built (references/macro-agent/dist/)
 *
 * Run:
 *   FULL_STACK_E2E=true npx vitest run src/__tests__/swarm/full-stack-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { SwarmManager } from '../../swarm/manager.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const IS_FULL_STACK = process.env.FULL_STACK_E2E === 'true';
const describeFn = IS_FULL_STACK ? describe : describe.skip;

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('full-stack-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'fullstack.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19600;
const PORT_RANGE_MAX = 19610;
const SERVER_PORT = 19699;

// Path to the npm-installed OpenSwarm binary (published package)
const OPENSWARM_BIN = path.resolve(
  __dirname,
  '../../../node_modules/openswarm/bin/openswarm.mjs',
);

// ============================================================================
// Helpers
// ============================================================================

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: { name: 'Full Stack E2E', description: 'Full stack test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      openswarm_command: `node ${OPENSWARM_BIN} serve`,
      data_dir: TEST_DATA_DIR,
      port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX],
      max_swarms: 2,
      health_check_interval: 600000,
      max_health_failures: 3,
      auto_restart: false,
    },
  });
}

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ============================================================================
// Tests
// ============================================================================

describeFn('Full Stack E2E: OpenHive → OpenSwarm → macro-agent', () => {
  let app: FastifyInstance;
  let swarmManager: SwarmManager;
  let config: Config;
  let agentApiKey: string;
  let spawnedSwarmId: string;
  let assignedPort: number;

  beforeAll(async () => {
    // Check prerequisites
    if (!fs.existsSync(OPENSWARM_BIN)) {
      throw new Error(
        `OpenSwarm binary not found at ${OPENSWARM_BIN}. Build it first: cd references/openswarm && npm run build:server`,
      );
    }

    config = createTestConfig();

    // Initialize database
    initDatabase(TEST_DB_PATH);

    // Create test agents (matches existing e2e pattern)
    const agentResult = await agentsDAL.createAgent({
      name: 'full-stack-e2e-agent',
      description: 'Agent for full stack E2E tests',
    });
    agentApiKey = agentResult.apiKey;
    const agentsByKey = new Map<string, { id: string; name: string }>();
    agentsByKey.set(agentResult.apiKey, {
      id: agentResult.agent.id,
      name: 'full-stack-e2e-agent',
    });

    // Create SwarmManager
    swarmManager = new SwarmManager(
      config.swarmHosting as any,
      `http://127.0.0.1:${SERVER_PORT}`,
    );

    // Boot Fastify with auth hook (matches existing e2e pattern)
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

    // Register API routes with /api/v1 prefix
    await app.register(
      async (api) => {
        await api.register(swarmHostingRoutes, { config } as any);
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
    console.log(`[full-stack-e2e] OpenHive listening on port ${SERVER_PORT}`);
  }, 30000);

  afterAll(async () => {
    // Stop swarm if running
    if (spawnedSwarmId && swarmManager) {
      try {
        await swarmManager.stop(spawnedSwarmId, '');
      } catch { /* ignore */ }
    }

    if (app) {
      await app.close();
    }

    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('spawns a hosted swarm via API', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: { authorization: `Bearer ${agentApiKey}` },
      payload: {
        name: 'e2e-test-swarm',
        adapter: 'macro-agent',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeTruthy();
    expect(body.assigned_port).toBeTruthy();

    spawnedSwarmId = body.id;
    assignedPort = body.assigned_port;
    console.log(
      `[full-stack-e2e] Spawned swarm: id=${spawnedSwarmId} port=${assignedPort}`,
    );
  }, 15000);

  it('swarm becomes healthy', async () => {
    const healthy = await waitFor(async () => {
      try {
        const res = await fetch(
          `http://127.0.0.1:${assignedPort + 1}/health`,
        );
        return res.ok;
      } catch {
        return false;
      }
    }, 45000);

    expect(healthy).toBe(true);
    console.log('[full-stack-e2e] Swarm is healthy');
  }, 60000);

  it('can connect to swarm MAP server', async () => {
    // The swarm's MAP server is on port+2 (ACP on port, gateway health on port+1, MAP on port+2)
    const mapPort = assignedPort + 2;
    const mapUrl = `ws://127.0.0.1:${mapPort}/map`;

    // Wait for MAP server to be ready (it starts after the gateway health endpoint)
    const mapReady = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${mapPort}/health`);
        return res.ok;
      } catch { return false; }
    }, 10000);

    console.log(`[full-stack-e2e] MAP server (port ${mapPort}): ${mapReady ? 'ready' : 'NOT ready'}`);

    // If MAP server not ready, dump swarm logs to diagnose
    if (!mapReady) {
      try {
        const agentId = (await (await import('../../db/dal/agents.js')).findAgentByApiKey(agentApiKey))?.id ?? '';
        const logs = await swarmManager.getLogs(spawnedSwarmId, agentId, { lines: 50 });
        console.log(`[full-stack-e2e] Swarm logs:\n${logs}`);
      } catch (e) {
        console.log(`[full-stack-e2e] Could not get logs: ${(e as Error).message}`);
      }
    }

    console.log(`[full-stack-e2e] Connecting to MAP at ${mapUrl}`);

    // Connect via raw WebSocket and send map/connect
    const ws = new WebSocket(mapUrl);

    const connected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 10000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'map/connect',
            params: {
              name: 'Full Stack E2E Client',
              capabilities: {
                observation: { canObserve: true },
              },
            },
          }),
        );
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1 && msg.result) {
            clearTimeout(timeout);
            console.log(
              `[full-stack-e2e] MAP connected: sessionId=${msg.result.sessionId}`,
            );
            resolve(true);
          }
        } catch { /* ignore */ }
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });

    ws.close();
    expect(connected).toBe(true);
  }, 15000);

  it('can list agents via MAP extension', async () => {
    const mapPort = assignedPort + 2;
    const mapUrl = `ws://127.0.0.1:${mapPort}/map`;

    const ws = new WebSocket(mapUrl);

    const result = await new Promise<any>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve(null);
      }, 10000);

      let connected = false;

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'map/connect',
            params: { name: 'E2E Client' },
          }),
        );
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1 && !connected) {
            connected = true;
            // Now call _macro/task/list extension
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: '_macro/task/list',
                params: {},
              }),
            );
          }
          if (msg.id === 2) {
            clearTimeout(timeout);
            resolve(msg.result);
          }
        } catch { /* ignore */ }
      });
    });

    ws.close();
    expect(result).toBeDefined();
    expect(result.tasks).toBeDefined();
    console.log(`[full-stack-e2e] Task list: ${result.tasks.length} tasks`);
  }, 15000);

  it('can send trajectory checkpoint to swarm MAP server', async () => {
    const mapPort = assignedPort + 2;
    const mapUrl = `ws://127.0.0.1:${mapPort}/map`;

    const ws = new WebSocket(mapUrl);

    const result = await new Promise<any>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve(null);
      }, 10000);

      let connected = false;

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'map/connect',
            params: { name: 'Trajectory E2E Client' },
          }),
        );
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1 && !connected) {
            connected = true;
            // Send trajectory checkpoint
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'trajectory/checkpoint',
                params: {
                  checkpoint: {
                    id: 'fullstack-e2e-checkpoint-1',
                    session_id: 'fullstack-e2e-session',
                    agent: 'fullstack-e2e-agent',
                    branch: 'main',
                    files_touched: ['src/index.ts', 'README.md'],
                    checkpoints_count: 1,
                    token_usage: { input_tokens: 500, output_tokens: 300 },
                    metadata: {
                      project: 'full-stack-e2e',
                      phase: 'active',
                      toolCallCount: 2,
                    },
                  },
                },
              }),
            );
          }
          if (msg.id === 2) {
            clearTimeout(timeout);
            resolve(msg.result);
          }
        } catch { /* ignore */ }
      });
    });

    ws.close();
    expect(result).toBeDefined();
    expect(result.ok).toBe(true);
    console.log(
      `[full-stack-e2e] Trajectory checkpoint: ok=${result.ok} note=${result.note ?? 'forwarded'}`,
    );
  }, 15000);

  it('stops the swarm cleanly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${spawnedSwarmId}/stop`,
      headers: { authorization: `Bearer ${agentApiKey}` },
    });

    expect(res.statusCode).toBe(200);
    console.log('[full-stack-e2e] Swarm stopped');

    // Verify health check fails
    const stillHealthy = await waitFor(async () => {
      try {
        const res = await fetch(
          `http://127.0.0.1:${assignedPort + 1}/health`,
        );
        return res.ok;
      } catch {
        return false;
      }
    }, 5000);

    expect(stillHealthy).toBe(false);
    spawnedSwarmId = ''; // Prevent afterAll from trying to stop again
  }, 15000);
});
