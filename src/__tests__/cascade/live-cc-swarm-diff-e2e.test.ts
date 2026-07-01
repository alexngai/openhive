/**
 * E2E: real cc-swarm diff server against a real openhive hub.
 *
 * Mirrors `live-cascade-diff-sidecar-e2e.test.ts` but exercises cc-swarm's
 * own `cascade-diff-server.mjs` (under references/claude-code-swarm/src/)
 * instead of macro-agent's. cc-swarm runs git-cascade in local mode with no
 * worktrees — the diff is resolved purely from commit hashes against the
 * single repo cwd.
 *
 * What's exercised live:
 *   1. real `setupMapWebSocket` + cascade routes + real chunk reassembly
 *   2. real `AgentConnection` declaring `cascade.canServeDiff: true`
 *   3. real `openCascadeTracker` + `setupCascadeDiffServer(conn, { repoPath, tracker })`
 *   4. inline (≤ 512 KB) and streamed-chunked (> 512 KB) responses on the
 *      same `cascade/diff.request` wire path, both reaching the HTTP layer
 *
 * Env gate: LIVE_AGENT_E2E=true. Skipped otherwise to keep CI fast.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { AgentConnection } from '@multi-agent-protocol/sdk';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import {
  setupMapWebSocket,
  stopMapWebSocket,
} from '../../map/ws-map.js';
import { setupWebSocket } from '../../realtime/index.js';
import { cascadeRoutes } from '../../api/routes/cascade.js';
import { upsertStream } from '../../db/dal/cascade-streams.js';
import {
  installAsResolverFetcher,
  __resetPendingForTests,
} from '../../map/cascade-diff-protocol.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../realtime/index.js')>(
    '../../realtime/index.js',
  );
  return {
    ...actual,
    broadcastToChannel: vi.fn(),
  };
});

const LIVE = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE ? describe : describe.skip;

const TEST_ROOT = testRoot('live-cc-swarm-diff');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-cc-swarm-diff.db');
const PORT = 20088;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shell(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString('utf-8')
    .trim();
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

describeIf('Live cc-swarm Cascade Diff — real diff server wire-up', () => {
  let app: FastifyInstance;
  let apiKey: string;
  let tempRepo: string;
  let trackerDbPath: string;
  let commitInline: string; // small diff, ≤ 512 KB
  let commitBig: string;    // large diff, > 512 KB
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let openCascadeTracker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let closeCascadeTracker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setupCascadeDiffServer: any;

  const activeConns: AgentConnection[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'cc-swarm-diff-e2e-owner',
      description: 'Owner agent for cc-swarm diff e2e',
    });
    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'cc-swarm-diff-e2e',
      agent_id: agent.id,
    });
    apiKey = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'cc-swarm Diff E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open', missedPongsBeforeTerminate: 3 },
    });

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setupMapWebSocket(app, config);
    setupWebSocket(app);
    await app.register(
      async (api) => { await api.register(cascadeRoutes); },
      { prefix: '/api/v1' },
    );
    await app.listen({ port: PORT, host: '127.0.0.1' });

    // Wire the resolver-fetcher exactly as server.ts does at boot.
    installAsResolverFetcher();

    // Real git temp repo. Two distinguished commits:
    //   - inline: small diff (a single short line)
    //   - big:    diff body > 512 KB so the server is forced down the
    //            streaming-chunk path. cc-swarm's INLINE_THRESHOLD_BYTES is
    //            512 KB; we overshoot generously to keep tests robust to
    //            diff-format overhead.
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-swarm-diff-e2e-'));
    shell('git init -q', tempRepo);
    shell('git config user.email "t@t.com"', tempRepo);
    shell('git config user.name "T"', tempRepo);
    shell('git config commit.gpgsign false', tempRepo);
    fs.writeFileSync(path.join(tempRepo, 'README.md'), '# initial\n');
    shell('git add .', tempRepo);
    shell('git commit -q -m initial', tempRepo);

    fs.writeFileSync(path.join(tempRepo, 'feature.txt'), 'small inline diff\n');
    shell('git add .', tempRepo);
    shell('git commit -q -m "feat: tiny addition"', tempRepo);
    commitInline = shell('git rev-parse HEAD', tempRepo);

    // ~700 KB of repeating content → comfortably above the 512 KB inline
    // threshold even after diff-format overhead.
    const bigBody =
      'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod\n'.repeat(
        10_000,
      );
    fs.writeFileSync(path.join(tempRepo, 'big.txt'), bigBody);
    shell('git add .', tempRepo);
    shell('git commit -q -m "feat: add big payload"', tempRepo);
    commitBig = shell('git rev-parse HEAD', tempRepo);

    trackerDbPath = path.join(TEST_ROOT, 'cascade-tracker.db');

    // Dynamic-import cc-swarm `.mjs` modules — outside tsc's rootDir.
    const clientPath = '../../../references/claude-code-swarm/src/cascade-client.mjs';
    const diffServerPath = '../../../references/claude-code-swarm/src/cascade-diff-server.mjs';
    const clientMod = await import(/* @vite-ignore */ clientPath);
    const diffMod = await import(/* @vite-ignore */ diffServerPath);
    openCascadeTracker = clientMod.openCascadeTracker;
    closeCascadeTracker = clientMod.closeCascadeTracker;
    setupCascadeDiffServer = diffMod.setupCascadeDiffServer;
  }, 30_000);

  afterAll(async () => {
    for (const c of activeConns) {
      try { await c.disconnect(); } catch { /* ignore */ }
    }
    activeConns.length = 0;
    stopMapWebSocket();
    if (app) await app.close();
    setLocalAgent(null);
    await sleep(200);
    closeDatabase();
    if (tempRepo && fs.existsSync(tempRepo)) {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
    cleanTestRoot(TEST_ROOT);
  }, 30_000);

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM cascade_diff_cache').run();
    __resetPendingForTests();
  });

  /**
   * Spin up a real cc-swarm diff-server wire-up:
   *   - real AgentConnection with cc-swarm cascade capability shape
   *   - real openCascadeTracker on the temp repo
   *   - real setupCascadeDiffServer(connection, { repoPath, tracker })
   *
   * Returns the swarmId + stream row id so the caller can drive HTTP.
   */
  async function startSidecar(): Promise<{
    swarmId: string;
    streamRowId: string;
    cascadeStreamId: string;
    cleanup: () => Promise<void>;
  }> {
    const swarmId = `live-cc-swarm-diff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const cascadeStreamId = `${swarmId}-stream-1`;

    const conn = await AgentConnection.connect(
      `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`,
      {
        name: `cc-swarm-sidecar-${swarmId}`,
        role: 'sidecar',
        auth: { method: 'none' as const },
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          // cc-swarm observe-only cascade capability shape.
          cascade: {
            canServeDiff: true,
            canAct: false,
            emitsConflicts: false,
          },
        },
      } as Parameters<typeof AgentConnection.connect>[1],
    );
    activeConns.push(conn);

    const { getInbound, hasCapability } = await import(
      '../../map/connection-registry.js'
    );
    const ready = await waitFor(
      () =>
        getInbound(swarmId) !== undefined &&
        hasCapability(swarmId, 'cascade.canServeDiff'),
      5000,
    );
    if (!ready) {
      throw new Error('cc-swarm sidecar did not register cascade.canServeDiff in time');
    }

    // Open the cc-swarm tracker (used only for stream-name validation
    // inside the diff server — the diff itself runs straight against git).
    const tracker = await openCascadeTracker({
      repoPath: tempRepo,
      dbPath: trackerDbPath,
    });

    const diffCleanup = setupCascadeDiffServer(conn, {
      repoPath: tempRepo,
      tracker,
    });

    // Seed the cascade_streams projection so the resolver can look it up.
    const { stream } = upsertStream({
      stream_id: cascadeStreamId,
      source_swarm_id: swarmId,
      source_agent_id: 'cc-swarm-sidecar-agent',
      name: 'live-cc-swarm-sidecar',
    });

    return {
      swarmId,
      streamRowId: stream.id,
      cascadeStreamId,
      cleanup: async () => {
        try { diffCleanup(); } catch { /* ignore */ }
        try { closeCascadeTracker(tracker); } catch { /* ignore */ }
        try { await conn.disconnect(); } catch { /* ignore */ }
        const idx = activeConns.indexOf(conn);
        if (idx >= 0) activeConns.splice(idx, 1);
      },
    };
  }

  async function httpGetDiff(
    streamRowId: string,
    commitHash: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = `http://127.0.0.1:${PORT}/api/v1/cascade/streams/${streamRowId}/commits/${commitHash}/diff`;
    const res = await fetch(url);
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  }

  it('inline (small diff): HTTP → MAP → cc-swarm git → HTTP 200 with payload', async () => {
    const fx = await startSidecar();
    try {
      const res = await httpGetDiff(fx.streamRowId, commitInline);
      expect(res.status).toBe(200);
      const data = res.body.data as {
        diff: string;
        files_touched: string[];
        truncated: boolean;
      };
      expect(data.diff).toContain('diff --git a/feature.txt');
      expect(data.diff).toContain('+small inline diff');
      expect(data.files_touched).toEqual(['feature.txt']);
      expect(data.truncated).toBe(false);
    } finally {
      await fx.cleanup();
    }
  }, 30_000);

  it('chunked streaming (> 512 KB): cc-swarm streams + hub reassembles + sha256-verifies', async () => {
    const fx = await startSidecar();
    try {
      const res = await httpGetDiff(fx.streamRowId, commitBig);
      expect(res.status).toBe(200);

      const data = res.body.data as {
        diff: string;
        files_touched: string[];
        truncated: boolean;
      };

      // Above 512 KB the cc-swarm server emits N chunks. The blob the
      // hub returns here is only correct if every chunk crossed real WS
      // frames in order AND the sha256 over the assembled blob matched.
      expect(data.diff.length).toBeGreaterThan(512 * 1024);
      expect(data.diff).toContain('diff --git a/big.txt');
      expect(data.diff).toContain('+lorem ipsum dolor sit amet');
      expect(data.files_touched).toContain('big.txt');
      expect(data.truncated).toBe(false);
    } finally {
      await fx.cleanup();
    }
  }, 60_000);
});
