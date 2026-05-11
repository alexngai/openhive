/**
 * End-to-end test for the cascade diff chain.
 *
 *   resolveCommitDiff (hub)
 *     → cache miss
 *     → presence + capability gate
 *     → sendDiffRequest (hub protocol module)        ←┐
 *         → fake WS .send() routes to sidecar          │
 *             → cascade-diff-server handler            │  in-process bridge
 *               → real git in temp repo                │
 *               → conn.sendNotification(response/chunk)│
 *         → handleDiffResponse / handleDiffChunk      ←┘
 *     → reassembly + sha256 verify
 *     → cache write-through
 *     → payload returned
 *
 * Both inline and chunked-streaming paths are exercised. A second call
 * verifies the cache short-circuits without a fresh sidecar shell-out.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import WebSocket from 'ws';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { upsertStream } from '../../db/dal/cascade-streams.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ---------------------------------------------------------------------------
// Registry stub: getInbound returns the fake WS, hasCapability returns true.
// Wired via vi.mock at module-eval time.
// ---------------------------------------------------------------------------

interface FakeWs {
  readyState: number;
  send: (data: string) => void;
}

const SWARM_ID = 'e2e-swarm';
const fakeWsRef: { current: FakeWs | null } = { current: null };

vi.mock('../../map/connection-registry.js', () => ({
  getInbound: (swarmId: string) =>
    swarmId === SWARM_ID && fakeWsRef.current
      ? { ws: fakeWsRef.current }
      : undefined,
  hasCapability: (swarmId: string) => swarmId === SWARM_ID,
}));

// Imports must come after vi.mock so the mock binds.
import { resolveCommitDiff } from '../../cascade/diff-resolver.js';
import {
  handleDiffResponse,
  handleDiffChunk,
  installAsResolverFetcher,
  __resetPendingForTests,
} from '../../map/cascade-diff-protocol.js';
import * as diffCache from '../../db/dal/cascade-diff-cache.js';

// macro-agent imports are lazy-loaded at runtime (built dist consumed via
// the symlinked `macro-agent` npm dep) so `tsc --noEmit` doesn't follow
// them across the rootDir boundary. Matches the convention in
// cascade-emission-e2e.test.ts.
type CascadeDiffServerConnection = {
  onNotification: (m: string, h: (p: unknown) => void | Promise<void>) => void;
  offNotification: (m: string, h: (p: unknown) => void | Promise<void>) => void;
  sendNotification: (m: string, p: Record<string, unknown>) => void | Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GitCascadeAdapter = any;
let setupCascadeDiffServer:
  | ((c: CascadeDiffServerConnection, a: GitCascadeAdapter) => () => void)
  | null = null;

beforeAll(async () => {
  // Use the references/ path directly — the macro-agent npm symlink isn't
  // always kept in sync with our local edits, and tsc rootDir prevents a
  // static import. /* @vite-ignore */ keeps Vite from trying to pre-resolve.
  const p = '../../../references/macro-agent/dist/map/cascade-diff-server.js';
  const mod = await import(/* @vite-ignore */ p);
  setupCascadeDiffServer = mod.setupCascadeDiffServer as typeof setupCascadeDiffServer;
});

// ---------------------------------------------------------------------------
// In-process bridge between hub and sidecar
// ---------------------------------------------------------------------------

interface Bridge {
  fakeWs: FakeWs;
  sidecarConn: CascadeDiffServerConnection;
  /** Number of times the sidecar's git shell-out fired (call count). */
  sidecarRequestCount: number;
}

function buildBridge(): Bridge {
  let sidecarHandler: ((params: unknown) => Promise<void> | void) | null = null;
  let requestCount = 0;

  // Hub → Sidecar: when sendDiffRequest writes to ws.send(JSON), we parse
  // it and invoke the sidecar's onNotification handler for diff.request.
  const fakeWs: FakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      const msg = JSON.parse(data);
      if (msg.method === 'cascade/diff.request' && sidecarHandler) {
        requestCount++;
        // Defer to next tick so the hub's pendingRequests map is set first.
        Promise.resolve().then(() => sidecarHandler!(msg.params));
      }
    },
  };

  // Sidecar → Hub: when sidecar sendNotification fires, route to the hub
  // protocol module's handleDiffResponse / handleDiffChunk.
  const sidecarConn: CascadeDiffServerConnection = {
    onNotification(method, handler) {
      if (method === 'cascade/diff.request') sidecarHandler = handler;
    },
    offNotification(method) {
      if (method === 'cascade/diff.request') sidecarHandler = null;
    },
    sendNotification(method, params) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (method === 'cascade/diff.response') handleDiffResponse(params as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      else if (method === 'cascade/diff.chunk') handleDiffChunk(params as any);
    },
  };

  return {
    fakeWs,
    sidecarConn,
    get sidecarRequestCount() {
      return requestCount;
    },
  } as Bridge;
}

// ---------------------------------------------------------------------------
// Test repo + adapter stub
// ---------------------------------------------------------------------------

function shell(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString('utf-8')
    .trim();
}

function mkAdapter(repoPath: string): GitCascadeAdapter {
  return {
    get repoPath() {
      return repoPath;
    },
    listWorktrees() {
      return [];
    },
  } as unknown as GitCascadeAdapter;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const TEST_ROOT = testRoot('diff-chain-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'diff-chain.db');

let agentId: string;
let repoPath: string;
let tempRepoRoot: string;
let commitA: string;
let commitB: string;
let streamRowId: string;
const STREAM_CASCADE_ID = 'e2e-stream';

describe('cascade diff e2e — hub → MAP → sidecar → git → cache', () => {
  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'e2e-diff-agent',
      description: 'e2e diff test',
    });
    agentId = agent.id;

    // Real git repo
    tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-chain-e2e-'));
    repoPath = path.join(tempRepoRoot, 'repo');
    fs.mkdirSync(repoPath);
    shell('git init -q', repoPath);
    shell('git config user.email "t@t.com"', repoPath);
    shell('git config user.name "T"', repoPath);
    shell('git config commit.gpgsign false', repoPath);

    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'one\n');
    shell('git add .', repoPath);
    shell('git commit -q -m initial', repoPath);
    commitA = shell('git rev-parse HEAD', repoPath);

    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repoPath, 'b.txt'), 'fresh\n');
    shell('git add .', repoPath);
    shell('git commit -q -m second', repoPath);
    commitB = shell('git rev-parse HEAD', repoPath);

    // Cascade stream row so the resolver can look it up
    const { stream } = upsertStream({
      stream_id: STREAM_CASCADE_ID,
      source_swarm_id: SWARM_ID,
      source_agent_id: agentId,
      name: 'e2e',
    });
    streamRowId = stream.id;

    installAsResolverFetcher();
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (tempRepoRoot && fs.existsSync(tempRepoRoot)) {
      fs.rmSync(tempRepoRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM cascade_diff_cache').run();
    __resetPendingForTests();
  });

  afterEach(() => {
    fakeWsRef.current = null;
    __resetPendingForTests();
  });

  it('inline path: small commit diff round-trips end-to-end', async () => {
    const bridge = buildBridge();
    fakeWsRef.current = bridge.fakeWs;
    setupCascadeDiffServer!(bridge.sidecarConn, mkAdapter(repoPath));

    const result = await resolveCommitDiff({
      stream_row_id: streamRowId,
      commit_hash: commitB,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.diff).toContain('diff --git a/a.txt');
      expect(result.payload.diff).toContain('diff --git a/b.txt');
      expect(result.payload.diff).toContain('+two');
      expect(result.payload.files_touched.sort()).toEqual(['a.txt', 'b.txt']);
      expect(result.payload.truncated).toBe(false);
    }
    expect(bridge.sidecarRequestCount).toBe(1);

    // Cache populated by write-through tier.
    expect(diffCache.countDiffsForStream(STREAM_CASCADE_ID)).toBe(1);
  });

  it('cache hit: second call returns without invoking the sidecar', async () => {
    const bridge = buildBridge();
    fakeWsRef.current = bridge.fakeWs;
    setupCascadeDiffServer!(bridge.sidecarConn, mkAdapter(repoPath));

    // First call populates the cache.
    const first = await resolveCommitDiff({
      stream_row_id: streamRowId,
      commit_hash: commitB,
    });
    expect(first.ok).toBe(true);
    expect(bridge.sidecarRequestCount).toBe(1);

    // Second call hits cache — no sidecar invocation.
    const second = await resolveCommitDiff({
      stream_row_id: streamRowId,
      commit_hash: commitB,
    });
    expect(second.ok).toBe(true);
    expect(bridge.sidecarRequestCount).toBe(1); // unchanged
    if (first.ok && second.ok) {
      expect(second.payload.diff).toBe(first.payload.diff);
    }
  });

  it('range diff (base..head) round-trips with the cache keyed on base_hash', async () => {
    const bridge = buildBridge();
    fakeWsRef.current = bridge.fakeWs;
    setupCascadeDiffServer!(bridge.sidecarConn, mkAdapter(repoPath));

    const result = await resolveCommitDiff({
      stream_row_id: streamRowId,
      commit_hash: commitB,
      base_hash: commitA,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.diff).toContain('+two');
      expect(result.payload.diff).toContain('+fresh');
    }

    // Cache row should be distinct from the commit-only entry.
    const cached = diffCache.getDiff({
      stream_id: STREAM_CASCADE_ID,
      commit_hash: commitB,
      base_hash: commitA,
    });
    expect(cached).not.toBeNull();
    const nullBase = diffCache.getDiff({
      stream_id: STREAM_CASCADE_ID,
      commit_hash: commitB,
    });
    expect(nullBase).toBeNull(); // distinct key
  });

  it('files_only path: returns files_touched without populating the cache', async () => {
    const bridge = buildBridge();
    fakeWsRef.current = bridge.fakeWs;
    setupCascadeDiffServer!(bridge.sidecarConn, mkAdapter(repoPath));

    const result = await resolveCommitDiff({
      stream_row_id: streamRowId,
      commit_hash: commitB,
      files_only: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.diff).toBe('');
      expect(result.payload.files_touched.sort()).toEqual(['a.txt', 'b.txt']);
    }

    // D17: files_only does not write through.
    expect(diffCache.countDiffsForStream(STREAM_CASCADE_ID)).toBe(0);
  });

  it('streaming path: >512 KB diff arrives as chunks, reassembles, validates sha256', async () => {
    const bridge = buildBridge();
    fakeWsRef.current = bridge.fakeWs;
    setupCascadeDiffServer!(bridge.sidecarConn, mkAdapter(repoPath));

    // Make a chunked-sized commit.
    const big = 'x'.repeat(600 * 1024) + '\n';
    fs.writeFileSync(path.join(repoPath, 'big.txt'), big);
    shell('git add .', repoPath);
    shell('git commit -q -m big', repoPath);
    const commitC = shell('git rev-parse HEAD', repoPath);

    const result = await resolveCommitDiff({
      stream_row_id: streamRowId,
      commit_hash: commitC,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.diff).toContain('diff --git a/big.txt');
      expect(result.payload.files_touched).toContain('big.txt');
      expect(result.payload.truncated).toBe(false);
      // The reassembled blob should be the same size as the file content
      // plus diff envelope — minimum sanity floor.
      expect(result.payload.diff.length).toBeGreaterThan(500 * 1024);
    }
    expect(diffCache.countDiffsForStream(STREAM_CASCADE_ID)).toBe(1);
  }, 30_000);

  it('sidecar error (unknown SHA) propagates as a typed DiffError', async () => {
    const bridge = buildBridge();
    fakeWsRef.current = bridge.fakeWs;
    setupCascadeDiffServer!(bridge.sidecarConn, mkAdapter(repoPath));

    const result = await resolveCommitDiff({
      stream_row_id: streamRowId,
      commit_hash: '0'.repeat(40),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal');
      expect(result.error.message).toMatch(/git/i);
    }
    // No cache write on error.
    expect(diffCache.countDiffsForStream(STREAM_CASCADE_ID)).toBe(0);
  });

  it('concurrent identical requests both succeed; cache absorbs the duplicate write', async () => {
    const bridge = buildBridge();
    fakeWsRef.current = bridge.fakeWs;
    setupCascadeDiffServer!(bridge.sidecarConn, mkAdapter(repoPath));

    // Both callers miss the cache (it's empty) and both fire to the sidecar.
    // Acceptable per design (D6 — INSERT OR IGNORE protects correctness;
    // an in-flight dedup map was explicitly judged overkill for v1).
    const [a, b] = await Promise.all([
      resolveCommitDiff({ stream_row_id: streamRowId, commit_hash: commitB }),
      resolveCommitDiff({ stream_row_id: streamRowId, commit_hash: commitB }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      // Both see the same content (deterministic git output).
      expect(b.payload.diff).toBe(a.payload.diff);
      expect(b.payload.files_touched).toEqual(a.payload.files_touched);
    }

    // Both calls hit the sidecar — the cache only catches the second
    // call on subsequent invocations, not under contention.
    expect(bridge.sidecarRequestCount).toBe(2);

    // INSERT OR IGNORE collapses the duplicate write — exactly one cache row.
    expect(diffCache.countDiffsForStream(STREAM_CASCADE_ID)).toBe(1);

    // A third caller now hits the populated cache without invoking the sidecar.
    const c = await resolveCommitDiff({
      stream_row_id: streamRowId,
      commit_hash: commitB,
    });
    expect(c.ok).toBe(true);
    expect(bridge.sidecarRequestCount).toBe(2); // unchanged
  });

  it('swarm offline path: resolver short-circuits with swarm_offline error', async () => {
    // No fakeWs registered → getInbound returns undefined.
    fakeWsRef.current = null;

    const result = await resolveCommitDiff({
      stream_row_id: streamRowId,
      commit_hash: commitB,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('swarm_offline');
  });
});
