/**
 * Live Agent E2E: codex approval round-trip
 *
 * Verifies the end-to-end wiring of the openhive permission flow against a
 * REAL `codex app-server`:
 *   1. spawn a kind=codex / mode=rpc hosted swarm
 *   2. send a turn that requires shell-command approval
 *   3. observe the manager emit a `request` event whose method is one of
 *      the codex approval RPCs (legacy `execCommandApproval` or v2
 *      `item/commandExecution/requestApproval`)
 *   4. reply via `manager.replyCodexPermission(swarmId, requestId, 'approved')`
 *      and assert codex unblocks (turn completes)
 *   5. fresh swarm, repeat but reply 'denied' and assert codex still
 *      progresses (denied means codex moves on without running the cmd)
 *   6. fresh swarm, trigger an approval and verify the REST endpoint path
 *      (POST /api/v1/map/hosted/:id/chat/permission/:requestId)
 *
 * Prerequisites: `codex` on PATH, codex login completed.
 *
 * REQUIRES: LIVE_AGENT_E2E=true
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { SwarmManager } from '../../swarm/manager.js';
import { resolveCodexBinary } from '../../swarm/codex-binary.js';
import { CodexAppServerManager } from '../../swarm/codex-app-server-manager.js';
import * as swarmDAL from '../../swarm/dal.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE_AGENT ? describe : describe.skip;

const TEST_ROOT = testRoot('live-codex-approval');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-codex-approval.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');
const SERVER_PORT = 20033;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: {
      name: 'Live codex-approval E2E',
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
      iamSecret: 'test-iam-secret-codex-approval',
    },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      openswarm_command: 'echo unused',
      data_dir: TEST_DATA_DIR,
      port_range: [20040, 20060],
      max_swarms: 4,
      health_check_interval: 600_000,
      max_health_failures: 3,
      auto_restart: false,
      credentials: { inherit_env: true },
    },
  });
}

/**
 * Approval method names codex emits. Both legacy v1 and v2 surfaces are
 * accepted — codex's defaults may emit either depending on version.
 */
const APPROVAL_METHODS = new Set([
  'execCommandApproval',
  'applyPatchApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

/**
 * Wait for an approval `request` event matching the running codex session.
 * Resolves with the first approval-flavored request id + method seen
 * within `timeoutMs`. Rejects on timeout.
 */
function waitForApproval(
  mgr: CodexAppServerManager,
  codexSessionId: string,
  timeoutMs = 60_000,
): Promise<{ requestId: string; method: string }> {
  return new Promise((resolve, reject) => {
    const onRequest = (event: { sessionId: string; requestId: string; method: string }): void => {
      if (event.sessionId !== codexSessionId) return;
      if (!APPROVAL_METHODS.has(event.method)) return;
      mgr.off('request', onRequest);
      clearTimeout(timer);
      resolve({ requestId: event.requestId, method: event.method });
    };
    const timer = setTimeout(() => {
      mgr.off('request', onRequest);
      reject(new Error(`no codex approval request emitted within ${timeoutMs}ms (check codex approval_policy default)`));
    }, timeoutMs);
    mgr.on('request', onRequest);
  });
}

/** Wait for `turn/completed` on the given codex session. */
function waitForTurnCompleted(
  mgr: CodexAppServerManager,
  codexSessionId: string,
  timeoutMs = 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onNotif = (ev: { sessionId: string; method: string }): void => {
      if (ev.sessionId !== codexSessionId) return;
      if (ev.method !== 'turn/completed') return;
      mgr.off('notification', onNotif);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      mgr.off('notification', onNotif);
      reject(new Error(`turn/completed not seen within ${timeoutMs}ms`));
    }, timeoutMs);
    mgr.on('notification', onNotif);
  });
}

/** Strongly suggest a shell command that codex's approval policy should gate. */
const APPROVAL_TRIGGERING_PROMPT = [
  'Please execute the shell command `rm -rf /tmp/codex-approval-test-marker`.',
  'The file does not need to exist; just run the command.',
  'DO NOT just describe the command — actually invoke the shell to run it.',
].join(' ');

describeIf('Live Agent E2E — codex approval round-trip', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let codexAppServerManager: CodexAppServerManager;
  let testAgent: { id: string; apiKey: string };
  const agentsByKey = new Map<string, { id: string; name: string }>();
  const originalHome = process.env.OPENHIVE_HOME;
  /** Track hosted swarms spawned per test so afterEach can clean them up. */
  const spawnedSwarmIds = new Set<string>();

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

    initDatabase(TEST_DB_PATH);

    if (!resolveCodexBinary()) {
      throw new Error('codex binary not found on PATH. Install Codex before running this test.');
    }

    config = createTestConfig();
    initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

    const agentResult = await agentsDAL.createAgent({
      name: 'live-codex-approval-owner',
      description: 'Owner for live codex-approval E2E',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    agentsByKey.set(testAgent.apiKey, { id: testAgent.id, name: 'live-codex-approval-owner' });
    setLocalAgent(agentResult.agent);

    hivesDAL.createHive({
      name: 'live-codex-approval-hive',
      description: 'Hive for live codex-approval E2E',
      owner_id: testAgent.id,
    });

    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );
    codexAppServerManager = new CodexAppServerManager();
    swarmManager.setCodexAppServerManager(codexAppServerManager);

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    app.addHook(
      'preHandler',
      async (request: { headers: { authorization?: string }; agent?: unknown }) => {
        const auth = request.headers.authorization;
        if (auth?.startsWith('Bearer ')) {
          const token = auth.slice(7);
          const agent = agentsByKey.get(token);
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
    console.log(`[live-codex-approval] OpenHive listening on port ${SERVER_PORT}`);
  }, 30_000);

  afterEach(async () => {
    for (const id of Array.from(spawnedSwarmIds)) {
      try { await swarmManager.stop(id, testAgent.id); } catch { /* best-effort */ }
      spawnedSwarmIds.delete(id);
    }
  });

  afterAll(async () => {
    codexAppServerManager?.destroyAll();
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

  async function spawnSwarm(name: string): Promise<{ hostedSwarmId: string; codexSessionId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: { kind: 'codex', mode: 'rpc', name, description: 'live approval test' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; state: string };
    if (body.state !== 'running') {
      const row = swarmDAL.findHostedSwarmById(body.id);
      throw new Error(`expected state=running, got state=${body.state}, error=${row?.error}`);
    }
    spawnedSwarmIds.add(body.id);
    const codexSid = swarmManager.getCodexRpcSessionId(body.id);
    if (!codexSid) throw new Error('no codex session id for spawned swarm');
    return { hostedSwarmId: body.id, codexSessionId: codexSid };
  }

  // ── 1. Approve path: codex requests approval → we approve → codex continues ──

  it('approval-approved: codex requests, we approve via manager, turn completes', async () => {
    const { hostedSwarmId, codexSessionId } = await spawnSwarm('approve-path');

    // Kick off the turn (don't await — completion happens after we reply).
    const turnPromise = codexAppServerManager.sendTurn(codexSessionId, APPROVAL_TRIGGERING_PROMPT);
    const turnCompleted = waitForTurnCompleted(codexAppServerManager, codexSessionId, 90_000);

    // Wait for codex's approval request.
    const approval = await waitForApproval(codexAppServerManager, codexSessionId, 60_000);
    console.log(`[live-codex-approval] Got approval request: method=${approval.method} requestId=${approval.requestId}`);
    expect(APPROVAL_METHODS.has(approval.method)).toBe(true);

    await turnPromise;

    // Approve via the manager's typed reply path (same code REST hits).
    swarmManager.replyCodexPermission(hostedSwarmId, approval.requestId, 'approved');

    // Codex should now complete the turn.
    await turnCompleted;
  }, 180_000);

  // ── 2. Deny path: codex requests approval → we deny → codex still progresses ──

  it('approval-denied: replying denied lets codex move on without hanging', async () => {
    const { hostedSwarmId, codexSessionId } = await spawnSwarm('deny-path');

    const turnPromise = codexAppServerManager.sendTurn(codexSessionId, APPROVAL_TRIGGERING_PROMPT);
    const turnCompleted = waitForTurnCompleted(codexAppServerManager, codexSessionId, 90_000);

    const approval = await waitForApproval(codexAppServerManager, codexSessionId, 60_000);
    console.log(`[live-codex-approval] Got approval request (deny): method=${approval.method}`);

    await turnPromise;
    swarmManager.replyCodexPermission(hostedSwarmId, approval.requestId, 'denied');

    // Even on denial, codex should complete the turn (it doesn't run the
    // command, but it doesn't deadlock either).
    await turnCompleted;
  }, 180_000);

  // ── 3. REST endpoint path: POST /map/hosted/:id/chat/permission/:requestId ──

  it('REST: approving via the new endpoint reaches codex and completes the turn', async () => {
    const { hostedSwarmId, codexSessionId } = await spawnSwarm('rest-path');

    const turnPromise = codexAppServerManager.sendTurn(codexSessionId, APPROVAL_TRIGGERING_PROMPT);
    const turnCompleted = waitForTurnCompleted(codexAppServerManager, codexSessionId, 90_000);

    const approval = await waitForApproval(codexAppServerManager, codexSessionId, 60_000);
    await turnPromise;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/chat/permission/${encodeURIComponent(approval.requestId)}`,
      headers: { authorization: `Bearer ${testAgent.apiKey}`, 'content-type': 'application/json' },
      payload: { decision: 'approved' },
    });
    expect(res.statusCode).toBe(204);

    await turnCompleted;
  }, 180_000);

  it('REST: invalid decision is rejected with 422', async () => {
    const { hostedSwarmId, codexSessionId } = await spawnSwarm('validation-path');

    const turnPromise = codexAppServerManager.sendTurn(codexSessionId, APPROVAL_TRIGGERING_PROMPT);
    const approval = await waitForApproval(codexAppServerManager, codexSessionId, 60_000);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/chat/permission/${encodeURIComponent(approval.requestId)}`,
      headers: { authorization: `Bearer ${testAgent.apiKey}`, 'content-type': 'application/json' },
      payload: { decision: 'maybe' },
    });
    expect(res.statusCode).toBe(422);

    // Clean up: actually approve so the in-flight turn doesn't hang the
    // afterEach teardown.
    swarmManager.replyCodexPermission(hostedSwarmId, approval.requestId, 'denied');
    await turnPromise.catch(() => { /* swallow — interrupted on stop */ });
    await sleep(500);
  }, 180_000);

  it('REST: 404 when no pending permission matches the id', async () => {
    const { hostedSwarmId } = await spawnSwarm('not-found-path');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/chat/permission/no-such-request`,
      headers: { authorization: `Bearer ${testAgent.apiKey}`, 'content-type': 'application/json' },
      payload: { decision: 'approved' },
    });
    expect(res.statusCode).toBe(404);
  }, 60_000);
});
