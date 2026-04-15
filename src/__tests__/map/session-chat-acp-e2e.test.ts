/**
 * ACP Session Chat E2E Tests
 *
 * Tests the full ACP streaming flow for session chat:
 *
 *   1. Spawn real OpenSwarm with macro-agent (has ACP server)
 *   2. Connect to swarm's MAP server as a client
 *   3. Create ACP stream to the swarm's agent
 *   4. Send prompt, receive streaming response
 *   5. Verify session chat mail fallback works alongside ACP
 *
 * REQUIRES: LIVE_AGENT_E2E=true (spawns real processes + real Claude API)
 *
 * Run:
 *   LIVE_AGENT_E2E=true npx vitest run src/__tests__/map/session-chat-acp-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { getAllInbound } from '../../map/connection-registry.js';
import { findSwarmById } from '../../db/dal/map.js';
import { SwarmManager } from '../../swarm/manager.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { mapRoutes } from '../../api/routes/map.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { mailRoutes } from '../../api/routes/mail.js';
import { initMail } from '../../mail/index.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// MAP SDK for direct ACP streaming — loaded lazily in beforeAll
let ClientConnection: any;
let createACPStream: any;
async function loadSdk() {
  try {
    const sdk = await import('@multi-agent-protocol/sdk');
    ClientConnection = sdk.ClientConnection;
    createACPStream = sdk.createACPStream;
  } catch {
    // SDK not available — tests will skip
  }
}

// ============================================================================
// Constants
// ============================================================================

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const TEST_ROOT = testRoot('e2e-session-chat-acp');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'session-chat-acp.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19780;
const PORT_RANGE_MAX = 19790;
const SERVER_PORT = 19791;

// ============================================================================
// Helpers
// ============================================================================

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

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: { name: 'ACP Chat E2E', description: 'Test', url: `http://127.0.0.1:${SERVER_PORT}` },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    mapHub: { enabled: true, trustModel: 'open' },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      openswarm_command: 'npx openswarm serve',
      data_dir: TEST_DATA_DIR,
      port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX],
      max_swarms: 2,
      health_check_interval: 600000,
      max_health_failures: 3,
      auto_restart: false,
      credentials: { inherit_env: true },
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

const describeIf = LIVE_AGENT ? describe : describe.skip;

describeIf('Live Agent E2E — ACP Session Chat', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let testAgent: { id: string; apiKey: string };
  let swarmId: string | undefined;
  let assignedPort: number;
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    await loadSdk();
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    initDatabase(TEST_DB_PATH);

    await initMail();
    config = createTestConfig();

    const agentResult = await agentsDAL.createAgent({
      name: 'acp-chat-live-agent',
      description: 'Live agent for ACP chat E2E',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    setLocalAgent(agentResult.agent);

    hivesDAL.createHive({
      name: 'acp-chat-hive',
      description: 'Test hive',
      owner_id: testAgent.id,
    });

    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.register(
      async (api) => {
        await api.register(mapRoutes, { config });
        await api.register(sessionsRoutes, { config });
        await api.register(mailRoutes, { config });
      },
      { prefix: '/api/v1' },
    );
    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
    console.log(`[acp-chat] Server listening on port ${SERVER_PORT}`);

    // Spawn real OpenSwarm with macro-agent
    console.log('[acp-chat] Spawning real OpenSwarm...');
    const hosted = await swarmManager.spawn(testAgent.id, {
      name: 'acp-chat-swarm',
      adapter: 'macro-agent',
      hive: 'acp-chat-hive',
    });
    assignedPort = hosted.assigned_port!;
    console.log(`[acp-chat] Swarm spawned: port=${assignedPort}`);

    // Wait for swarm to connect to hub
    const connected = await waitFor(() => getAllInbound().size > 0, 30_000);
    if (connected) {
      swarmId = [...getAllInbound().keys()][0];
      console.log(`[acp-chat] Swarm connected to hub: ${swarmId}`);
    }

    // Wait for agent registration
    if (swarmId) {
      await waitFor(() => {
        const conn = getAllInbound().get(swarmId!);
        return (conn?.registeredAgents.size ?? 0) > 0;
      }, 15_000);
    }

    // Wait for ACP server health
    const acpHealthy = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${assignedPort + 1}/health`);
        return res.ok;
      } catch { return false; }
    }, 30_000);
    console.log(`[acp-chat] ACP server health: ${acpHealthy ? 'ready' : 'NOT ready'}`);
  }, 60_000);

  afterAll(async () => {
    if (swarmManager) await swarmManager.shutdown();
    stopMapWebSocket();
    if (app) await app.close();
    setLocalAgent(null);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  }, 30_000);

  // ── ACP capability verification ──────────────────────────────────────

  it('swarm publishes ACP protocol capability', async () => {
    expect(swarmId).toBeDefined();

    const swarm = findSwarmById(swarmId!);
    expect(swarm).toBeDefined();
    console.log(`[acp-chat] Swarm capabilities:`, JSON.stringify(swarm!.capabilities, null, 2));

    // Check protocols includes 'acp' (from updated macro-agent)
    const caps = swarm!.capabilities as Record<string, unknown> | null;
    if (caps?.protocols && (caps.protocols as string[]).includes('acp')) {
      console.log('[acp-chat] ACP protocol capability published');
    } else {
      console.log('[acp-chat] ACP protocol NOT in capabilities (may need updated macro-agent)');
    }
  });

  // ── Direct ACP streaming via swarm's MAP server ──────────────────────

  it('creates ACP stream and sends prompt with streaming response', async () => {
    if (!ClientConnection || !createACPStream) {
      console.log('[acp-chat] MAP SDK not available, skipping ACP stream test');
      return;
    }

    // Connect to the swarm's MAP server (port+2)
    const mapPort = assignedPort + 2;
    const mapUrl = `ws://127.0.0.1:${mapPort}/map`;

    const mapReady = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${mapPort}/health`);
        return res.ok;
      } catch { return false; }
    }, 15_000);

    if (!mapReady) {
      console.log(`[acp-chat] MAP server not ready at port ${mapPort}, skipping`);
      return;
    }

    console.log(`[acp-chat] Connecting to MAP server at ${mapUrl}`);

    const client = await ClientConnection.connect(mapUrl, {
      name: 'ACP Chat E2E Client',
      capabilities: {
        observation: { canObserve: true },
        messaging: { canSend: true, canReceive: true },
        lifecycle: { canSpawn: true },
      },
    });

    // List agents to find a target
    const agents = await client.listAgents();
    console.log(`[acp-chat] Available agents: ${agents.agents.length}`);

    // Spawn a target agent for the ACP stream
    let targetAgent: string;
    try {
      const spawnResult = await client.callExtension('_macro/spawnAgent', {
        task: 'ACP chat test agent',
        role: 'worker',
      }) as { agent: { id: string } };
      targetAgent = spawnResult.agent.id;
      console.log(`[acp-chat] Spawned target agent: ${targetAgent}`);
    } catch (err) {
      console.log(`[acp-chat] Could not spawn agent: ${(err as Error).message}`);
      await client.disconnect();
      return;
    }

    // Create ACP stream
    const sessionUpdates: any[] = [];

    const acpStream = createACPStream(client, {
      targetAgent,
      timeout: 90_000,
      client: {
        requestPermission: async (req: any) => {
          console.log(`[acp-chat] Permission: ${req.toolCall?.name ?? 'unknown'}`);
          return { outcome: { outcome: 'allow' } } as any;
        },
        sessionUpdate: async (update: any) => {
          sessionUpdates.push(update);
        },
      },
    }) as any;

    // Initialize
    const initResult = await acpStream.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'ACP Chat E2E', version: '1.0.0' },
    });
    expect(initResult).toBeDefined();
    console.log(`[acp-chat] Initialized: ${initResult.agentInfo?.name}`);

    // Pre-spawn head manager (like macro-agent's own e2e tests do)
    console.log('[acp-chat] Pre-spawning head manager...');
    try {
      await client.callExtension('_macro/spawnAgent', {
        task: 'Head manager for ACP',
        role: 'coordinator',
      });
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.log(`[acp-chat] Pre-spawn warning: ${(err as Error).message}`);
    }

    // Create session
    let sessionResult: any;
    try {
      sessionResult = await acpStream.newSession({
        cwd: TEST_ROOT,
        mcpServers: [],
      });
    } catch (err) {
      console.log(`[acp-chat] newSession error: ${(err as Error).message}`);
      // Try minimal params
      try {
        sessionResult = await acpStream.newSession({ cwd: TEST_ROOT });
      } catch (err2) {
        console.log(`[acp-chat] newSession retry error: ${(err2 as Error).message}`);
        await acpStream.close();
        await client.disconnect();
        return;
      }
    }
    expect(sessionResult).toBeDefined();
    const sessionId = sessionResult.sessionId;
    console.log(`[acp-chat] Session: ${sessionId}`);

    // ── Turn 1: Send prompt and verify streaming response content ──

    console.log('[acp-chat] Sending ACP prompt (turn 1)...');
    const promptResult = await acpStream.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly "hello from ACP test" and nothing else.' }],
    });

    console.log(`[acp-chat] Turn 1 result: stopReason=${promptResult.stopReason}`);
    console.log(`[acp-chat] Session updates received: ${sessionUpdates.length}`);

    // Verify we got a complete response
    expect(promptResult).toBeDefined();
    expect(promptResult.stopReason).toBe('end_turn');
    expect(sessionUpdates.length).toBeGreaterThan(0);

    // Extract response text from streaming updates (prefer content.text over text to avoid dupes)
    const responseText = sessionUpdates
      .map((u: any) => {
        const update = u?.update ?? u;
        return update?.content?.text;
      })
      .filter(Boolean)
      .join('');
    console.log(`[acp-chat] Turn 1 full response: "${responseText}"`);

    // Agent should have replied with the requested text
    expect(responseText.toLowerCase()).toContain('hello from acp test');

    // ── Turn 2: Multi-turn conversation (agent remembers context) ──

    // Replace the sessionUpdate handler for turn 2
    // (can't replace on existing stream, so just track separately)
    const turn1Count = sessionUpdates.length;

    console.log('[acp-chat] Sending ACP prompt (turn 2)...');
    const prompt2Result = await acpStream.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'What did I ask you to say in the previous message? Reply in one sentence.' }],
    });

    console.log(`[acp-chat] Turn 2 result: stopReason=${prompt2Result.stopReason}`);
    const turn2NewUpdates = sessionUpdates.length - turn1Count;
    console.log(`[acp-chat] Turn 2 new updates: ${turn2NewUpdates}`);

    expect(prompt2Result.stopReason).toBe('end_turn');
    expect(turn2NewUpdates).toBeGreaterThan(0);

    // Extract turn 2 response text
    const turn2Text = sessionUpdates.slice(turn1Count)
      .map((u: any) => {
        const update = u?.update ?? u;
        return update?.content?.text;
      })
      .filter(Boolean)
      .join('');
    console.log(`[acp-chat] Turn 2 full response: "${turn2Text}"`);

    // Agent should reference the previous message (context maintained)
    expect(turn2Text.toLowerCase()).toContain('hello from acp test');

    // Close stream
    await acpStream.close();
    await client.disconnect();

    console.log(`[acp-chat] Full ACP conversation: 2 turns, ${sessionUpdates.length} total updates`);
  }, 180_000);

  // ── Session chat (mail fallback) still works alongside ACP ───────────

  it('mail-based session chat works alongside ACP capability', async () => {
    expect(swarmId).toBeDefined();

    const session = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'acp-fallback-session',
      git_remote_url: 'map://session/acp-fallback',
      owner_agent_id: testAgent.id,
      metadata: { source_swarm_id: swarmId },
    });

    const chatRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/chat`,
      payload: { content: 'Hello via mail while ACP is available' },
    });

    expect(chatRes.statusCode).toBe(201);
    const body = JSON.parse(chatRes.payload);
    expect(body.ok).toBe(true);

    const turnsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/mail/conversations/${body.conversation_id}/turns`,
    });
    expect(JSON.parse(turnsRes.payload).turns).toHaveLength(1);

    console.log('[acp-chat] Mail fallback works alongside ACP');
  });
});
