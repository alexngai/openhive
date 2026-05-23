/**
 * E2E: cc-swarm cascade-watcher reconnect-recovery path on the live wire.
 *
 * Proves that after the underlying MAP connection drops, the sidecar can:
 *   1. observe the inbound is gone on the hub side,
 *   2. open a fresh `AgentConnection` with the same agent name + swarm id,
 *   3. swap it into the watcher via `setConnection(newConn)`,
 *   4. trigger `reassertStreams()` so the hub gets a fresh
 *      `x-cascade/stream.opened` (idempotent — no duplicate row),
 *   5. observe new commits made during/after the drop arrive once the
 *      reconnected watcher ticks.
 *
 * What this test catches: the seam where the watcher holds an internal
 * connection ref and the hub holds a swarm→connection registry — both have
 * to be re-bound or events vanish silently across the gap.
 *
 * Env gate: LIVE_AGENT_E2E=true.
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
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
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
} from '../../db/dal/cascade-streams.js';
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

const TEST_ROOT = testRoot('live-cc-swarm-reconnect');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-cc-swarm-reconnect.db');
const PORT = 20111;

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

describeIf('Live cc-swarm watcher reconnect-recovery', () => {
  let app: FastifyInstance;
  let apiKey: string;
  let tempRepo: string;
  let trackerDbPath: string;
  let initialCommit: string;

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
      name: 'cc-swarm-reconnect-e2e-owner',
      description: 'Owner agent for cc-swarm reconnect e2e',
    });
    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'cc-swarm-reconnect-e2e',
      agent_id: agent.id,
    });
    apiKey = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'cc-swarm Reconnect E2E' },
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

    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-swarm-reconnect-e2e-'));
    shell('git init -q -b main', tempRepo);
    shell('git config user.email "t@t.com"', tempRepo);
    shell('git config user.name "T"', tempRepo);
    shell('git config commit.gpgsign false', tempRepo);
    fs.writeFileSync(path.join(tempRepo, 'README.md'), '# initial\n');
    shell('git add .', tempRepo);
    shell('git commit -q -m initial', tempRepo);
    initialCommit = shell('git rev-parse HEAD', tempRepo);

    trackerDbPath = path.join(TEST_ROOT, 'cascade-tracker.db');

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

  it('drop + reconnect + reassertStreams: hub keeps one row, picks up new commits', async () => {
    const swarmId = `live-cc-swarm-reconnect-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const agentId = `cc-swarm-agent-${swarmId}`;

    // ── Step 1. Open the initial connection + tracker + watcher ──────────
    const conn1 = await AgentConnection.connect(
      `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`,
      {
        name: agentId,
        role: 'sidecar',
        auth: { method: 'none' as const },
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          cascade: {
            canServeDiff: true,
            canAct: false,
            emitsConflicts: false,
          },
        },
      } as Parameters<typeof AgentConnection.connect>[1],
    );
    activeConns.push(conn1);

    const { getInbound } = await import('../../map/connection-registry.js');
    expect(await waitFor(() => getInbound(swarmId) !== undefined, 5000)).toBe(true);

    const tracker = await openCascadeTracker({
      repoPath: tempRepo,
      dbPath: trackerDbPath,
    });
    const ensured = ensureStream(tracker, { branch: 'main', agentId });
    const streamId = ensured.streamId as string;

    // Drive the initial stream.opened over the wire so the hub projects it.
    await conn1.callExtension(
      'x-cascade/stream.opened',
      buildStreamOpenedParams({
        streamId,
        name: 'main',
        agentId,
        baseCommit: initialCommit,
        branchName: 'main',
      }),
    );
    expect(
      await waitFor(() => getStreamBySwarmAndId(swarmId, streamId) !== null, 5000),
    ).toBe(true);

    const watcher = startCascadeWatcher({
      tracker,
      connection: conn1,
      repoPath: tempRepo,
      agentId,
    });
    await watcher._ready;

    // ── Step 2. Drop the connection ──────────────────────────────────────
    await conn1.disconnect();
    const idx1 = activeConns.indexOf(conn1);
    if (idx1 >= 0) activeConns.splice(idx1, 1);

    // Wait for the hub to observe the close and clear the inbound entry.
    expect(await waitFor(() => getInbound(swarmId) === undefined, 5000)).toBe(true);

    // ── Step 3. Make a commit while disconnected ─────────────────────────
    fs.writeFileSync(path.join(tempRepo, 'after-drop.txt'), 'after drop\n');
    shell('git add .', tempRepo);
    shell('git commit -q -m "feat: commit during drop"', tempRepo);
    const commitDuringDrop = shell('git rev-parse HEAD', tempRepo);

    // ── Step 4. Reconnect with same swarm id + agent name ────────────────
    const conn2 = await AgentConnection.connect(
      `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`,
      {
        name: agentId,
        role: 'sidecar',
        auth: { method: 'none' as const },
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          cascade: {
            canServeDiff: true,
            canAct: false,
            emitsConflicts: false,
          },
        },
      } as Parameters<typeof AgentConnection.connect>[1],
    );
    activeConns.push(conn2);

    expect(await waitFor(() => getInbound(swarmId) !== undefined, 5000)).toBe(true);

    // Swap the connection into the watcher + re-assert open streams.
    watcher.setConnection(conn2);
    watcher.reassertStreams();

    // ── Step 5. Tick + assert new commit reaches the hub ────────────────
    try {
      await watcher._tickNow();

      const streamRow = getStreamBySwarmAndId(swarmId, streamId)!;
      const committed = await waitFor(() => {
        const changes = listChangesForStream(streamRow.id);
        return changes.some((c) => c.commit_hash === commitDuringDrop);
      }, 5000);
      expect(committed).toBe(true);

      // ── Step 6. Idempotency: still exactly one cascade_streams row ────
      const db = getDatabase();
      const countRow = db
        .prepare(
          `SELECT COUNT(*) AS c FROM cascade_streams
           WHERE source_swarm_id = ? AND stream_id = ?`,
        )
        .get(swarmId, streamId) as { c: number };
      expect(countRow.c).toBe(1);
    } finally {
      watcher.stop();
    }

    closeCascadeTracker(tracker);
    await conn2.disconnect();
    const idx2 = activeConns.indexOf(conn2);
    if (idx2 >= 0) activeConns.splice(idx2, 1);
  }, 60_000);
});
