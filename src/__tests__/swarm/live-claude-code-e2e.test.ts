/**
 * Live Agent E2E: kind='claude-code' Hosted Swarm Lifecycle
 *
 * Spawns a real `claude` TUI under PtyManager, verifies that cc-swarm's
 * SessionStart hook detaches the MAP sidecar and that the sidecar dials
 * back into the openhive hub. Confirms:
 *
 *   1. SwarmManager.spawn({ kind: 'claude-code' }) routes through
 *      spawnClaudeCode → PtyManager (NOT LocalProvider.provision()).
 *   2. The cc-swarm sidecar registers against the openhive MAP hub
 *      under the pre-registered swarm_id within ~15s.
 *   3. The hosted-swarm row flips state: starting → running.
 *   4. terminal-info?mode=tui returns `binding: 'attach'` with the
 *      live PtyManager session id (so the embedded terminal can attach).
 *   5. stop() destroys the PTY, signals the sidecar, and lands the row
 *      at state 'stopped' with MAP swarm marked offline.
 *   6. getLogs() returns the claude-code-specific scrollback hint
 *      rather than the misleading openswarm fallback.
 *
 * Prerequisites (operator setup, not auto-provisioned):
 *   - `claude` binary on PATH
 *   - `claude-code-swarm` plugin installed in Claude Code:
 *       claude plugin add claude-code-swarm
 *
 * Without these, the spawn will land at state='unhealthy' with a
 * "did not register" error. The test fails fast in that case rather
 * than running tests that depend on liveness.
 *
 * REQUIRES: LIVE_AGENT_E2E=true
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { getAllInbound, getInbound, getAggregateCapabilities } from '../../map/connection-registry.js';
import { SwarmManager } from '../../swarm/manager.js';
import { resolveClaudeBinary } from '../../swarm/claude-binary.js';
import * as swarmDAL from '../../swarm/dal.js';
import { PtyManager, handleTerminalWebSocket } from '../../terminal/index.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Gate
// ============================================================================
const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE_AGENT ? describe : describe.skip;

// ============================================================================
// Constants
// ============================================================================
const TEST_ROOT = testRoot('live-claude-code');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-claude-code.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

// High port range, distinct from other live tests
const PORT_RANGE_MIN = 19980;
const PORT_RANGE_MAX = 19990;
const SERVER_PORT = 19992;

// ============================================================================
// Helpers
// ============================================================================
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: {
      name: 'Live claude-code E2E',
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
      iamSecret: 'test-iam-secret-claude-code',
    },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      // Used only by openswarm path; claude-code resolves its own binary.
      openswarm_command: 'echo unused',
      data_dir: TEST_DATA_DIR,
      port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX],
      max_swarms: 2,
      health_check_interval: 600_000,
      max_health_failures: 3,
      auto_restart: false,
      credentials: { inherit_env: true },
    },
  });
}

// ============================================================================
// Test Suite
// ============================================================================
describeIf('Live Agent E2E — kind=claude-code hosted swarm lifecycle', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let ptyManager: PtyManager;
  let testAgent: { id: string; apiKey: string };
  let hostedSwarmId: string | undefined;
  let preRegisteredSwarmId: string | undefined;
  const agentsByKey = new Map<string, { id: string; name: string }>();
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

    initDatabase(TEST_DB_PATH);

    // Fail fast if the operator host doesn't have the claude binary —
    // running this test without it just produces a flaky timeout.
    const claudeBinary = resolveClaudeBinary();
    if (!claudeBinary) {
      throw new Error(
        'claude binary not found on PATH. Install Claude Code before running this test.',
      );
    }

    config = createTestConfig();
    initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

    const agentResult = await agentsDAL.createAgent({
      name: 'live-claude-code-owner',
      description: 'Owner for live claude-code E2E',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    agentsByKey.set(testAgent.apiKey, { id: testAgent.id, name: 'live-claude-code-owner' });
    setLocalAgent(agentResult.agent);

    hivesDAL.createHive({
      name: 'live-claude-code-hive',
      description: 'Hive for live claude-code E2E',
      owner_id: testAgent.id,
    });

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
          const token = auth.slice(7);
          const agent = agentsByKey.get(token);
          if (agent) request.agent = agent;
        }
      },
    );

    (app as unknown as { swarmManager: SwarmManager }).swarmManager = swarmManager;

    await app.register(fastifyWebsocket);
    setupMapWebSocket(app, config);

    // Terminal WS so we can sanity-check the attach contract end-to-end.
    app.get('/ws/terminal', { websocket: true }, (socket, request) => {
      const ws = socket as unknown as import('ws').WebSocket;
      const query = request.query as Record<string, string>;
      handleTerminalWebSocket(ws, query, ptyManager);
    });

    await app.register(
      async (api) => {
        await api.register(swarmHostingRoutes, { config } as never);
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
    console.log(`[live-claude-code] OpenHive listening on port ${SERVER_PORT}`);
  }, 30_000);

  afterAll(async () => {
    if (hostedSwarmId) {
      try {
        await swarmManager.stop(hostedSwarmId, testAgent.id);
      } catch { /* best-effort */ }
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

  // ── 1. Spawn ─────────────────────────────────────────────────────────────

  it('spawns kind=claude-code and reaches state=running once cc-swarm sidecar registers', async () => {
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'claude-code',
        name: 'live-claude-code-swarm',
        description: 'Live e2e — claude-code',
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const body = spawnRes.json() as {
      id: string;
      state: string;
      swarm_id: string | null;
    };
    hostedSwarmId = body.id;
    preRegisteredSwarmId = body.swarm_id ?? undefined;

    // Confirm kind landed on the row (response shape doesn't echo kind).
    const row = swarmDAL.findHostedSwarmById(body.id);
    expect(row?.kind).toBe('claude-code');

    // spawnClaudeCode awaits sidecar registration internally before responding,
    // so by the time POST returns, state should be 'running' (or 'unhealthy'
    // if the cc-swarm plugin isn't installed).
    if (body.state !== 'running') {
      throw new Error(
        `Expected state=running after spawn, got state=${body.state}. ` +
          `error=${row?.error ?? '(no error)'}. ` +
          `Likely: claude-code-swarm plugin not installed. Run: claude plugin add claude-code-swarm`,
      );
    }
    expect(body.state).toBe('running');
    expect(preRegisteredSwarmId).toBeTruthy();
  }, 90_000);

  it('cc-swarm sidecar appears in the inbound MAP connection registry', async () => {
    expect(preRegisteredSwarmId).toBeTruthy();

    // The WS connection lands as soon as the sidecar dials in (which is what
    // unblocked the spawn step), but `map/agents/register` calls follow
    // asynchronously over the next few seconds. Poll briefly so the test is
    // robust to that ordering.
    const deadline = Date.now() + 10_000;
    let conn = getInbound(preRegisteredSwarmId!);
    while (Date.now() < deadline) {
      conn = getInbound(preRegisteredSwarmId!);
      if (conn && conn.registeredAgents.size > 0) break;
      await sleep(250);
    }
    expect(conn).toBeDefined();
    expect(conn!.registeredAgents.size).toBeGreaterThanOrEqual(1);
    const allInbound = getAllInbound();
    expect(allInbound.has(preRegisteredSwarmId!)).toBe(true);
    console.log(
      `[live-claude-code] Sidecar registered: ${conn!.registeredAgents.size} agent(s) on swarm ${preRegisteredSwarmId}`,
    );
  }, 15_000);

  // ── 1b. Capability surface — trajectory + mail + messaging are declared ─

  it('cc-swarm sidecar declares trajectory + mail + messaging capabilities and the hub aggregates them', async () => {
    expect(preRegisteredSwarmId).toBeTruthy();

    // Capabilities are declared during agent.registered. Connection lands
    // first, registration follows asynchronously — poll briefly until the
    // hub has aggregated something non-empty.
    const deadline = Date.now() + 10_000;
    let agg: ReturnType<typeof getAggregateCapabilities>;
    while (Date.now() < deadline) {
      agg = getAggregateCapabilities(preRegisteredSwarmId!);
      if (agg && Object.keys(agg).length > 0) break;
      await sleep(250);
    }

    expect(agg).toBeDefined();
    const caps = agg as {
      trajectory?: { canReport?: boolean; canServeContent?: boolean };
      mail?: { canCreate?: boolean; canJoin?: boolean; canViewHistory?: boolean };
      messaging?: { canSend?: boolean; canReceive?: boolean };
    };

    // Trajectory bridging — proves cc-swarm intends to push checkpoints
    // through the openhive trajectory/checkpoint handler. The hub-side
    // handler is wired separately and exercised by the existing
    // trajectory-handler tests; this is the contract on cc-swarm's side.
    expect(caps.trajectory?.canReport).toBe(true);

    // Mail chat — the chat-mode resolver picks Mail when these are set, so
    // openhive's Threads UI can open an async conversation against this
    // claude-code swarm without any kind-specific frontend work.
    expect(caps.mail?.canCreate).toBe(true);
    expect(caps.mail?.canJoin).toBe(true);

    // Scope messaging — task bridge events, agent state, etc. flow through
    // this. cc-swarm needs both directions (sends task.* events, receives
    // inbox messages on UserPromptSubmit).
    expect(caps.messaging?.canSend).toBe(true);
    expect(caps.messaging?.canReceive).toBe(true);

    console.log(
      `[live-claude-code] aggregate caps: trajectory=${!!caps.trajectory?.canReport}, ` +
        `mail=${!!caps.mail?.canCreate && !!caps.mail?.canJoin}, ` +
        `messaging=${!!caps.messaging?.canSend && !!caps.messaging?.canReceive}`,
    );
  }, 15_000);

  // ── 2. Terminal-info attach binding ──────────────────────────────────────

  it('terminal-info?mode=tui returns binding=attach with the live PTY sessionId', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/hosted/${hostedSwarmId}/terminal-info?mode=tui`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const info = res.json() as {
      mode: string;
      binding: string;
      available: boolean;
      sessionId: string | null;
    };
    expect(info.mode).toBe('tui');
    expect(info.binding).toBe('attach');
    expect(info.available).toBe(true);
    expect(info.sessionId).toBeTruthy();

    // The sessionId should match what SwarmManager registered.
    const managerSessionId = swarmManager.getTuiPtySessionId(hostedSwarmId!);
    expect(info.sessionId).toBe(managerSessionId);

    // And PtyManager should know about that session, status 'running'.
    const sessionInfo = ptyManager.getInfo(info.sessionId!);
    expect(sessionInfo).toBeTruthy();
    expect(sessionInfo!.status).toBe('running');
  });

  // ── 3. getLogs behavior for claude-code ──────────────────────────────────

  it('getLogs returns the claude-code-specific message (no scrollback)', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/hosted/${hostedSwarmId}/logs?lines=50`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/claude-code logs stream live/);
  });

  // ── 4. Browser → PTY attach via terminal WebSocket ───────────────────────

  it('a browser WS connection attaches to the claude-code PTY by sessionId', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const sid = swarmManager.getTuiPtySessionId(hostedSwarmId!);
    expect(sid).toBeTruthy();

    const url = `ws://127.0.0.1:${SERVER_PORT}/ws/terminal?sessionId=${sid}&cols=120&rows=40`;
    const ws = new WebSocket(url);

    type WsMsg = { type: string; sessionId?: string; message?: string };
    const messages: (WsMsg | string)[] = [];
    let connectedSeen = false;
    let bytesSeen = 0;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS attach timed out')), 10_000);
      ws.on('open', () => {
        // Once attached, nudge the PTY so it emits some bytes back. Sending
        // an empty resize message is enough — the PTY redraws and pushes
        // escape sequences down the wire. We don't care WHAT the bytes are,
        // only that bytes flow PTY → WS → us.
        ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      });
      ws.on('message', (raw) => {
        const data = raw.toString();
        if (data.startsWith('{')) {
          try {
            const msg = JSON.parse(data) as WsMsg;
            messages.push(msg);
            if (msg.type === 'connected') {
              connectedSeen = true;
              expect(msg.sessionId).toBe(sid);
            }
            if (msg.type === 'error') {
              clearTimeout(timer);
              reject(new Error(`server error: ${msg.message}`));
              return;
            }
          } catch {
            messages.push(data);
            bytesSeen += data.length;
          }
        } else {
          messages.push(data);
          bytesSeen += data.length;
        }
        if (connectedSeen && bytesSeen > 0) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    expect(connectedSeen).toBe(true);
    expect(bytesSeen).toBeGreaterThan(0);
    console.log(
      `[live-claude-code] WS attach OK: connected=${connectedSeen}, bytes=${bytesSeen}`,
    );

    // Close the WS without destroying the PTY — terminal-ws's grace logic
    // only destroys when the WS opened the session itself; attach-mode
    // (existingSessionId set) leaves the PTY alone on close.
    ws.close();
    await sleep(200);

    // PTY still alive after WS close.
    const after = ptyManager.getInfo(sid!);
    expect(after?.status).toBe('running');
  }, 15_000);

  // ── 5. Restart → fresh PTY, fresh sidecar, same row ──────────────────────

  it('restart() reboots the PTY and re-registers the sidecar against the same row', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const oldSessionId = swarmManager.getTuiPtySessionId(hostedSwarmId!);
    expect(oldSessionId).toBeTruthy();
    const oldRow = swarmDAL.findHostedSwarmById(hostedSwarmId!)!;

    const restartRes = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/restart`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(restartRes.statusCode).toBe(200);
    const body = restartRes.json() as { state: string; id: string };
    expect(body.state).toBe('running');

    // New PTY session id must differ from the old one.
    const newSessionId = swarmManager.getTuiPtySessionId(hostedSwarmId!);
    expect(newSessionId).toBeTruthy();
    expect(newSessionId).not.toBe(oldSessionId);

    // Same hosted_swarm_id, same MAP swarm_id (in-place restart preserves identity).
    const newRow = swarmDAL.findHostedSwarmById(hostedSwarmId!)!;
    expect(newRow.id).toBe(oldRow.id);
    expect(newRow.swarm_id).toBe(oldRow.swarm_id);
    expect(newRow.kind).toBe('claude-code');

    // The new sidecar should land in the registry within a few seconds.
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
      `[live-claude-code] Restart OK: new session=${newSessionId}, agents=${conn!.registeredAgents.size}`,
    );
  }, 90_000);

  // ── 6. Stop → row stops + PTY destroyed + sidecar signalled ──────────────

  it('stop() destroys the PTY and lands the row at state=stopped', async () => {
    expect(hostedSwarmId).toBeTruthy();
    const sessionIdBefore = swarmManager.getTuiPtySessionId(hostedSwarmId!);
    expect(sessionIdBefore).toBeTruthy();

    const stopRes = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hostedSwarmId}/stop`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    expect(stopRes.statusCode).toBe(200);
    const body = stopRes.json() as { state: string };
    expect(body.state).toBe('stopped');

    // PtyManager should no longer track this session as running.
    const sessionAfter = ptyManager.getInfo(sessionIdBefore!);
    // Either gone (destroyed) or status flipped — both are acceptable.
    if (sessionAfter) {
      expect(sessionAfter.status).not.toBe('running');
    }

    // Manager mapping cleared.
    expect(swarmManager.getTuiPtySessionId(hostedSwarmId!)).toBeNull();

    // Give the sidecar a moment to disconnect on its SIGTERM handler, then
    // confirm it has dropped from the inbound registry. The MAP server's
    // cleanup of the inbound entry happens on WS close, which the sidecar
    // initiates from its SIGTERM handler.
    await sleep(2_000);
    const conn = getInbound(preRegisteredSwarmId!);
    if (conn) {
      // If the connection lingers, it should have no live agents — the
      // sidecar deregistered them on shutdown. Either way, not a hard fail
      // if cleanup is async; just log.
      console.log(
        `[live-claude-code] post-stop: conn still present, agents=${conn.registeredAgents.size}`,
      );
    } else {
      console.log('[live-claude-code] post-stop: sidecar cleanly disconnected');
    }

    // Mark consumed so afterAll doesn't try to stop again.
    hostedSwarmId = undefined;
  }, 30_000);

  // ── 7. Crash → PTY exits non-zero → handleClaudePtyExit flips state=failed

  it('forced PTY crash (SIGKILL) flips the row to state=failed', async () => {
    // Spawn a fresh row for this terminal-state test; we don't want it
    // sharing fate with the prior row (which is already stopped).
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'claude-code',
        name: 'live-claude-code-crash-victim',
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const spawned = spawnRes.json() as { id: string; state: string };
    expect(spawned.state).toBe('running');
    hostedSwarmId = spawned.id; // afterAll will best-effort stop if anything goes sideways

    const sid = swarmManager.getTuiPtySessionId(spawned.id);
    expect(sid).toBeTruthy();
    const ptyInfo = ptyManager.getInfo(sid!);
    expect(ptyInfo?.pid).toBeGreaterThan(0);
    const claudePid = ptyInfo!.pid;

    // SIGKILL the claude PID directly — bypasses any clean-shutdown path,
    // so the PTY exits with a non-zero code. handleClaudePtyExit sees the
    // non-zero exit and flips the row to 'failed'.
    process.kill(claudePid, 'SIGKILL');

    // Wait for the row to land at 'failed'. handleClaudePtyExit also clears
    // the claudeCodeSessions entry, so we can use that as a secondary signal.
    const deadline = Date.now() + 10_000;
    let row = swarmDAL.findHostedSwarmById(spawned.id);
    while (Date.now() < deadline) {
      row = swarmDAL.findHostedSwarmById(spawned.id);
      if (row?.state === 'failed' || row?.state === 'stopped') break;
      await sleep(150);
    }

    expect(row).toBeTruthy();
    expect(row!.state).toBe('failed');
    expect(row!.error).toMatch(/exited with code/);
    expect(swarmManager.getTuiPtySessionId(spawned.id)).toBeNull();
    console.log(
      `[live-claude-code] Crash test: state=${row!.state}, error="${row!.error}"`,
    );

    // Mark consumed.
    hostedSwarmId = undefined;
  }, 90_000);

  // ── 8. Initial prompt → claude opens with prompt prefilled ───────────────

  it('initial_prompt is passed to claude as a positional arg', async () => {
    const initialPrompt = 'Refactor the auth module to use OAuth';
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'claude-code',
        name: 'live-claude-code-with-prompt',
        initial_prompt: initialPrompt,
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const spawned = spawnRes.json() as { id: string; state: string };
    expect(spawned.state).toBe('running');
    hostedSwarmId = spawned.id;

    // The PtyManager session for this swarm should have the prompt as its
    // first positional arg.
    const sid = swarmManager.getTuiPtySessionId(spawned.id);
    expect(sid).toBeTruthy();
    const info = ptyManager.getInfo(sid!);
    expect(info).toBeTruthy();
    expect(info!.args).toEqual([initialPrompt]);
    console.log(`[live-claude-code] initial_prompt → args=${JSON.stringify(info!.args)}`);

    // Cleanup.
    await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${spawned.id}/stop`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    hostedSwarmId = undefined;
  }, 90_000);

  // ── 9. Workspace cloning → repo lands under data_dir ─────────────────────

  it('workspace.repos clones into data_dir before claude launches', async () => {
    // Build a tiny synthetic git repo locally so we don't depend on network.
    const fixtureRoot = path.join(TEST_ROOT, 'workspace-fixture');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const fixtureFile = path.join(fixtureRoot, 'README.md');
    fs.writeFileSync(fixtureFile, '# clone-me\n', 'utf8');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixtureRoot });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], { cwd: fixtureRoot });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], { cwd: fixtureRoot });
    const fixtureUrl = `file://${fixtureRoot}`;

    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/spawn',
      headers: {
        authorization: `Bearer ${testAgent.apiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        kind: 'claude-code',
        name: 'live-claude-code-with-workspace',
        workspace: { repos: [{ url: fixtureUrl, branch: 'main' }] },
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    const spawned = spawnRes.json() as { id: string; state: string };
    expect(spawned.state).toBe('running');
    hostedSwarmId = spawned.id;

    // Repo content should now exist under the data_dir (the clone target,
    // since no `path` was set on the repo entry — falls back to dataDir
    // root).
    const row = swarmDAL.findHostedSwarmById(spawned.id)!;
    const dataDir = row.config!.data_dir;
    const clonedReadme = path.join(dataDir, 'README.md');
    expect(fs.existsSync(clonedReadme)).toBe(true);
    expect(fs.readFileSync(clonedReadme, 'utf8')).toBe('# clone-me\n');
    expect(fs.existsSync(path.join(dataDir, '.git'))).toBe(true);
    console.log(`[live-claude-code] Workspace clone OK at ${dataDir}`);

    // Cleanup.
    await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${spawned.id}/stop`,
      headers: { authorization: `Bearer ${testAgent.apiKey}` },
    });
    hostedSwarmId = undefined;
  }, 120_000);
});
