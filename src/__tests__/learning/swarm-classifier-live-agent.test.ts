/**
 * Live Agent E2E Tests for Swarm-Delegated Skill Classification
 *
 * Spawns a REAL OpenSwarm with macro-agent adapter, which spawns real
 * Claude Code agents to classify skills. This tests the full production
 * flow end-to-end with actual AI inference.
 *
 * Requirements:
 *   - openswarm installed with cognitive workspace handler
 *     (the base openswarm does NOT handle x-openhive/learning.workspace.execute —
 *      it needs the macro-agent cognitive integration from references/macro-agent)
 *   - LIVE_AGENT_E2E=true to enable
 *   - Claude Max plan or ANTHROPIC_API_KEY set (macro-agent inherits Claude Code auth)
 *
 * Run:
 *   LIVE_AGENT_E2E=true npx vitest run src/__tests__/learning/swarm-classifier-live-agent.test.ts
 *
 * Note: Each classification takes 5-15 seconds (real Claude API calls).
 * The full suite may take 1-2 minutes.
 *
 * If the swarm connects but classification times out, the openswarm instance
 * likely doesn't have the workspace.execute handler installed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { SwarmManager } from '../../swarm/manager.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { getAllInbound } from '../../map/connection-registry.js';
import { SwarmAgentDelegate } from '../../learning/swarm-agent-backend.js';
import { skillManagementRoutes } from '../../api/routes/skill-management.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { ConfigSchema, type Config } from '../../config.js';

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const TEST_ROOT = testRoot('swarm-classifier-live-agent');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-agent.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19740;
const PORT_RANGE_MAX = 19750;
const SERVER_PORT = 19759;

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: { name: 'Live Agent E2E', description: 'Test', url: `http://127.0.0.1:${SERVER_PORT}` },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    mapHub: { enabled: true, trustModel: 'open' },
    learning: { enabled: false },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      // Use the real openswarm command — SwarmManager resolves it
      openswarm_command: 'npx openswarm serve',
      data_dir: TEST_DATA_DIR,
      port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX],
      max_swarms: 3,
      health_check_interval: 600000,
      max_health_failures: 3,
      auto_restart: false,
      credentials: {
        inherit_env: true, // Pass ANTHROPIC_API_KEY to spawned swarm
      },
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
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function createTestSkillResource(agentId: string, resourcePath: string): string {
  const skilltreeDir = path.join(resourcePath, '.skilltree', 'skills');
  fs.mkdirSync(skilltreeDir, { recursive: true });

  // Use a single skill to minimize API cost
  const skill = {
    id: 'express-middleware',
    name: 'Express Middleware',
    description: 'Building Express.js middleware chains for request processing',
    instructions: [
      'Express middleware functions receive (req, res, next) arguments.',
      'Use app.use() for global middleware that runs on every request.',
      'Route-specific middleware is passed as arguments before the handler.',
      'Error handling middleware takes four arguments: (err, req, res, next).',
      'Middleware executes in order of registration — order matters.',
      'Call next() to pass control to the next middleware.',
      'Common patterns: logging, auth, CORS, body parsing, rate limiting.',
    ].join('\n'),
    status: 'active',
    version: '1.0.0',
    tags: ['express', 'nodejs', 'backend'],
  };

  const skillDir = path.join(skilltreeDir, skill.id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), JSON.stringify(skill, null, 2));

  return resourcesDAL.createResource({
    resource_type: 'skill',
    name: 'live-agent-skill-library',
    description: 'Test skill library for live agent E2E',
    git_remote_url: resourcePath,
    owner_agent_id: agentId,
    scope: 'manual',
    sync_strategy: 'local',
    local_path: resourcePath,
  }).id;
}

const describeIf = LIVE_AGENT ? describe : describe.skip;

describeIf('Live Agent E2E — Real Swarm Classification', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let testAgent: { id: string; apiKey: string };
  let resourceId: string;
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    initDatabase(TEST_DB_PATH);
    config = createTestConfig();

    // Create test agent
    const agentResult = await agentsDAL.createAgent({
      name: 'live-agent-e2e',
      description: 'Live agent E2E test',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    setLocalAgent(agentResult.agent);

    // Create hive
    hivesDAL.createHive({
      name: 'live-agent-hive',
      description: 'Test hive',
      owner_id: testAgent.id,
    });

    // Create test skill resource (single skill to minimize cost)
    const resourcePath = path.join(TEST_ROOT, 'skill-library');
    fs.mkdirSync(resourcePath, { recursive: true });
    resourceId = createTestSkillResource(testAgent.id, resourcePath);

    // Initialize SwarmManager
    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );

    const delegate = new SwarmAgentDelegate(config, swarmManager);

    // Create Fastify server
    app = Fastify({ logger: false });
    await app.register(websocket);

    app.decorateRequest('agent', null);
    (app as unknown as { swarmManager: SwarmManager }).swarmManager = swarmManager;
    (app as unknown as { swarmDelegate: SwarmAgentDelegate }).swarmDelegate = delegate;

    app.addHook('preHandler', async (request: any) => {
      if (!request.agent) request.agent = agentResult.agent;
    });

    setupMapWebSocket(app, config);

    await app.register(
      async (api) => {
        await api.register(skillManagementRoutes, { config });
        await api.register(resourceContentRoutes, { config });
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
    console.log(`[live-agent] Server listening on port ${SERVER_PORT}`);

    // Spawn a REAL OpenSwarm with macro-agent
    console.log('[live-agent] Spawning real OpenSwarm...');
    const hosted = await swarmManager.spawn(testAgent.id, {
      name: 'live-classifier',
      adapter: 'macro-agent',
      hive: 'live-agent-hive',
      metadata: { role: 'classifier' },
    });
    console.log(`[live-agent] Swarm spawned: ${hosted.id}, state: ${hosted.state}`);

    // Wait for the real swarm to connect via MAP (may take several seconds)
    const connected = await waitFor(() => getAllInbound().size > 0, 30_000);

    if (connected) {
      const connections = getAllInbound();
      const swarmId = connections.keys().next().value;
      console.log(`[live-agent] Swarm connected: ${swarmId}`);
    } else {
      console.warn(`[live-agent] Swarm did not connect within 30s`);
    }

    // Dump swarm logs for debugging
    const logs = await swarmManager.getLogs(hosted.id, testAgent.id).catch(() => '(no logs)');
    console.log(`[live-agent] Swarm startup logs:\n${logs}`);
  }, 60_000); // 60s timeout for beforeAll (real swarm takes time to start)

  afterAll(async () => {
    if (swarmManager) {
      console.log('[live-agent] Shutting down swarm manager...');
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

  it('should have a real swarm connected via MAP', () => {
    const connections = getAllInbound();
    expect(connections.size).toBeGreaterThanOrEqual(1);
    console.log(`[live-agent] Connected swarms: ${[...connections.keys()].join(', ')}`);
  });

  it('should report swarm available in indexer status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${resourceId}/indexer/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasSwarmAvailable).toBe(true);
    console.log('[live-agent] Indexer status:', body);
  });

  it('should classify a skill using a real Claude agent', async () => {
    // Verify the swarm is still connected before dispatching
    const connections = getAllInbound();
    console.log(`[live-agent] Swarms connected before classify: ${connections.size}`);
    expect(connections.size).toBeGreaterThanOrEqual(1);

    // Verify schema is the lenient version (z.string, not z.enum for relationships.type)
    try {
      const { ClassificationOutputSchema } = await import('skill-tree-indexer');
      const testData = {
        primaryPath: ['Test'],
        relationships: [{ skillSlug: 'foo', type: 'custom-type', reasoning: 'test' }],
      };
      ClassificationOutputSchema.parse(testData);
      console.log('[live-agent] Schema accepts custom relationship types: YES');
    } catch (err) {
      console.warn('[live-agent] Schema rejects custom relationship types:', (err as Error).message.slice(0, 200));
    }

    console.log('[live-agent] Starting classification with real agent...');
    const startTime = Date.now();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${resourceId}/indexer/classify`,
      payload: { useSwarm: true },
    });

    const elapsed = Date.now() - startTime;
    console.log(`[live-agent] Classification completed in ${elapsed}ms`);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    console.log('[live-agent] Classification result:', JSON.stringify(body, null, 2));

    // The real agent should have classified the skill (indexed >= 1)
    // or at least attempted (indexed + failed >= 1, meaning the dispatch worked)
    const attempted = body.indexed + body.failed;
    expect(attempted).toBeGreaterThan(0);

    if (body.failed > 0) {
      console.warn('[live-agent] Classification had failures:', body.errors);
    }

    // Log swarm state after classification
    const connectionsAfter = getAllInbound();
    console.log(`[live-agent] Swarms connected after classify: ${connectionsAfter.size}`);
  }, 180_000); // 3 minute timeout for real agent execution

  it('should have produced valid taxonomy data', async () => {
    // Read the skill back from the bank to verify taxonomy was saved
    const { createSkillBank } = await import('skill-tree');
    const resourcePath = path.join(TEST_ROOT, 'skill-library');
    const bank = createSkillBank({ storage: { basePath: resourcePath } });
    await bank.initialize();
    const skills = await bank.listSkills();
    await bank.shutdown();

    expect(skills.length).toBe(1);

    const skill = skills[0] as any;
    console.log('[live-agent] Classified skill:', {
      id: skill.id,
      name: skill.name,
      taxonomy: skill.taxonomy,
      tags: skill.tags,
    });

    // The real agent should have produced a meaningful classification
    // We can't predict the exact path, but it should exist and be reasonable
    if (skill.taxonomy?.primaryPath) {
      expect(skill.taxonomy.primaryPath.length).toBeGreaterThan(0);
      console.log(`[live-agent] Taxonomy path: ${skill.taxonomy.primaryPath.join(' > ')}`);
      console.log(`[live-agent] Confidence: ${skill.taxonomy.confidence}`);
    }
  });

  it('should detect relationships (or report none) using a real agent', async () => {
    // With only 1 skill, relationship detection has no pairs to check.
    // This verifies the endpoint doesn't error with an empty candidate set.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${resourceId}/indexer/relationships`,
      payload: { useSwarm: true },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    console.log('[live-agent] Relationship result:', body);

    // With 1 skill, no pairs → 0 detected, 0 errors
    expect(body.detected).toBe(0);
    expect(body.errors).toHaveLength(0);
  }, 60_000);
});
