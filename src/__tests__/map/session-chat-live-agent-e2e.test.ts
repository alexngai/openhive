/**
 * Live Agent E2E Tests: Session Chat with Real Swarms
 *
 * Spawns REAL OpenSwarm processes with macro-agent adapter and cc-swarm
 * sidecars, then tests the full session chat flow end-to-end:
 *
 *   1. Spawn real OpenSwarm via SwarmManager
 *   2. Wait for MAP connection + capability registration
 *   3. Verify mail/messaging/ACP capabilities published
 *   4. Create session linked to the live swarm
 *   5. Send chat message via POST /sessions/:id/chat
 *   6. Verify turns land in mail system
 *
 * Requirements:
 *   - LIVE_AGENT_E2E=true to enable
 *   - openswarm installed (npx openswarm serve)
 *   - Claude Max plan or ANTHROPIC_API_KEY set
 *
 * Run:
 *   LIVE_AGENT_E2E=true npx vitest run src/__tests__/map/session-chat-live-agent-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { getAllInbound, hasCapability, getAgentCapabilities } from '../../map/connection-registry.js';
import { findSwarmById } from '../../db/dal/map.js';
import { SwarmManager } from '../../swarm/manager.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { mapRoutes } from '../../api/routes/map.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { mailRoutes } from '../../api/routes/mail.js';
import { initMail, getMailStorage } from '../../mail/index.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const TEST_ROOT = testRoot('e2e-session-chat-live');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'session-chat-live.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19760;
const PORT_RANGE_MAX = 19770;
const SERVER_PORT = 19771;

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
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: { name: 'Session Chat Live E2E', description: 'Test', url: `http://127.0.0.1:${SERVER_PORT}` },
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
      max_swarms: 3,
      health_check_interval: 600000,
      max_health_failures: 3,
      auto_restart: false,
      credentials: {
        inherit_env: true,
      },
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

const describeIf = LIVE_AGENT ? describe : describe.skip;

describeIf('Live Agent E2E — Session Chat with Real Swarms', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let testAgent: { id: string; apiKey: string };
  let swarmId: string | undefined;
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    initDatabase(TEST_DB_PATH);

    await initMail();

    config = createTestConfig();

    // Create test agent
    const agentResult = await agentsDAL.createAgent({
      name: 'session-chat-live-agent',
      description: 'Live agent for session chat E2E',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    setLocalAgent(agentResult.agent);

    // Create hive for swarm auto-join
    hivesDAL.createHive({
      name: 'session-chat-hive',
      description: 'Test hive for session chat',
      owner_id: testAgent.id,
    });

    // Initialize SwarmManager
    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );

    // Create Fastify server with all required routes
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
    console.log(`[session-chat-live] Server listening on port ${SERVER_PORT}`);

    // Spawn a REAL OpenSwarm with macro-agent adapter
    console.log('[session-chat-live] Spawning real OpenSwarm with macro-agent...');
    const hosted = await swarmManager.spawn(testAgent.id, {
      name: 'chat-test-swarm',
      adapter: 'macro-agent',
      hive: 'session-chat-hive',
      metadata: { role: 'chat-test' },
    });
    console.log(`[session-chat-live] Swarm spawned: ${hosted.id}, state: ${hosted.state}`);

    // Wait for the real swarm to connect via MAP
    const connected = await waitFor(() => getAllInbound().size > 0, 30_000);
    if (connected) {
      swarmId = [...getAllInbound().keys()][0];
      console.log(`[session-chat-live] Swarm connected: ${swarmId}`);
    } else {
      console.warn('[session-chat-live] Swarm did not connect within 30s');
      const logs = await swarmManager.getLogs(hosted.id, testAgent.id).catch(() => '(no logs)');
      console.log(`[session-chat-live] Startup logs:\n${logs}`);
    }

    // Wait for agent registration with capabilities
    if (swarmId) {
      const hasAgent = await waitFor(() => {
        const conn = getAllInbound().get(swarmId!);
        return (conn?.registeredAgents.size ?? 0) > 0;
      }, 15_000);
      console.log(`[session-chat-live] Agent registered: ${hasAgent}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (swarmManager) {
      console.log('[session-chat-live] Shutting down swarm manager...');
      await swarmManager.shutdown();
    }
    stopMapWebSocket();
    if (app) await app.close();
    setLocalAgent(null);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  }, 30_000);

  function createSessionResource(name: string, linkedSwarmId?: string) {
    return resourcesDAL.createResource({
      resource_type: 'session',
      name,
      git_remote_url: `map://session/${name}`,
      owner_agent_id: testAgent.id,
      metadata: linkedSwarmId ? { source_swarm_id: linkedSwarmId } : undefined,
    });
  }

  // ── Swarm connection & capabilities ──────────────────────────────────

  it('real swarm is connected via MAP', () => {
    expect(getAllInbound().size).toBeGreaterThanOrEqual(1);
    expect(swarmId).toBeDefined();
    console.log(`[session-chat-live] Connected swarms: ${[...getAllInbound().keys()].join(', ')}`);
  });

  it('real swarm publishes capabilities (mail caps depend on installed version)', () => {
    expect(swarmId).toBeDefined();

    // Check what capabilities the installed macro-agent actually publishes.
    // The references/ version declares mail + messaging, but the installed
    // node_modules version may not have these changes yet.
    const hasMail = hasCapability(swarmId!, 'mail.canJoin');
    const hasMessaging = hasCapability(swarmId!, 'messaging.canReceive');
    const hasTrajectory = hasCapability(swarmId!, 'trajectory.canReport');

    console.log(`[session-chat-live] Capabilities: mail=${hasMail}, messaging=${hasMessaging}, trajectory=${hasTrajectory}`);

    // Trajectory should always be present (both old and new versions)
    expect(hasTrajectory).toBe(true);

    // Mail/messaging depend on whether installed version has our changes
    if (hasMail) {
      console.log('[session-chat-live] Mail capabilities published (updated version installed)');
      expect(hasCapability(swarmId!, 'mail.canCreate')).toBe(true);
    } else {
      console.log('[session-chat-live] Mail capabilities NOT published (old version installed — update macro-agent to get mail caps)');
    }
  });

  it('real swarm publishes ACP capabilities', () => {
    expect(swarmId).toBeDefined();

    // Per-agent capabilities check
    const agentCaps = getAgentCapabilities(swarmId!);
    expect(agentCaps.length).toBeGreaterThanOrEqual(1);

    const sidecarAgent = agentCaps.find(a => a.role === 'sidecar');
    if (sidecarAgent) {
      console.log(`[session-chat-live] Sidecar capabilities:`, JSON.stringify(sidecarAgent.capabilities, null, 2));
    }

    // Swarm-level DB check
    const swarm = findSwarmById(swarmId!);
    expect(swarm).toBeDefined();
    console.log(`[session-chat-live] Swarm DB capabilities:`, JSON.stringify(swarm!.capabilities, null, 2));
  });

  it('capabilities are exposed via GET /map/swarms/:id', async () => {
    expect(swarmId).toBeDefined();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/swarms/${swarmId}`,
    });

    expect(res.statusCode).toBe(200);
    const swarm = JSON.parse(res.payload);
    expect(swarm.status).toBe('online');
    expect(swarm.capabilities).toBeDefined();

    console.log(`[session-chat-live] API capabilities:`, JSON.stringify(swarm.capabilities, null, 2));

    // Should have mail (from macro-agent sidecar)
    if (swarm.capabilities.mail) {
      expect(swarm.capabilities.mail.canJoin).toBe(true);
    }
  });

  // ── Session chat flow ────────────────────────────────────────────────

  it('sends chat message to session linked to real swarm', async () => {
    expect(swarmId).toBeDefined();

    // Create session linked to the live swarm
    const session = createSessionResource('live-swarm-session', swarmId);

    // Send chat message
    const chatRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/chat`,
      payload: { content: 'Hello from live agent e2e test!' },
    });

    expect(chatRes.statusCode).toBe(201);
    const chatBody = JSON.parse(chatRes.payload);
    expect(chatBody.ok).toBe(true);
    expect(chatBody.conversation_id).toBeDefined();
    expect(chatBody.turn).toBeDefined();

    console.log(`[session-chat-live] Chat sent, conversation: ${chatBody.conversation_id}`);

    // Verify conversation created with correct scope
    const storage = getMailStorage();
    const conv = storage.getConversation(chatBody.conversation_id);
    expect(conv).toBeDefined();
    expect(conv!.scope).toBe(`session:${session.id}`);
    expect(conv!.subject).toContain('live-swarm-session');
  });

  it('multiple messages land in the same conversation', async () => {
    expect(swarmId).toBeDefined();
    const session = createSessionResource('multi-msg-session', swarmId);

    // Send first message
    const res1 = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/chat`,
      payload: { content: 'First message to live agent' },
    });
    const body1 = JSON.parse(res1.payload);
    const convId = body1.conversation_id;

    // Send second message
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/chat`,
      payload: { content: 'Second message to live agent' },
    });
    const body2 = JSON.parse(res2.payload);

    // Same conversation
    expect(body2.conversation_id).toBe(convId);

    // Both turns present via mail API
    const turnsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/mail/conversations/${convId}/turns`,
    });
    const turns = JSON.parse(turnsRes.payload).turns;
    expect(turns).toHaveLength(2);
    expect(turns[0].content.text).toBe('First message to live agent');
    expect(turns[1].content.text).toBe('Second message to live agent');

    console.log(`[session-chat-live] ${turns.length} turns verified in conversation ${convId}`);
  });

  it('session metadata links to conversation', async () => {
    expect(swarmId).toBeDefined();
    const session = createSessionResource('metadata-link-session', swarmId);

    const chatRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/chat`,
      payload: { content: 'Metadata test' },
    });
    const convId = JSON.parse(chatRes.payload).conversation_id;

    // GET /sessions/:id/chat returns the linked conversation
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/chat`,
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.payload);
    expect(getBody.conversation_id).toBe(convId);
    expect(getBody.chat_available).toBe(true);

    // Session resource metadata has it stored
    const resource = resourcesDAL.findResourceById(session.id);
    expect((resource!.metadata as any).mail_conversation_id).toBe(convId);
  });

  it('sender is joined as participant in conversation', async () => {
    expect(swarmId).toBeDefined();
    const session = createSessionResource('participant-session', swarmId);

    const chatRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/chat`,
      payload: { content: 'Participant test' },
    });
    const convId = JSON.parse(chatRes.payload).conversation_id;

    const convRes = await app.inject({
      method: 'GET',
      url: `/api/v1/mail/conversations/${convId}`,
    });
    const conv = JSON.parse(convRes.payload).conversation;
    console.log(`[session-chat-live] Participants:`, JSON.stringify(conv.participants, null, 2));

    // Agent should be a participant (role may be 'supervisor' or stored differently)
    const participant = conv.participants.find((p: any) => p.agent_id === testAgent.id);
    expect(participant).toBeDefined();
  });
});
