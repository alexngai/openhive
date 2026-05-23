/**
 * E2E: real cc-swarm cascade chain against a real OpenHive hub.
 *
 * Closes the gap that none of the cc-swarm unit tests cover: a real
 * `AgentConnection` (from `@multi-agent-protocol/sdk`) connecting to
 * `setupMapWebSocket` and emitting `x-cascade/*` notifications via the cc-swarm
 * `cascade-client` + `cascade-watcher` modules, which the hub's
 * `cascade-handler` projects into `cascade_streams` / `cascade_changes` /
 * `cascade_merges` rows.
 *
 * What's exercised live:
 *   1. real `setupMapWebSocket` accepting a /ws/map connection
 *   2. real `@multi-agent-protocol/sdk` AgentConnection performing the
 *      MAP handshake + capability registration with
 *      `cascade: { canServeDiff: true, canAct: false, emitsConflicts: false }`
 *   3. real cc-swarm `openCascadeTracker` + `ensureStream` against a tmp git repo
 *   4. real cc-swarm `startCascadeWatcher` polling git refs
 *   5. real `x-cascade/stream.opened` / `.committed` / `.merged` notifications
 *      crossing the wire via `connection.callExtension(...)`
 *   6. real hub-side projection into `cascade_streams` / `cascade_changes` /
 *      `cascade_merges`
 *
 * Mirrors the pattern in `src/__tests__/cascade/live-cascade-diff-sidecar-e2e.test.ts`.
 *
 * Env gate: LIVE_AGENT_E2E=true. Skipped by default to keep the suite fast.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { AgentConnection } from '@multi-agent-protocol/sdk';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import {
  setupMapWebSocket,
  stopMapWebSocket,
} from '../../map/ws-map.js';
import { setupWebSocket } from '../../realtime/index.js';
import {
  getStreamBySwarmAndId,
  listChangesForStream,
  listConflictsForStream,
} from '../../db/dal/cascade-streams.js';
import { getDatabase } from '../../db/index.js';
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

const TEST_ROOT = testRoot('live-cc-swarm-cascade');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-cc-swarm-cascade.db');
const PORT = 20077;

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

describeIf('Live cc-swarm cascade chain — real watcher → real hub projection', () => {
  let app: FastifyInstance;
  let apiKey: string;
  let tempRepo: string;
  let trackerDbPath: string;
  let initialCommit: string;

  // Lazy-loaded cc-swarm cascade deps. Dynamic import bypasses tsc rootDir
  // (mirrors the diff-sidecar e2e approach).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let openCascadeTracker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let closeCascadeTracker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ensureStream: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let startCascadeWatcher: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let buildStreamOpenedParams: any;

  const activeConns: AgentConnection[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'cc-swarm-cascade-e2e-owner',
      description: 'Owner agent for cc-swarm cascade e2e',
    });
    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'cc-swarm-cascade-e2e',
      agent_id: agent.id,
    });
    apiKey = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'cc-swarm Cascade E2E' },
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
    await app.listen({ port: PORT, host: '127.0.0.1' });

    // Real git temp repo with one commit on main.
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-swarm-cascade-e2e-'));
    shell('git init -q -b main', tempRepo);
    shell('git config user.email "t@t.com"', tempRepo);
    shell('git config user.name "T"', tempRepo);
    shell('git config commit.gpgsign false', tempRepo);
    fs.writeFileSync(path.join(tempRepo, 'README.md'), '# initial\n');
    shell('git add .', tempRepo);
    shell('git commit -q -m initial', tempRepo);
    initialCommit = shell('git rev-parse HEAD', tempRepo);

    trackerDbPath = path.join(TEST_ROOT, 'cascade-tracker.db');

    // Lazy-load cc-swarm cascade modules. They are .mjs files outside tsc's
    // rootDir, so we go through dynamic import with a /* @vite-ignore */ hint.
    const clientPath = '../../../references/claude-code-swarm/src/cascade-client.mjs';
    const watcherPath = '../../../references/claude-code-swarm/src/cascade-watcher.mjs';
    const eventsPath = '../../../references/claude-code-swarm/src/cascade-events.mjs';
    const clientMod = await import(/* @vite-ignore */ clientPath);
    const watcherMod = await import(/* @vite-ignore */ watcherPath);
    const eventsMod = await import(/* @vite-ignore */ eventsPath);
    openCascadeTracker = clientMod.openCascadeTracker;
    closeCascadeTracker = clientMod.closeCascadeTracker;
    ensureStream = clientMod.ensureStream;
    startCascadeWatcher = watcherMod.startCascadeWatcher;
    buildStreamOpenedParams = eventsMod.buildStreamOpenedParams;
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

  it('full cc-swarm chain: tracker → x-cascade/stream.opened → hub projection; watcher tick → x-cascade/stream.committed; merge → x-cascade/stream.merged', async () => {
    // ── (1) Connect a real AgentConnection with cc-swarm capability shape ──
    const swarmId = `live-cc-swarm-cascade-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const agentId = `cc-swarm-agent-${swarmId}`;

    const conn = await AgentConnection.connect(
      `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`,
      {
        name: agentId,
        role: 'sidecar',
        auth: { method: 'none' as const },
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          // cc-swarm observe-only cascade capability block.
          cascade: {
            canServeDiff: true,
            canAct: false,
            emitsConflicts: false,
          },
        },
      } as Parameters<typeof AgentConnection.connect>[1],
    );
    activeConns.push(conn);

    // Wait for the inbound registration to settle on the hub side. Without
    // this, an immediate `callExtension` can land before ws-map has finished
    // wiring the session and the hub treats the swarmId as unknown.
    const { getInbound } = await import('../../map/connection-registry.js');
    const inboundReady = await waitFor(() => getInbound(swarmId) !== undefined, 5000);
    expect(inboundReady).toBe(true);

    // ── (2) Open tracker + ensure stream for the current branch ──
    const tracker = await openCascadeTracker({
      repoPath: tempRepo,
      dbPath: trackerDbPath,
    });
    expect(tracker).not.toBeNull();

    const ensured = ensureStream(tracker, { branch: 'main', agentId });
    expect(ensured).not.toBeNull();
    const streamId = ensured.streamId as string;
    expect(typeof streamId).toBe('string');
    expect(streamId.length).toBeGreaterThan(0);

    // ── (3) Emit x-cascade/stream.opened via the real connection ──
    const openedParams = buildStreamOpenedParams({
      streamId,
      name: 'main',
      agentId,
      baseCommit: initialCommit,
      branchName: 'main',
      metadata: { trigger: 'e2e-bootstrap' },
    });
    await conn.callExtension('x-cascade/stream.opened', openedParams);

    // Wait for hub-side projection.
    const opened = await waitFor(
      () => getStreamBySwarmAndId(swarmId, streamId) !== null,
      5000,
    );
    expect(opened).toBe(true);
    const streamRow = getStreamBySwarmAndId(swarmId, streamId)!;
    expect(streamRow.source_swarm_id).toBe(swarmId);
    expect(streamRow.source_agent_id).toBe(agentId);
    expect(streamRow.branch_name).toBe('main');
    expect(streamRow.base_commit).toBe(initialCommit);
    expect(streamRow.is_local_mode).toBe(true);

    // ── (4) Start watcher + make a commit + force a tick → expect committed ──
    const watcher = startCascadeWatcher({
      tracker,
      connection: conn,
      repoPath: tempRepo,
      agentId,
    });
    try {
      // Wait for the baseline snapshot before introducing the new commit so
      // the watcher's diff is between "baseline" and "post-commit", not zero.
      await watcher._ready;

      fs.writeFileSync(path.join(tempRepo, 'feature.txt'), 'feature\n');
      shell('git add .', tempRepo);
      shell('git commit -q -m "feat: add feature.txt"', tempRepo);
      const commitB = shell('git rev-parse HEAD', tempRepo);

      // Force a poll tick (avoid waiting on the 3s timer).
      await watcher._tickNow();

      const committed = await waitFor(() => {
        const changes = listChangesForStream(streamRow.id);
        return changes.some((c) => c.commit_hash === commitB);
      }, 5000);
      expect(committed).toBe(true);

      const changesAfterCommit = listChangesForStream(streamRow.id);
      const change = changesAfterCommit.find((c) => c.commit_hash === commitB);
      expect(change).toBeDefined();
      expect(change!.files_touched).toContain('feature.txt');
      expect(change!.message_summary).toBe('feat: add feature.txt');
      expect(change!.parent_commit).toBe(initialCommit);

      // ── (5) Bonus: merge a feature branch back into main, expect merge ──
      // Create a feature branch from main, add a commit, merge --no-ff into main.
      shell('git checkout -q -b feature-branch', tempRepo);
      fs.writeFileSync(path.join(tempRepo, 'feature2.txt'), 'feature2\n');
      shell('git add .', tempRepo);
      shell('git commit -q -m "feat: feature2 on side branch"', tempRepo);
      const featureCommit = shell('git rev-parse HEAD', tempRepo);
      shell('git checkout -q main', tempRepo);

      // Tick once after the side-branch commit is created so the watcher
      // observes the new branch's stream.opened separately (it shouldn't
      // emit a stream.committed against main for the side-branch commit).
      await watcher._tickNow();

      shell('git merge -q --no-ff feature-branch -m "Merge feature-branch"', tempRepo);
      const mergeCommit = shell('git rev-parse HEAD', tempRepo);

      await watcher._tickNow();

      // Assert the merge was projected.
      const mergeFound = await waitFor(() => {
        const db = getDatabase();
        const row = db
          .prepare(
            `SELECT * FROM cascade_merges WHERE source_swarm_id = ? AND merge_commit = ?`,
          )
          .get(swarmId, mergeCommit) as Record<string, unknown> | undefined;
        return Boolean(row);
      }, 5000);
      expect(mergeFound).toBe(true);

      const db = getDatabase();
      const mergeRow = db
        .prepare(
          `SELECT * FROM cascade_merges WHERE source_swarm_id = ? AND merge_commit = ?`,
        )
        .get(swarmId, mergeCommit) as Record<string, unknown>;
      expect(mergeRow.target_stream_id).toBe(streamId);
      expect(mergeRow.merge_commit).toBe(mergeCommit);

      // The --first-parent bug check: confirm that the side-branch commit
      // (featureCommit) was NOT mis-emitted as stream.committed against the
      // target (main) stream. The watcher uses --first-parent for merges so
      // side-branch commits are excluded from the target's commit log.
      const allChangesOnMain = listChangesForStream(streamRow.id);
      const sideCommitOnMain = allChangesOnMain.find(
        (c) => c.commit_hash === featureCommit,
      );
      expect(sideCommitOnMain).toBeUndefined();
    } finally {
      watcher.stop();
    }

    // ── (6) Teardown the per-test resources ──
    closeCascadeTracker(tracker);
    await conn.disconnect();
    const idx = activeConns.indexOf(conn);
    if (idx >= 0) activeConns.splice(idx, 1);
  }, 60_000);

  // ────────────────────────────────────────────────────────────────────
  // Conflict case: manual resolve
  //
  // Set up divergent commits on main + a feature branch. `git merge --no-ff
  // feature` triggers a real conflict, so `.git/MERGE_HEAD` appears and the
  // watcher's probe emits `x-cascade/stream.conflicted`. Resolve the file by
  // hand and commit → next tick emits `x-cascade/stream.conflict_resolved`
  // with `resolution_method ∈ {'manual','agent'}`.
  // ────────────────────────────────────────────────────────────────────
  it('conflict: manual resolve emits stream.conflicted then stream.conflict_resolved (manual/agent)', async () => {
    const swarmId = `live-cc-swarm-conflict-manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const agentId = `cc-swarm-agent-${swarmId}`;

    // Fresh repo per case to keep refs and conflict probe state independent.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-swarm-conflict-m-'));
    const trackerDb = path.join(TEST_ROOT, `${swarmId}-tracker.db`);
    try {
      shell('git init -q -b main', repo);
      shell('git config user.email "t@t.com"', repo);
      shell('git config user.name "T"', repo);
      shell('git config commit.gpgsign false', repo);
      fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
      shell('git add .', repo);
      shell('git commit -q -m initial', repo);

      // Diverge: feature branch changes shared.txt …
      shell('git checkout -q -b feature', repo);
      fs.writeFileSync(path.join(repo, 'shared.txt'), 'feature side\n');
      shell('git add .', repo);
      shell('git commit -q -m "feat: change on feature"', repo);

      // … main also changes shared.txt → guaranteed conflict on merge.
      shell('git checkout -q main', repo);
      fs.writeFileSync(path.join(repo, 'shared.txt'), 'main side\n');
      shell('git add .', repo);
      shell('git commit -q -m "feat: change on main"', repo);

      const conn = await AgentConnection.connect(
        `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`,
        {
          name: agentId,
          role: 'sidecar',
          auth: { method: 'none' as const },
          capabilities: {
            messaging: { canSend: true, canReceive: true },
            cascade: { canServeDiff: true, canAct: false, emitsConflicts: true },
          },
        } as Parameters<typeof AgentConnection.connect>[1],
      );
      activeConns.push(conn);

      const { getInbound } = await import('../../map/connection-registry.js');
      expect(await waitFor(() => getInbound(swarmId) !== undefined, 5000)).toBe(true);

      const tracker = await openCascadeTracker({ repoPath: repo, dbPath: trackerDb });
      expect(tracker).not.toBeNull();
      const ensured = ensureStream(tracker, { branch: 'main', agentId });
      const streamId = ensured.streamId as string;

      // Seed stream.opened so the hub projection exists before any conflict.
      await conn.callExtension(
        'x-cascade/stream.opened',
        buildStreamOpenedParams({
          streamId,
          name: 'main',
          agentId,
          baseCommit: shell('git rev-parse HEAD', repo),
          branchName: 'main',
        }),
      );
      expect(
        await waitFor(() => getStreamBySwarmAndId(swarmId, streamId) !== null, 5000),
      ).toBe(true);
      const streamRow = getStreamBySwarmAndId(swarmId, streamId)!;

      const watcher = startCascadeWatcher({
        tracker,
        connection: conn,
        repoPath: repo,
        agentId,
      });
      try {
        await watcher._ready;

        // Trigger the conflict. `git merge --no-ff` returns a non-zero exit
        // when the merge conflicts, so wrap to swallow the failure.
        try {
          shell('git merge --no-ff feature -m "Merge feature"', repo);
        } catch { /* expected — conflict produces non-zero exit */ }
        // Sanity: MERGE_HEAD must exist now or the watcher has nothing to
        // probe (and the assertion below will hang).
        expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);

        await watcher._tickNow();

        // The hub should have projected a cascade_conflicts row by now.
        const sawConflict = await waitFor(() => {
          const conflicts = listConflictsForStream(streamRow.id);
          return conflicts.some(
            (c) => c.source === 'merge' && c.status === 'pending',
          );
        }, 5000);
        expect(sawConflict).toBe(true);

        const conflictsBeforeResolve = listConflictsForStream(streamRow.id);
        const pending = conflictsBeforeResolve.find(
          (c) => c.status === 'pending' && c.source === 'merge',
        )!;
        expect(pending).toBeDefined();
        expect(pending.conflicted_files).toContain('shared.txt');

        // Resolve manually + commit → HEAD advances to a merge commit (2 parents).
        fs.writeFileSync(path.join(repo, 'shared.txt'), 'reconciled\n');
        shell('git add shared.txt', repo);
        shell('git commit -q --no-edit', repo);

        await watcher._tickNow();

        const sawResolved = await waitFor(() => {
          const conflicts = listConflictsForStream(streamRow.id);
          return conflicts.some(
            (c) =>
              c.conflict_id === pending.conflict_id &&
              c.status === 'resolved',
          );
        }, 5000);
        expect(sawResolved).toBe(true);

        const conflictsAfter = listConflictsForStream(streamRow.id);
        const resolved = conflictsAfter.find(
          (c) => c.conflict_id === pending.conflict_id,
        )!;
        expect(resolved.status).toBe('resolved');
        const method = (resolved.metadata as Record<string, unknown> | null)?.[
          'resolution_method'
        ] as string | undefined;
        expect(method).toBeDefined();
        expect(['manual', 'agent']).toContain(method as string);
      } finally {
        watcher.stop();
      }

      closeCascadeTracker(tracker);
      await conn.disconnect();
      const idx = activeConns.indexOf(conn);
      if (idx >= 0) activeConns.splice(idx, 1);
    } finally {
      if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // ────────────────────────────────────────────────────────────────────
  // Conflict case: abort
  //
  // Same divergent setup, but `git merge --abort` clears MERGE_HEAD without
  // advancing HEAD — the watcher should emit `stream.conflict_resolved` with
  // `resolution_method: 'abandoned'`.
  // ────────────────────────────────────────────────────────────────────
  it('conflict: abort emits stream.conflicted then stream.conflict_resolved (abandoned)', async () => {
    const swarmId = `live-cc-swarm-conflict-abort-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const agentId = `cc-swarm-agent-${swarmId}`;

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-swarm-conflict-a-'));
    const trackerDb = path.join(TEST_ROOT, `${swarmId}-tracker.db`);
    try {
      shell('git init -q -b main', repo);
      shell('git config user.email "t@t.com"', repo);
      shell('git config user.name "T"', repo);
      shell('git config commit.gpgsign false', repo);
      fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
      shell('git add .', repo);
      shell('git commit -q -m initial', repo);

      shell('git checkout -q -b feature', repo);
      fs.writeFileSync(path.join(repo, 'shared.txt'), 'feature side\n');
      shell('git add .', repo);
      shell('git commit -q -m "feat: change on feature"', repo);

      shell('git checkout -q main', repo);
      fs.writeFileSync(path.join(repo, 'shared.txt'), 'main side\n');
      shell('git add .', repo);
      shell('git commit -q -m "feat: change on main"', repo);

      const conn = await AgentConnection.connect(
        `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`,
        {
          name: agentId,
          role: 'sidecar',
          auth: { method: 'none' as const },
          capabilities: {
            messaging: { canSend: true, canReceive: true },
            cascade: { canServeDiff: true, canAct: false, emitsConflicts: true },
          },
        } as Parameters<typeof AgentConnection.connect>[1],
      );
      activeConns.push(conn);

      const { getInbound } = await import('../../map/connection-registry.js');
      expect(await waitFor(() => getInbound(swarmId) !== undefined, 5000)).toBe(true);

      const tracker = await openCascadeTracker({ repoPath: repo, dbPath: trackerDb });
      const ensured = ensureStream(tracker, { branch: 'main', agentId });
      const streamId = ensured.streamId as string;
      await conn.callExtension(
        'x-cascade/stream.opened',
        buildStreamOpenedParams({
          streamId,
          name: 'main',
          agentId,
          baseCommit: shell('git rev-parse HEAD', repo),
          branchName: 'main',
        }),
      );
      expect(
        await waitFor(() => getStreamBySwarmAndId(swarmId, streamId) !== null, 5000),
      ).toBe(true);
      const streamRow = getStreamBySwarmAndId(swarmId, streamId)!;

      const watcher = startCascadeWatcher({
        tracker,
        connection: conn,
        repoPath: repo,
        agentId,
      });
      try {
        await watcher._ready;

        try {
          shell('git merge --no-ff feature -m "Merge feature"', repo);
        } catch { /* conflict expected */ }
        expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);

        await watcher._tickNow();

        // Confirm the conflict is on the wire + projected before abort.
        const sawConflict = await waitFor(() => {
          const conflicts = listConflictsForStream(streamRow.id);
          return conflicts.some((c) => c.status === 'pending' && c.source === 'merge');
        }, 5000);
        expect(sawConflict).toBe(true);

        const pending = listConflictsForStream(streamRow.id).find(
          (c) => c.status === 'pending' && c.source === 'merge',
        )!;
        expect(pending).toBeDefined();

        // Abort the merge — MERGE_HEAD disappears, HEAD unchanged.
        shell('git merge --abort', repo);
        expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);

        await watcher._tickNow();

        const sawResolved = await waitFor(() => {
          const conflicts = listConflictsForStream(streamRow.id);
          const row = conflicts.find((c) => c.conflict_id === pending.conflict_id);
          if (!row) return false;
          if (row.status !== 'resolved') return false;
          const meta = row.metadata as Record<string, unknown> | null;
          return meta?.['resolution_method'] === 'abandoned';
        }, 5000);
        expect(sawResolved).toBe(true);
      } finally {
        watcher.stop();
      }

      closeCascadeTracker(tracker);
      await conn.disconnect();
      const idx = activeConns.indexOf(conn);
      if (idx >= 0) activeConns.splice(idx, 1);
    } finally {
      if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});
