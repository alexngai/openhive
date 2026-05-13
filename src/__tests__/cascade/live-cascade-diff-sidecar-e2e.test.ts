/**
 * E2E: real macro-agent sidecar wiring against a real openhive hub.
 *
 * Closes the gap between S1.23's in-process bridge (which manually
 * constructed WS JSON-RPC notifications) and the real production wire-up.
 *
 * What's exercised live:
 *   1. real `setupMapWebSocket` accepting a /ws/map connection
 *   2. real `@multi-agent-protocol/sdk` AgentConnection performing the
 *      MAP handshake + capability registration with
 *      `cascade: { canServeDiff: true }`
 *   3. real `setupCascadeDiffServer` from references/macro-agent — the
 *      same module a production sidecar wires up
 *   4. real `createGitCascadeAdapter` pointed at a temp git repo
 *   5. real HTTP GET against the hub's diff endpoint
 *   6. hub resolver → MAP wire → sidecar → real git → real diff blob
 *      → hub cache write-through → HTTP 200 with payload
 *
 * Mirrors the pattern in `src/__tests__/integration/repo-sidecar-e2e.test.ts`
 * which does the same for the repo-declare flow.
 *
 * Env gate: LIVE_AGENT_E2E=true. Skipped by default to keep the suite fast.
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
import * as diffCache from '../../db/dal/cascade-diff-cache.js';
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

const TEST_ROOT = testRoot('live-cascade-diff-sidecar');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-cascade-diff-sidecar.db');
const PORT = 20066;

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

describeIf('Live Cascade Diff — real sidecar wire-up', () => {
  let app: FastifyInstance;
  let apiKey: string;
  let tempRepo: string;
  let commitA: string;
  let commitB: string;
  let commitBigC: string;
  // Lazy-loaded macro-agent deps so tsc rootDir doesn't follow them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setupCascadeDiffServer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createGitCascadeAdapter: any;

  // Track active connections so afterAll can disconnect cleanly.
  const activeConns: AgentConnection[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'diff-sidecar-e2e-owner',
      description: 'Owner agent for diff-sidecar e2e',
    });
    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'diff-sidecar-e2e',
      agent_id: agent.id,
    });
    apiKey = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Diff Sidecar E2E' },
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

    // Real git temp repo.
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-sidecar-e2e-'));
    shell('git init -q', tempRepo);
    shell('git config user.email "t@t.com"', tempRepo);
    shell('git config user.name "T"', tempRepo);
    shell('git config commit.gpgsign false', tempRepo);
    fs.writeFileSync(path.join(tempRepo, 'README.md'), '# initial\n');
    shell('git add .', tempRepo);
    shell('git commit -q -m initial', tempRepo);
    commitA = shell('git rev-parse HEAD', tempRepo);
    fs.writeFileSync(path.join(tempRepo, 'README.md'), '# initial\n## new section\n');
    fs.writeFileSync(path.join(tempRepo, 'feature.txt'), 'feature content\n');
    shell('git add .', tempRepo);
    shell('git commit -q -m "feat: add section"', tempRepo);
    commitB = shell('git rev-parse HEAD', tempRepo);

    // Big commit for the chunked-streaming case. ~700 KB diff body —
    // well above the 512 KB inline threshold, so the sidecar must emit a
    // streaming response with N chunks, and the hub must reassemble +
    // sha256-verify across real WS frames.
    const bigBody =
      'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod\n'.repeat(
        10_000,
      );
    fs.writeFileSync(path.join(tempRepo, 'big.txt'), bigBody);
    shell('git add .', tempRepo);
    shell('git commit -q -m "feat: add big payload"', tempRepo);
    commitBigC = shell('git rev-parse HEAD', tempRepo);

    // Lazy-load macro-agent built modules. References path bypasses
    // tsc rootDir (matches diff-chain-e2e.test.ts approach).
    const serverPath = '../../../references/macro-agent/dist/map/cascade-diff-server.js';
    const adapterPath = '../../../references/macro-agent/dist/workspace/git-cascade-adapter.js';
    const serverMod = await import(/* @vite-ignore */ serverPath);
    const adapterMod = await import(/* @vite-ignore */ adapterPath);
    setupCascadeDiffServer = serverMod.setupCascadeDiffServer;
    createGitCascadeAdapter = adapterMod.createGitCascadeAdapter;
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
   * Spin up a real sidecar wire-up:
   *   - real AgentConnection.connect with cascade.canServeDiff cap
   *   - real createGitCascadeAdapter on the temp repo
   *   - real setupCascadeDiffServer binding the cascade/diff.request handler
   *
   * Returns the swarmId + stream row id so the caller can drive HTTP.
   */
  async function startSidecar(): Promise<{
    swarmId: string;
    streamRowId: string;
    cascadeStreamId: string;
    cleanup: () => Promise<void>;
  }> {
    const swarmId = `live-diff-sidecar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const cascadeStreamId = `${swarmId}-stream-1`;

    const conn = await AgentConnection.connect(
      `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`,
      {
        name: `macro-agent-sidecar-${swarmId}`,
        role: 'sidecar',
        auth: { method: 'none' as const },
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          cascade: { canServeDiff: true },
        },
      } as Parameters<typeof AgentConnection.connect>[1],
    );
    activeConns.push(conn);

    // Wait for inbound registration to settle on the hub side.
    const { getInbound, hasCapability } = await import(
      '../../map/connection-registry.js'
    );
    const ready = await waitFor(
      () => getInbound(swarmId) !== undefined && hasCapability(swarmId, 'cascade.canServeDiff'),
      5000,
    );
    if (!ready) {
      throw new Error('sidecar did not register cascade.canServeDiff in time');
    }

    // Real git-cascade adapter against the temp repo.
    const dbPath = path.join(TEST_ROOT, `${swarmId}-cascade.db`);
    const adapter = createGitCascadeAdapter({
      enabled: true,
      repoPath: tempRepo,
      dbPath,
      skipRecovery: true,
    });

    // Install the diff server against the real AgentConnection. The SDK
    // exposes onNotification/offNotification/sendNotification directly.
    const diffCleanup = setupCascadeDiffServer(conn, adapter);

    // Seed the cascade_streams projection so the resolver can look it up.
    const { stream } = upsertStream({
      stream_id: cascadeStreamId,
      source_swarm_id: swarmId,
      source_agent_id: 'sidecar-agent',
      name: 'live-sidecar',
    });

    return {
      swarmId,
      streamRowId: stream.id,
      cascadeStreamId,
      cleanup: async () => {
        try { diffCleanup(); } catch { /* ignore */ }
        try { adapter.close(); } catch { /* ignore */ }
        try { await conn.disconnect(); } catch { /* ignore */ }
        const idx = activeConns.indexOf(conn);
        if (idx >= 0) activeConns.splice(idx, 1);
      },
    };
  }

  async function httpGetDiff(
    streamRowId: string,
    commitHash: string,
    query = '',
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    // Skip the Authorization header: setLocalAgent + auth.mode='local'
    // means the middleware falls through to the local agent on missing
    // headers. Ingest keys default to `map` scope only, which 403s the
    // cascade routes (default `*` scope) — local fallback is the
    // pragmatic choice for these tests.
    const url = `http://127.0.0.1:${PORT}/api/v1/cascade/streams/${streamRowId}/commits/${commitHash}/diff${query}`;
    const res = await fetch(url);
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  }

  it('real MAP handshake + real diff server: HTTP → MAP → real git → HTTP 200 with payload', async () => {
    const fx = await startSidecar();
    try {
      const res = await httpGetDiff(fx.streamRowId, commitB);

      expect(res.status).toBe(200);
      const data = res.body.data as {
        diff: string;
        files_touched: string[];
        truncated: boolean;
      };
      expect(data.diff).toContain('diff --git a/README.md');
      expect(data.diff).toContain('diff --git a/feature.txt');
      expect(data.diff).toContain('+## new section');
      expect(data.diff).toContain('+feature content');
      expect(data.files_touched.sort()).toEqual(['README.md', 'feature.txt']);
      expect(data.truncated).toBe(false);

      // Cache populated by tier 5 write-through.
      expect(diffCache.countDiffsForStream(fx.cascadeStreamId)).toBe(1);

      // Second call hits cache.
      const res2 = await httpGetDiff(fx.streamRowId, commitB);
      expect(res2.status).toBe(200);
      expect(diffCache.countDiffsForStream(fx.cascadeStreamId)).toBe(1);
    } finally {
      await fx.cleanup();
    }
  }, 30_000);

  it('files_only over real MAP: returns files_touched, no cache write', async () => {
    const fx = await startSidecar();
    try {
      const res = await httpGetDiff(fx.streamRowId, commitB, '?files_only=true');
      expect(res.status).toBe(200);
      const data = res.body.data as { diff: string; files_touched: string[] };
      expect(data.files_touched.sort()).toEqual(['README.md', 'feature.txt']);
      expect(diffCache.countDiffsForStream(fx.cascadeStreamId)).toBe(0);
    } finally {
      await fx.cleanup();
    }
  }, 30_000);

  it('sidecar error path over real MAP: bad SHA surfaces as typed internal error', async () => {
    const fx = await startSidecar();
    try {
      const res = await httpGetDiff(fx.streamRowId, '0'.repeat(40));
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal');
      expect(diffCache.countDiffsForStream(fx.cascadeStreamId)).toBe(0);
    } finally {
      await fx.cleanup();
    }
  }, 30_000);

  it('chunked streaming over real SDK: >512 KB diff reassembles + sha256-verifies through real WS', async () => {
    const fx = await startSidecar();
    try {
      const res = await httpGetDiff(fx.streamRowId, commitBigC);

      expect(res.status).toBe(200);
      const data = res.body.data as {
        diff: string;
        files_touched: string[];
        truncated: boolean;
      };

      // The diff body must include the big-file additions. Above the
      // 512 KB inline threshold this only arrives if:
      //   1. sidecar produced a streaming response
      //   2. N chunks crossed real WS frames in seq order
      //   3. hub reassembled them in correct order
      //   4. sha256 over the final assembled blob matched the sidecar's
      //   5. resolver returned the assembled blob as `diff`
      expect(data.diff.length).toBeGreaterThan(512 * 1024);
      expect(data.diff).toContain('diff --git a/big.txt');
      expect(data.diff).toContain('+lorem ipsum dolor sit amet');
      expect(data.files_touched).toContain('big.txt');
      expect(data.truncated).toBe(false);

      // Cache populated with the assembled blob.
      expect(diffCache.countDiffsForStream(fx.cascadeStreamId)).toBe(1);

      // Round-trip integrity sanity: the body the resolver returns is the
      // same body git emits locally (modulo trailing newline behavior).
      const localDiff = execSync(
        `git show --no-textconv -U3 --format= ${commitBigC} -- big.txt`,
        { cwd: tempRepo, maxBuffer: 50 * 1024 * 1024 },
      ).toString('utf-8');
      expect(data.diff).toContain(localDiff.trim().slice(0, 200));

      // Second call hits cache.
      const res2 = await httpGetDiff(fx.streamRowId, commitBigC);
      expect(res2.status).toBe(200);
      const data2 = res2.body.data as { diff: string };
      expect(data2.diff.length).toBe(data.diff.length);
      expect(diffCache.countDiffsForStream(fx.cascadeStreamId)).toBe(1);
    } finally {
      await fx.cleanup();
    }
  }, 60_000);

  it('swarm_offline path: capability check fails once sidecar disconnects', async () => {
    const fx = await startSidecar();
    await fx.cleanup();
    // After cleanup, the inbound is unregistered (stale) — resolver tier 2
    // should short-circuit with swarm_offline.
    const res = await httpGetDiff(fx.streamRowId, commitB);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('swarm_offline');
  }, 30_000);

  // ──────────────────────────────────────────────────────────────────
  // Stream 2 — stream-level + stack-level routes against real sidecar
  // ──────────────────────────────────────────────────────────────────

  async function httpGetStreamDiff(
    streamRowId: string,
    query = '',
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = `http://127.0.0.1:${PORT}/api/v1/cascade/streams/${streamRowId}/diff${query}`;
    const res = await fetch(url);
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  }

  async function httpGetStackDiff(
    rootRowId: string,
    query = '',
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = `http://127.0.0.1:${PORT}/api/v1/cascade/streams/${rootRowId}/stack/diff${query}`;
    const res = await fetch(url);
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  }

  /**
   * Build a 2-stream linear stack on top of a fresh sidecar:
   *   root  : base = commitA, head = commitB
   *   leaf  : parent = root, base = commitB, head = commitBigC
   * Returns row ids + the underlying sidecar fixture.
   */
  async function startSidecarWithStack(): Promise<{
    swarmId: string;
    rootRowId: string;
    rootCascadeId: string;
    leafRowId: string;
    leafCascadeId: string;
    cleanup: () => Promise<void>;
  }> {
    const fx = await startSidecar();
    // The base sidecar already seeded a stream `<swarmId>-stream-1` —
    // overwrite its base_commit + add a commit to make it the root.
    const rootCascadeId = `${fx.swarmId}-stream-1`;
    upsertStream({
      stream_id: rootCascadeId,
      source_swarm_id: fx.swarmId,
      source_agent_id: 'sidecar-agent',
      name: 'stack-root',
      base_commit: commitA,
    });
    const { recordCommit } = await import('../../db/dal/cascade-streams.js');
    recordCommit({
      stream_row_id: fx.streamRowId,
      commit_hash: commitB,
      message_summary: 'feat: add section',
    });

    const leafCascadeId = `${fx.swarmId}-stream-2`;
    const { stream: leafStream } = upsertStream({
      stream_id: leafCascadeId,
      source_swarm_id: fx.swarmId,
      source_agent_id: 'sidecar-agent',
      name: 'stack-leaf',
      base_commit: commitB,
      parent_stream_id: rootCascadeId,
    });
    recordCommit({
      stream_row_id: leafStream.id,
      commit_hash: commitBigC,
      message_summary: 'feat: big payload',
    });

    return {
      swarmId: fx.swarmId,
      rootRowId: fx.streamRowId,
      rootCascadeId,
      leafRowId: leafStream.id,
      leafCascadeId,
      cleanup: fx.cleanup,
    };
  }

  it('stream-level diff: real sidecar serves base..head for one stream', async () => {
    const fx = await startSidecarWithStack();
    try {
      const res = await httpGetStreamDiff(fx.rootRowId);
      expect(res.status).toBe(200);
      const data = res.body.data as {
        diff: string;
        files_touched: string[];
      };
      // root spans commitA..commitB → just the README change + feature.txt.
      expect(data.diff).toContain('+## new section');
      expect(data.diff).toContain('+feature content');
      expect(data.files_touched.sort()).toEqual(['README.md', 'feature.txt']);
    } finally {
      await fx.cleanup();
    }
  }, 30_000);

  it('stream-level diff: bad_request when stream has no base_commit', async () => {
    const fx = await startSidecar();
    try {
      // The base sidecar's stream was created with no base_commit. Hit
      // /diff on it directly.
      const res = await httpGetStreamDiff(fx.streamRowId);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_request');
    } finally {
      await fx.cleanup();
    }
  }, 30_000);

  it('stack-level diff: cumulative commitA..commitBigC across 2-stream stack', async () => {
    const fx = await startSidecarWithStack();
    try {
      const res = await httpGetStackDiff(fx.rootRowId);
      expect(res.status).toBe(200);
      const data = res.body.data as {
        diff: string;
        files_touched: string[];
      };
      const stack = res.body.stack as {
        entries: Array<{ cascade_stream_id: string }>;
        lowest_base: string;
        highest_head: string;
      };

      // Stack spans the whole repo history we care about — all three files.
      expect(data.files_touched.sort()).toEqual(['README.md', 'big.txt', 'feature.txt']);
      expect(data.diff).toContain('+## new section');
      expect(data.diff).toContain('+lorem ipsum');

      // Echo block confirms the walker resolved the linear chain.
      expect(stack.entries.map((e) => e.cascade_stream_id)).toEqual([
        fx.rootCascadeId,
        fx.leafCascadeId,
      ]);
      expect(stack.lowest_base).toBe(commitA);
      expect(stack.highest_head).toBe(commitBigC);

      // Cache row exists under the root's cascade_stream_id (Stream 2 D5).
      expect(diffCache.countDiffsForStream(fx.rootCascadeId)).toBe(1);
    } finally {
      await fx.cleanup();
    }
  }, 60_000);

  it('stack-level files_only: returns files_touched + skips cache write (D17)', async () => {
    const fx = await startSidecarWithStack();
    try {
      const res = await httpGetStackDiff(fx.rootRowId, '?files_only=true');
      expect(res.status).toBe(200);
      const data = res.body.data as { diff: string; files_touched: string[] };
      expect(data.files_touched.sort()).toEqual(['README.md', 'big.txt', 'feature.txt']);
      expect(diffCache.countDiffsForStream(fx.rootCascadeId)).toBe(0);
    } finally {
      await fx.cleanup();
    }
  }, 30_000);

  it('stack-level non_linear_stack: 400 when root has 2 active children', async () => {
    const fx = await startSidecarWithStack();
    try {
      // Fork the stack: add a SECOND active child of root.
      const forkCascadeId = `${fx.swarmId}-fork`;
      upsertStream({
        stream_id: forkCascadeId,
        source_swarm_id: fx.swarmId,
        source_agent_id: 'sidecar-agent',
        name: 'fork-active',
        base_commit: commitB,
        parent_stream_id: fx.rootCascadeId,
      });

      const res = await httpGetStackDiff(fx.rootRowId);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('non_linear_stack');
      expect((res.body.message as string)).toContain('non-linear');
    } finally {
      await fx.cleanup();
    }
  }, 30_000);

  it('stack-level: skips merged sibling and walks the active branch (D2)', async () => {
    const fx = await startSidecarWithStack();
    try {
      // Add a MERGED sibling at root level — walker should ignore it
      // and still report a linear chain through the active leaf.
      const mergedCascadeId = `${fx.swarmId}-merged-sibling`;
      const { stream: mergedStream } = upsertStream({
        stream_id: mergedCascadeId,
        source_swarm_id: fx.swarmId,
        source_agent_id: 'sidecar-agent',
        name: 'merged-sibling',
        base_commit: commitB,
        parent_stream_id: fx.rootCascadeId,
      });
      const { updateStreamStatus } = await import('../../db/dal/cascade-streams.js');
      updateStreamStatus(mergedStream.id, 'merged');

      const res = await httpGetStackDiff(fx.rootRowId);
      expect(res.status).toBe(200);
      const stack = res.body.stack as {
        entries: Array<{ cascade_stream_id: string }>;
      };
      expect(stack.entries.map((e) => e.cascade_stream_id)).toEqual([
        fx.rootCascadeId,
        fx.leafCascadeId,
      ]);
    } finally {
      await fx.cleanup();
    }
  }, 30_000);
});
