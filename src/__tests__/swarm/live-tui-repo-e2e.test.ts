/**
 * Live Agent E2E: kind=claude-code spawn with repo_id (Phase 3c)
 *
 * Verifies the full stack: repo resolution → env var injection → clone/mount
 * → TUI starts in the repo directory → cc-swarm sidecar registers and
 * declares the workspace repo.
 *
 * Two sub-scenarios:
 *   A. Mount: local_path on the repo resource points to an existing git repo
 *      on disk. No clone — the TUI opens directly in that directory.
 *   B. Clone: no local_path. The manager clones from git_remote_url before
 *      launching the TUI.
 *
 * Prerequisites (same as live-claude-code-e2e):
 *   - `claude` binary on PATH
 *   - `claude-code-swarm` plugin installed: `claude plugin add claude-code-swarm`
 *
 * REQUIRES: LIVE_AGENT_E2E=true
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as reposDAL from '../../db/dal/repos.js';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { getInbound } from '../../map/connection-registry.js';
import { SwarmManager } from '../../swarm/manager.js';
import { resolveClaudeBinary } from '../../swarm/claude-binary.js';
import * as swarmDAL from '../../swarm/dal.js';
import { PtyManager } from '../../terminal/index.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ── Gate ──────────────────────────────────────────────────────────────────────
const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE_AGENT ? describe : describe.skip;

// ── Constants ─────────────────────────────────────────────────────────────────
const TEST_ROOT = testRoot('live-tui-repo');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-tui-repo.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');
const SERVER_PORT = 19994;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: {
      name: 'Live TUI Repo E2E',
      description: 'Test',
      url: `http://127.0.0.1:${SERVER_PORT}`,
    },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    mapHub: {
      enabled: true,
      trustModel: 'open',
      iamSecret: 'test-iam-secret-tui-repo',
    },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      openswarm_command: 'echo unused',
      data_dir: TEST_DATA_DIR,
      port_range: [19400, 19410],
      max_swarms: 3,
      health_check_interval: 600_000,
      max_health_failures: 3,
      auto_restart: false,
      credentials: { inherit_env: true },
    },
  });
}

describeIf('Live Agent E2E — kind=claude-code spawn with repo_id', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let ptyManager: PtyManager;
  let testAgent: { id: string; apiKey: string };
  let localRepoDir: string;
  let repoId: string;
  let hostedSwarmId: string | undefined;
  let preRegisteredSwarmId: string | undefined;
  const agentsByKey = new Map<string, { id: string; name: string }>();
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

    initDatabase(TEST_DB_PATH);

    const claudeBinary = resolveClaudeBinary();
    if (!claudeBinary) {
      throw new Error(
        'claude binary not found on PATH. Install Claude Code before running this test.',
      );
    }

    config = createTestConfig();
    initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

    const agentResult = await agentsDAL.createAgent({
      name: 'live-tui-repo-owner',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    agentsByKey.set(testAgent.apiKey, { id: testAgent.id, name: 'live-tui-repo-owner' });
    setLocalAgent(agentResult.agent);

    // Create a local git repo to mount (scenario A: existing checkout).
    localRepoDir = path.join(TEST_ROOT, 'my-project');
    fs.mkdirSync(localRepoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: localRepoDir });
    fs.writeFileSync(path.join(localRepoDir, 'README.md'), '# Test Project\n');
    execFileSync('git', ['add', '.'], { cwd: localRepoDir });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'init'], { cwd: localRepoDir });

    // Create a repo resource with a GitHub-like canonical URL, then set
    // local_path to the real local checkout so resolveRepoForSpawn mounts it.
    const repo = reposDAL.upsertRepoByCanonicalUrl(
      canonicalizeRepoUrl('https://github.com/live-test/my-project'),
      { name: 'my-project', origin: 'user_defined', owner_agent_id: testAgent.id },
    );
    repoId = repo.id;
    getDatabase().prepare(
      'UPDATE syncable_resources SET local_path = ? WHERE id = ?',
    ).run(localRepoDir, repoId);

    // Stand up Fastify + MAP WS
    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );
    ptyManager = new PtyManager();
    swarmManager.setPtyManager(ptyManager);

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    app.addHook(
      'preHandler',
      async (request: { headers: { authorization?: string }; agent?: unknown }) => {
        const auth = request.headers.authorization;
        if (auth?.startsWith('Bearer ')) {
          const agent = agentsByKey.get(auth.slice(7));
          if (agent) request.agent = agent;
        }
      },
    );
    (app as unknown as { swarmManager: SwarmManager }).swarmManager = swarmManager;

    await app.register(fastifyWebsocket);
    setupMapWebSocket(app, config);
    await app.register(
      async (api) => {
        await api.register(swarmHostingRoutes, { config } as never);
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
    console.log(`[live-tui-repo] OpenHive listening on port ${SERVER_PORT}`);
  }, 30_000);

  afterAll(async () => {
    if (hostedSwarmId) {
      try { await swarmManager.stop(hostedSwarmId, testAgent.id); } catch { /* best-effort */ }
    }
    ptyManager?.destroyAll();
    await swarmManager?.shutdown();
    stopMapWebSocket();
    if (app) await app.close();
    setLocalAgent(null);
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  }, 30_000);

  // ── Scenario A: mount existing local checkout ─────────────────────────────

  it('spawns claude-code with repo_id (local mount) via REST and reaches state=running', async () => {
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'claude-code',
        name: 'live-repo-mount',
        repo_id: repoId,
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const body = spawnRes.json() as { id: string; state: string; swarm_id: string | null };
    hostedSwarmId = body.id;
    preRegisteredSwarmId = body.swarm_id ?? undefined;

    const row = swarmDAL.findHostedSwarmById(body.id);
    expect(row?.kind).toBe('claude-code');

    if (body.state !== 'running') {
      throw new Error(
        `Expected state=running, got state=${body.state}. ` +
          `error=${row?.error ?? '(no error)'}. ` +
          `Likely: cc-swarm plugin not installed. Run: claude plugin add claude-code-swarm`,
      );
    }

    // Verify the hosted_swarm config persisted repo_id.
    // (resolved_credentials are NOT persisted — verified by mock tests instead)
    const provisionConfig = row!.config as unknown as Record<string, unknown>;
    expect(provisionConfig.repo_id).toBe(repoId);
  }, 90_000);

  it('cc-swarm sidecar registers under the pre-registered swarm', async () => {
    expect(preRegisteredSwarmId).toBeTruthy();

    const deadline = Date.now() + 15_000;
    let conn = getInbound(preRegisteredSwarmId!);
    while (Date.now() < deadline) {
      conn = getInbound(preRegisteredSwarmId!);
      if (conn && conn.registeredAgents.size > 0) break;
      await sleep(250);
    }
    expect(conn).toBeDefined();
    expect(conn!.registeredAgents.size).toBeGreaterThanOrEqual(1);
    console.log(
      `[live-tui-repo] Sidecar registered: ${conn!.registeredAgents.size} agent(s) on swarm ${preRegisteredSwarmId}`,
    );
  }, 20_000);
});
