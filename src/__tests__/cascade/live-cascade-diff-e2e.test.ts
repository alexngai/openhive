/**
 * Live Cascade Diff E2E.
 *
 * Boots the FULL openhive stack a UI client would touch — real Fastify,
 * real `setupMapWebSocket` route at `/ws/map`, real cascade routes, real
 * SQLite, real WebSocket transport, real `git` shelling out from a sidecar
 * simulator — and verifies the cascade-diff chain end-to-end:
 *
 *   HTTP GET → resolver tier 1 (cache miss)
 *            → tier 2 (presence + capability gate)
 *            → tier 3 cascade/diff.request notification over real WS
 *            → sidecar simulator handles, shells out to real git
 *            → cascade/diff.response notification over real WS
 *            → handleDiffResponse resolves pending request
 *            → write-through cache
 *            → HTTP 200 with payload
 *
 * Second call short-circuits at tier 1 (cache hit), no WS roundtrip.
 *
 * What this proves vs the in-process e2e:
 *   - Real fastify + `setupMapWebSocket` accept a WS connection on /ws/map
 *   - Real `ws-map.ts` notification interceptor dispatches inbound
 *     cascade/diff.response messages to the protocol module
 *   - Real bytes cross a real socket; no in-process bridge stubbed in
 *
 * Known shortcut: the sidecar simulator mutates its inbound `conn` object
 * to declare `cascade.canServeDiff: true` directly (rather than going
 * through `map/agents/register`). This isolates the diff-chain wiring
 * from the MAP SDK's registration schema, which is exhaustively covered
 * elsewhere. The capability *check* (`hasCapability`) runs the full
 * production code path against the live registry.
 *
 * Env gate: REQUIRES `LIVE_AGENT_E2E=true` per the
 * src/__tests__/swarm/live-*-e2e.test.ts convention. Default runs skip.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { setupWebSocket } from '../../realtime/index.js';
import { cascadeRoutes } from '../../api/routes/cascade.js';
import { upsertStream } from '../../db/dal/cascade-streams.js';
import * as diffCache from '../../db/dal/cascade-diff-cache.js';
import {
  getInbound,
  type MapInboundConnection,
} from '../../map/connection-registry.js';
import {
  installAsResolverFetcher,
  __resetPendingForTests,
} from '../../map/cascade-diff-protocol.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const LIVE = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE ? describe : describe.skip;

const TEST_ROOT = testRoot('live-cascade-diff-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-cascade-diff.db');
const SERVER_PORT = 20055;
// Per-test SWARM_ID + streamRowId to sidestep the inbound-registry
// stale-grace window between test runs.
let nextSwarmCounter = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shell(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString('utf-8')
    .trim();
}

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: {
      name: 'live cascade diff e2e',
      description: 'live test',
      url: `http://127.0.0.1:${SERVER_PORT}`,
    },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    mapHub: { enabled: true, trustModel: 'open', iamSecret: 'live-cascade-diff-secret' },
  });
}

describeIf('Live Cascade Diff E2E', () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };
  let tempRepo: string;
  let commitB: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    originalHome = process.env.OPENHIVE_HOME;
    process.env.OPENHIVE_HOME = TEST_ROOT;

    initDatabase(TEST_DB_PATH);
    const config = createTestConfig();
    initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

    const agentResult = await agentsDAL.createAgent({
      name: 'live-cascade-diff-owner',
      description: 'Owner for live cascade-diff e2e',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    setLocalAgent(agentResult.agent);

    // Wire the protocol module's fetcher into the resolver — production
    // server.ts does the same at boot.
    installAsResolverFetcher();

    // Build a real git temp repo the sidecar simulator will diff against.
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'live-cascade-diff-repo-'));
    shell('git init -q', tempRepo);
    shell('git config user.email "t@t.com"', tempRepo);
    shell('git config user.name "T"', tempRepo);
    shell('git config commit.gpgsign false', tempRepo);
    fs.writeFileSync(path.join(tempRepo, 'hello.txt'), 'hello\n');
    shell('git add .', tempRepo);
    shell('git commit -q -m initial', tempRepo);
    fs.writeFileSync(path.join(tempRepo, 'hello.txt'), 'hello\nworld\n');
    shell('git add .', tempRepo);
    shell('git commit -q -m second', tempRepo);
    commitB = shell('git rev-parse HEAD', tempRepo);

    // Boot fastify with the full route surface.
    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(fastifyWebsocket);
    setupMapWebSocket(app, config);
    setupWebSocket(app);
    await app.register(
      async (api) => { await api.register(cascadeRoutes); },
      { prefix: '/api/v1' },
    );
    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 30_000);

  afterAll(async () => {
    stopMapWebSocket();
    if (app) await app.close();
    setLocalAgent(null);
    _resetTokenService();
    closeDatabase();
    if (tempRepo && fs.existsSync(tempRepo)) {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  }, 30_000);

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM cascade_diff_cache').run();
    __resetPendingForTests();
  });

  afterEach(async () => {
    // Stale-grace period on the inbound registry keeps the prior swarm
    // metadata around for 30s after disconnect, which can confuse the
    // next test's reconnect. Wait long enough for the server-side close
    // event to land + connection-registry to mark stale.
    await sleep(100);
  });

  /**
   * Open a real WS connection to /ws/map and stand up the sidecar
   * simulator. Returns the live socket plus a cleanup. The simulator
   * shells out to real git on incoming diff requests.
   */
  async function startSidecarSimulator(swarmId: string): Promise<{
    ws: WebSocket;
    close: () => Promise<void>;
    requestCount: () => number;
  }> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?swarm_id=${swarmId}`,
    );

    // Attach the welcome listener IMMEDIATELY — before we await open —
    // so we don't race the hub sending hub/welcome right after
    // registerInbound. (Empirically, the first test's WS handshake is
    // slow enough to mask this race, but subsequent connections lose it.)
    const welcomeReceived = new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('hub/welcome timeout')),
        5000,
      );
      const onMsg = (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.method === 'hub/welcome') {
            clearTimeout(t);
            ws.off('message', onMsg);
            resolve();
          }
        } catch { /* non-JSON */ }
      };
      ws.on('message', onMsg);
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 5000);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });

    await welcomeReceived;
    // Give the hub a tick to finish registerInbound.
    await sleep(50);

    // Shortcut: mutate the connection-registry entry to declare the
    // capability. Production sidecars do this via map/agents/register;
    // the MAP SDK's register flow is covered by other tests. Here we
    // isolate the diff-chain wiring.
    const conn = getInbound(swarmId) as MapInboundConnection | undefined;
    if (!conn) throw new Error('inbound connection not registered');
    conn.capabilities = {
      ...(conn.capabilities ?? {}),
      cascade: { canServeDiff: true },
    };

    let requestCount = 0;

    // Sidecar's job: handle cascade/diff.request notifications by shelling
    // out to git and writing cascade/diff.response back over the same WS.
    ws.on('message', (raw) => {
      let msg: { method?: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.method !== 'cascade/diff.request') return;
      requestCount++;
      const p = msg.params as {
        request_id: string;
        head: string;
        base?: string;
        files_only?: boolean;
      };

      try {
        const args = p.base
          ? ['diff', '--no-textconv', '-U3', `${p.base}..${p.head}`, '--']
          : ['show', '--no-textconv', '-U3', '--format=', p.head, '--'];
        if (p.files_only) args.splice(1, 0, '--name-only');
        const out = execSync(`git ${args.join(' ')}`, { cwd: tempRepo, stdio: ['ignore', 'pipe', 'pipe'] });
        const files = Array.from(
          new Set(
            Array.from(
              out.toString('utf-8').matchAll(/^diff --git a\/.+? b\/(.+?)$/gm),
              (m) => m[1],
            ),
          ),
        );
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'cascade/diff.response',
          params: {
            request_id: p.request_id,
            streaming: false,
            diff: out.toString('utf-8'),
            files_touched: p.files_only ? out.toString('utf-8').split('\n').filter(Boolean) : files,
            truncated: false,
          },
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'cascade/diff.response',
          params: {
            request_id: p.request_id,
            error: {
              code: 'internal',
              message: (err as Error).message,
            },
          },
        }));
      }
    });

    return {
      ws,
      close: async () => {
        if (ws.readyState === WebSocket.CLOSED) return;
        const closed = new Promise<void>((r) => ws.once('close', () => r()));
        try { ws.close(); } catch { /* noop */ }
        await Promise.race([closed, sleep(500)]);
      },
      requestCount: () => requestCount,
    };
  }

  async function httpGetDiff(streamRowId: string, commitHash: string, query = ''): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    const url = `http://127.0.0.1:${SERVER_PORT}/api/v1/cascade/streams/${streamRowId}/commits/${commitHash}/diff${query}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${testAgent.apiKey}` },
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  /**
   * Helper: spin up a fresh swarm + stream + sidecar for each test so
   * the connection-registry stale-grace window doesn't cross-contaminate.
   */
  async function freshFixture(): Promise<{
    swarmId: string;
    streamRowId: string;
    cascadeStreamId: string;
    sidecar: Awaited<ReturnType<typeof startSidecarSimulator>>;
  }> {
    const n = ++nextSwarmCounter;
    const swarmId = `live-cascade-swarm-${n}`;
    const cascadeStreamId = `live-cascade-stream-${n}`;
    const { stream } = upsertStream({
      stream_id: cascadeStreamId,
      source_swarm_id: swarmId,
      source_agent_id: testAgent.id,
      name: `live-cascade-${n}`,
    });
    const sidecar = await startSidecarSimulator(swarmId);
    return { swarmId, streamRowId: stream.id, cascadeStreamId, sidecar };
  }

  it('HTTP GET → WS roundtrip → real git → cache → HTTP 200 with diff payload', async () => {
    const fx = await freshFixture();
    try {
      const res = await httpGetDiff(fx.streamRowId, commitB);

      expect(res.status).toBe(200);
      const data = res.body.data as {
        diff: string;
        files_touched: string[];
        truncated: boolean;
      };
      expect(data.diff).toContain('diff --git a/hello.txt');
      expect(data.diff).toContain('+world');
      expect(data.files_touched).toEqual(['hello.txt']);
      expect(data.truncated).toBe(false);

      expect(fx.sidecar.requestCount()).toBe(1);
      expect(diffCache.countDiffsForStream(fx.cascadeStreamId)).toBe(1);

      // Second call hits cache.
      const res2 = await httpGetDiff(fx.streamRowId, commitB);
      expect(res2.status).toBe(200);
      expect(fx.sidecar.requestCount()).toBe(1);
    } finally {
      await fx.sidecar.close();
    }
  }, 20_000);

  it('files_only query reaches sidecar and is not cached (D17)', async () => {
    const fx = await freshFixture();
    try {
      const res = await httpGetDiff(fx.streamRowId, commitB, '?files_only=true');
      expect(res.status).toBe(200);
      const data = res.body.data as { diff: string; files_touched: string[] };
      expect(data.files_touched).toContain('hello.txt');
      expect(diffCache.countDiffsForStream(fx.cascadeStreamId)).toBe(0);
      expect(fx.sidecar.requestCount()).toBe(1);
    } finally {
      await fx.sidecar.close();
    }
  }, 20_000);

  it('sidecar returns error → HTTP 500 with typed code', async () => {
    const fx = await freshFixture();
    try {
      const res = await httpGetDiff(fx.streamRowId, '0'.repeat(40));
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal');
      expect(fx.sidecar.requestCount()).toBe(1);
      expect(diffCache.countDiffsForStream(fx.cascadeStreamId)).toBe(0);
    } finally {
      await fx.sidecar.close();
    }
  }, 20_000);
});
