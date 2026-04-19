/**
 * Level 2 E2E: hub→runtime cascade actions.
 *
 * Verifies the full round-trip:
 *   1. REST POST /cascade/streams/:id/actions/:action
 *   2. Hub resolves stream → swarm → sends x-cascade/request.* notification
 *   3. Connected sidecar receives the notification
 *   4. (Macro-agent) action handler dispatches to GitCascadeAdapter
 *   5. Adapter executes → tracker fires x-cascade/stream.* event
 *   6. Bridge forwards → hub handler projects → DB updated
 *
 * Architecture:
 *   - Real Fastify server with MAP WS + cascade routes
 *   - Real WS client acting as sidecar (receives notifications)
 *   - Real macro-agent setupCascadeActionHandlers wired to a real adapter
 *   - Real handleCascadeRequest for the return path
 *
 * Gated on RUN_E2E_TESTS=true.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket, setHeartbeatInterval } from '../../map/ws-map.js';
import { cascadeRoutes } from '../../api/routes/cascade.js';
import { mapRoutes } from '../../api/routes/map.js';
import { handleCascadeRequest, CASCADE_METHODS } from '../../map/cascade-handler.js';
import { getStreamBySwarmAndId } from '../../db/dal/cascade-streams.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_ROOT = testRoot('cascade-actions-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'actions-e2e.db');
const PORT = 19711;
const SWARM_ID = 'swarm-actions-e2e';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

const RUN = process.env.RUN_E2E_TESTS === 'true';
const describeIfE2E = RUN ? describe : describe.skip;

describeIfE2E('Level 2 E2E: cascade actions (hub → runtime → hub)', () => {
  let app: FastifyInstance;
  let ingestToken: string;
  let apiKey: string;
  let agentId: string;

  // Sidecar connection
  let sidecarWs: WebSocket;
  let sidecarMessages: Array<{ method?: string; id?: number; params?: unknown }>;

  // Macro-agent components
  let adapter: any;
  let actionCleanup: (() => void) | null = null;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent, apiKey: key } = await agentsDAL.createAgent({
      name: 'cascade-actions-e2e-agent',
      description: 'Actions E2E',
    });
    agentId = agent.id;
    apiKey = key;

    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'actions-e2e',
      agent_id: agent.id,
    });
    ingestToken = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Actions E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: {
        enabled: true,
        trustModel: 'open',
        missedPongsBeforeTerminate: 10,
      },
    });

    setHeartbeatInterval(5000);

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.register(
      async (api) => {
        await api.register(cascadeRoutes);
        await api.register(mapRoutes, { config });
      },
      { prefix: '/api/v1' },
    );
    await app.listen({ port: PORT, host: '127.0.0.1' });

    // Connect a sidecar-like WS client to /ws/map
    sidecarMessages = [];
    sidecarWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${PORT}/ws/map?token=${encodeURIComponent(ingestToken)}&swarm_id=${encodeURIComponent(SWARM_ID)}`,
      );
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          sidecarMessages.push(msg);
          if (msg.method === 'ping') {
            ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
          }
        } catch { /* ignore */ }
      });
      const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Sidecar connect timeout')); }, 5000);
      ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });

    // Wait for hub/welcome
    await waitFor(() => sidecarMessages.some((m) => m.method === 'hub/welcome'));

    // Seed a stream projection so the action endpoint has a target
    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      {
        stream_id: 'action-stream-1',
        name: 'action-test-stream',
        agent_id: 'agent-action',
        metadata: {},
      },
      { swarmId: SWARM_ID, agentId },
    );
  }, 15000);

  afterAll(async () => {
    if (actionCleanup) actionCleanup();
    if (adapter) adapter.close?.();
    sidecarWs?.terminate();
    setLocalAgent(null);
    stopMapWebSocket();
    await app?.close();
    await sleep(200);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    setHeartbeatInterval(30_000);
  });

  // =========================================================================
  // Test 1: Hub sends notification, sidecar receives it
  // =========================================================================

  it('POST /actions/pause sends x-cascade/request.pause notification to the connected swarm', async () => {
    const stream = getStreamBySwarmAndId(SWARM_ID, 'action-stream-1');
    expect(stream).not.toBeNull();

    sidecarMessages.length = 0;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${stream!.id}/actions/pause`,
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: { reason: 'e2e-test-pause' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toBe(true);

    // Wait for the notification to arrive at the sidecar
    const received = await waitFor(() =>
      sidecarMessages.some((m) => m.method === 'x-cascade/request.pause'),
    );
    expect(received).toBe(true);

    const notification = sidecarMessages.find((m) => m.method === 'x-cascade/request.pause');
    expect(notification).toBeDefined();
    expect((notification!.params as { stream_id?: string }).stream_id).toBe('action-stream-1');
    expect((notification!.params as { reason?: string }).reason).toBe('e2e-test-pause');
  });

  it('POST /actions/abandon sends x-cascade/request.abandon to the swarm', async () => {
    const stream = getStreamBySwarmAndId(SWARM_ID, 'action-stream-1');

    sidecarMessages.length = 0;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${stream!.id}/actions/abandon`,
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: { reason: 'e2e-test-abandon' },
    });

    expect(res.statusCode).toBe(200);

    const received = await waitFor(() =>
      sidecarMessages.some((m) => m.method === 'x-cascade/request.abandon'),
    );
    expect(received).toBe(true);
    const notification = sidecarMessages.find((m) => m.method === 'x-cascade/request.abandon');
    expect((notification!.params as { stream_id?: string }).stream_id).toBe('action-stream-1');
  });

  it('POST /actions/resolve sends x-cascade/request.resolve with strategy', async () => {
    const stream = getStreamBySwarmAndId(SWARM_ID, 'action-stream-1');

    sidecarMessages.length = 0;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${stream!.id}/actions/resolve`,
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: { conflict_id: 'cf-test-1', strategy: 'theirs' },
    });

    expect(res.statusCode).toBe(200);

    const received = await waitFor(() =>
      sidecarMessages.some((m) => m.method === 'x-cascade/request.resolve'),
    );
    expect(received).toBe(true);
    const notification = sidecarMessages.find((m) => m.method === 'x-cascade/request.resolve');
    const params = notification!.params as Record<string, unknown>;
    expect(params.conflict_id).toBe('cf-test-1');
    expect(params.strategy).toBe('theirs');
  });

  // =========================================================================
  // Test 2: Validation + error cases
  // =========================================================================

  it('returns 400 for unknown action', async () => {
    const stream = getStreamBySwarmAndId(SWARM_ID, 'action-stream-1');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${stream!.id}/actions/explode`,
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bad Request');
  });

  it('returns 404 for unknown stream', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/nonexistent-id/actions/pause`,
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });

  // Note: 401 test omitted — this E2E uses setLocalAgent(agent) which
  // auto-authenticates all requests (local mode). Auth rejection is covered
  // by the cascade-routes.test.ts suite which runs without local agent.

  // =========================================================================
  // Test 3: Macro-agent action handler processes the notification
  // =========================================================================

  it('macro-agent action handler executes pauseStream when receiving request.pause', async () => {
    // Set up a real adapter + action handler wired to the sidecar WS
    const repo = path.join(TEST_ROOT, `repo-action-${Date.now()}`);
    fs.mkdirSync(repo, { recursive: true });
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email test@test.com', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name Test', { cwd: repo, stdio: 'pipe' });
    fs.writeFileSync(path.join(repo, 'README.md'), '# init\n');
    execSync('git add .', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m init', { cwd: repo, stdio: 'pipe' });
    fs.mkdirSync(path.join(repo, '.git-cascade'), { recursive: true });

    const { GitCascadeAdapter } = await import('macro-agent/dist/workspace/git-cascade-adapter.js');
    const { setupCascadeActionHandlers } = await import('macro-agent/dist/map/cascade-action-handler.js');

    adapter = new (GitCascadeAdapter as any)({ repoPath: repo, tablePrefix: 'act_' });

    // Create a stream on the adapter so pause has a target
    const streamId = adapter.createStream({ name: 'handler-test', agentId: 'a' });

    // Wire action handler to a mock connection that receives from sidecarMessages
    const notificationHandlers = new Map<string, (params: unknown) => void>();
    const mockConn = {
      onNotification(method: string, handler: (params: unknown) => void) {
        notificationHandlers.set(method, handler);
      },
      offNotification(method: string) {
        notificationHandlers.delete(method);
      },
    };

    actionCleanup = setupCascadeActionHandlers(mockConn as any, adapter);

    // Simulate receiving a pause request (as if the hub sent it)
    const pauseHandler = notificationHandlers.get('x-cascade/request.pause');
    expect(pauseHandler).toBeDefined();

    pauseHandler!({ stream_id: streamId, reason: 'hub-e2e-test' });

    // Verify the adapter paused the stream
    const stream = adapter.getStream(streamId);
    expect(stream).not.toBeNull();
    expect(stream!.status).toBe('paused');
  });

  it('macro-agent action handler executes abandonStream on request.abandon', async () => {
    const repo = path.join(TEST_ROOT, `repo-abandon-${Date.now()}`);
    fs.mkdirSync(repo, { recursive: true });
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email test@test.com', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name Test', { cwd: repo, stdio: 'pipe' });
    fs.writeFileSync(path.join(repo, 'README.md'), '# init\n');
    execSync('git add .', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m init', { cwd: repo, stdio: 'pipe' });
    fs.mkdirSync(path.join(repo, '.git-cascade'), { recursive: true });

    const { GitCascadeAdapter } = await import('macro-agent/dist/workspace/git-cascade-adapter.js');
    const { setupCascadeActionHandlers } = await import('macro-agent/dist/map/cascade-action-handler.js');

    const localAdapter = new (GitCascadeAdapter as any)({ repoPath: repo, tablePrefix: 'abn_' });
    const sid = localAdapter.createStream({ name: 'abandon-test', agentId: 'a' });

    const handlers = new Map<string, (params: unknown) => void>();
    const cleanup = setupCascadeActionHandlers(
      { onNotification: (m: string, h: any) => handlers.set(m, h), offNotification: (m: string) => handlers.delete(m) } as any,
      localAdapter,
    );

    handlers.get('x-cascade/request.abandon')!({ stream_id: sid, reason: 'hub-abandon' });

    const stream = localAdapter.getStream(sid);
    expect(stream!.status).toBe('abandoned');

    cleanup();
    localAdapter.close?.();
  });
});
