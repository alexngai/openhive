/**
 * E2E: cc-swarm Phase 2.5 auto-close chain on the live wire.
 *
 * Proves the integration seam this owns:
 *   `task_graph → resource_id resolution → cascade-handler backfill →
 *    mapHubEvents.cascade_stream_merged with a resolved task_ref → task-binder
 *    routes to the opentasks daemon-client`.
 *
 * Wire pieces exercised live:
 *   1. real `setupMapWebSocket` accepting AgentConnection registration
 *   2. cc-swarm-shaped `metadata.task_graph: { path, location_hash }` →
 *      `resolveTaskGraphResourceId` writes a real default-task-graph entry
 *   3. cc-swarm `openCascadeTracker` + `ensureStream`
 *   4. real `x-cascade/stream.opened` + `.committed` + `.merged` with the
 *      cc-swarm-shaped `task_ref: { node_id }` (no resource_id)
 *   5. real `cascade-handler.handleStreamMerged` resolves the missing
 *      resource_id via the swarm's defaultTaskGraph and emits a complete
 *      `mapHubEvents.cascade_stream_merged` event
 *   6. real `task-binder` subscribes, resolves the policy, and calls the
 *      mocked daemon-client with `(socketPath, node_id, { status:
 *      'completed' }, localPath)` — the binder/daemon-client seam itself
 *
 * NOT exercised: real opentasks daemon process (deliberately mocked — that
 * leg has unit coverage). The integration this test owns is the *resolution*
 * + *routing* chain, not the daemon RPC.
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

// Mocks for the *terminal* daemon write legs only. Everything between the
// MAP wire and these mocks is real.
const daemonUpdateTask = vi.fn();
const resolveDaemonSocket = vi.fn((_: string) => '/tmp/fake-cc-swarm-socket');
const remoteUpdateTask = vi.fn();
const findSwarmForResource = vi.fn();

vi.mock('../../realtime/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../realtime/index.js')>(
    '../../realtime/index.js',
  );
  return {
    ...actual,
    broadcastToChannel: vi.fn(),
  };
});
vi.mock('../../map/task-daemon-client.js', () => ({
  daemonUpdateTask: (socketPath: string, taskId: string, updates: unknown, opentasksDir?: string) =>
    daemonUpdateTask(socketPath, taskId, updates, opentasksDir),
  resolveDaemonSocket: (opentasksDir: string) => resolveDaemonSocket(opentasksDir),
  TaskDaemonError: class TaskDaemonError extends Error {},
}));
vi.mock('../../map/opentasks-remote.js', () => ({
  remoteUpdateTask: (swarmId: string, taskId: string, status: string) =>
    remoteUpdateTask(swarmId, taskId, status),
  findSwarmForResource: (resource: unknown) => findSwarmForResource(resource),
}));

const { AgentConnection } = await import('@multi-agent-protocol/sdk');
const { initDatabase, closeDatabase } = await import('../../db/index.js');
const agentsDAL = await import('../../db/dal/agents.js');
const resourcesDAL = await import('../../db/dal/syncable-resources.js');
const { createIngestKey } = await import('../../db/dal/ingest-keys.js');
const { setLocalAgent } = await import('../../api/middleware/auth.js');
const { setupMapWebSocket, stopMapWebSocket } = await import('../../map/ws-map.js');
const { setupWebSocket } = await import('../../realtime/index.js');
const { startTaskBinder, stopTaskBinder } = await import('../../cascade/task-binder.js');
const { getDefaultTaskGraph } = await import('../../map/connection-registry.js');
const { mapHubEvents } = await import('../../map/service.js');
const { ConfigSchema } = await import('../../config.js');
const testDirs = await import('../helpers/test-dirs.js');
const { testRoot, testDbPath, cleanTestRoot } = testDirs;

const LIVE = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE ? describe : describe.skip;

const TEST_ROOT = testRoot('live-cc-swarm-auto-close');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-cc-swarm-auto-close.db');
const PORT = 20099;

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

describeIf('Live cc-swarm auto-close chain (task_graph → backfill → binder)', () => {
  let app: FastifyInstance;
  let apiKey: string;
  let tempRepo: string;
  let opentasksDir: string;
  let locationHash: string;
  let initialCommit: string;
  let trackerDbPath: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let openCascadeTracker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let closeCascadeTracker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ensureStream: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let buildStreamOpenedParams: any;

  const activeConns: import('@multi-agent-protocol/sdk').AgentConnection[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'cc-swarm-auto-close-e2e-owner',
      description: 'Owner agent for cc-swarm auto-close e2e',
    });
    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'cc-swarm-auto-close-e2e',
      agent_id: agent.id,
    });
    apiKey = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'cc-swarm Auto-Close E2E' },
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

    // Tmp opentasks dir with `config.json.location.hash` — the shape
    // `readOpenTasksMeta` looks for. Used by the hub to derive
    // `metadata.location_hash` when auto-registering the resource.
    opentasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-swarm-opentasks-'));
    locationHash = `cc-swarm-loc-${Date.now()}`;
    fs.writeFileSync(
      path.join(opentasksDir, 'config.json'),
      JSON.stringify(
        { location: { hash: locationHash, name: 'cc-swarm-test' } },
        null,
        2,
      ),
    );
    // `isValidOpenTasksDir` also accepts `graph.jsonl` — touch it so we
    // pass the validity check regardless of `config.json` lookup path.
    fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '');

    // Tmp git repo for the cascade tracker.
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-swarm-auto-close-repo-'));
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
    const eventsPath = '../../../references/claude-code-swarm/src/cascade-events.mjs';
    const clientMod = await import(/* @vite-ignore */ clientPath);
    const eventsMod = await import(/* @vite-ignore */ eventsPath);
    openCascadeTracker = clientMod.openCascadeTracker;
    closeCascadeTracker = clientMod.closeCascadeTracker;
    ensureStream = clientMod.ensureStream;
    buildStreamOpenedParams = eventsMod.buildStreamOpenedParams;
  }, 30_000);

  afterAll(async () => {
    stopTaskBinder();
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
    if (opentasksDir && fs.existsSync(opentasksDir)) {
      fs.rmSync(opentasksDir, { recursive: true, force: true });
    }
    cleanTestRoot(TEST_ROOT);
  }, 30_000);

  it('cc-swarm task_graph (path + location_hash) resolves to a resource_id, merge backfills task_ref, binder routes to daemon-client', async () => {
    // Reset mocks. Use `on_merge` as the per-test default so the policy
    // resolves without per-task / per-swarm opt-in (deliberate: the test
    // owns this lever).
    daemonUpdateTask.mockReset();
    remoteUpdateTask.mockReset();
    findSwarmForResource.mockReset();

    // Daemon-client mock resolves success — proves the binder reached the
    // local daemon path with a usable resource.
    daemonUpdateTask.mockResolvedValue({ id: 'task-abc', status: 'completed' });
    // Even though we're going through the local-daemon path, stub the
    // remote fallback too so the test stays robust if the binder reorders
    // its tiers.
    findSwarmForResource.mockReturnValue(null);
    remoteUpdateTask.mockResolvedValue(null);

    startTaskBinder({ defaultClosePolicy: 'on_merge' });

    const swarmId = `live-cc-swarm-auto-close-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const agentId = `cc-swarm-agent-${swarmId}`;

    // Capture the cascade_stream_merged event so we can assert the
    // backfilled task_ref shape carries a real resource_id + the node_id
    // the watcher emitted.
    const mergedEvents: Array<Record<string, unknown>> = [];
    const captureMerged = (data: unknown) => {
      mergedEvents.push(data as Record<string, unknown>);
    };
    mapHubEvents.on('cascade_stream_merged', captureMerged);

    try {
      const conn = await AgentConnection.connect(
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
              autoCloseOnMerge: true,
            },
          },
        } as Parameters<typeof AgentConnection.connect>[1],
      );
      activeConns.push(conn);

      // Wait for inbound to settle.
      const { getInbound } = await import('../../map/connection-registry.js');
      expect(await waitFor(() => getInbound(swarmId) !== undefined, 5000)).toBe(true);

      // Step (i) — drive the **production wire** path.
      //
      // The MAP SDK's connect() does NOT propagate the `metadata` field to
      // the initial map/agents/register frame (only name/role/capabilities
      // cross the wire). Sidecars push their task_graph post-connect via
      // updateMetadata(); the hub's `agent.metadata.changed` handler now
      // re-runs resolveTaskGraphResourceId + setDefaultTaskGraph when the
      // metadata change carries a task_graph (and ensureAgentRowForRegistered
      // satisfies the agents-table FK). Asserting that the default task graph
      // gets populated from this path is what proves the seam works
      // end-to-end on the real wire — earlier this test bypassed it by
      // calling resolveTaskGraphResourceId directly, which hid both gaps.
      await conn.updateMetadata({
        task_graph: { path: opentasksDir, location_hash: locationHash },
      });

      const ready = await waitFor(() => {
        const g = getDefaultTaskGraph(swarmId);
        return Boolean(g?.resource_id);
      }, 5000);
      expect(ready).toBe(true);
      const defaultGraph = getDefaultTaskGraph(swarmId);
      const resolvedResourceId = defaultGraph!.resource_id;
      expect(resolvedResourceId).toBeDefined();

      // Belt: the resource exists and is an opentasks resource. Stamp
      // `local_path` so the binder picks the local-daemon path (instead
      // of remoteUpdateTask).
      let resource = resourcesDAL.findResourceById(resolvedResourceId!);
      expect(resource).not.toBeNull();
      expect(resource!.resource_type).toBe('task');
      expect((resource!.metadata as Record<string, unknown>)?.opentasks).toBe(true);
      resourcesDAL.updateResource(resolvedResourceId!, {
        local_path: opentasksDir,
      });
      resource = resourcesDAL.findResourceById(resolvedResourceId!);
      expect(resource!.local_path).toBe(opentasksDir);

      // Step (ii) — open the cc-swarm tracker, ensure a stream, emit
      // `stream.opened` so the hub projects it.
      const tracker = await openCascadeTracker({
        repoPath: tempRepo,
        dbPath: trackerDbPath,
      });
      const ensured = ensureStream(tracker, { branch: 'main', agentId });
      const streamId = ensured.streamId as string;

      await conn.callExtension(
        'x-cascade/stream.opened',
        buildStreamOpenedParams({
          streamId,
          name: 'main',
          agentId,
          baseCommit: initialCommit,
          branchName: 'main',
        }),
      );

      // Make a commit on main so `git rev-list base..head` has something
      // to walk if the watcher hypothetically ran.
      fs.writeFileSync(path.join(tempRepo, 'feature.txt'), 'cc-swarm\n');
      shell('git add .', tempRepo);
      shell('git commit -q -m "feat: cc-swarm auto-close commit"', tempRepo);
      const featureCommit = shell('git rev-parse HEAD', tempRepo);

      // Step (iii) — emit a merge with cc-swarm-shaped task_ref (node_id
      // only). The hub's `resolveMergeTaskRef` must backfill resource_id
      // from the swarm's defaultTaskGraph.
      await conn.callExtension('x-cascade/stream.merged', {
        source_stream_id: streamId,
        target_stream_id: 'main',
        merge_commit: featureCommit,
        agent_id: agentId,
        source_commit: featureCommit,
        strategy: 'merge-commit',
        metadata: {
          task_ref: { node_id: 'task-abc' },
        },
      });

      // Headline assertion: the cascade_stream_merged hub event arrived
      // with a *complete* task_ref. This is what the binder consumes.
      const sawMerged = await waitFor(
        () => mergedEvents.some(
          (e) =>
            (e.task_ref as Record<string, unknown> | undefined)?.['node_id'] ===
            'task-abc',
        ),
        5000,
      );
      expect(sawMerged).toBe(true);

      const mergedEvent = mergedEvents.find(
        (e) =>
          (e.task_ref as Record<string, unknown> | undefined)?.['node_id'] ===
          'task-abc',
      )!;
      const taskRef = mergedEvent.task_ref as Record<string, unknown>;
      expect(taskRef).toBeDefined();
      // The resource_id MUST have been backfilled from the default task graph.
      expect(taskRef.resource_id).toBe(resolvedResourceId);
      expect(taskRef.node_id).toBe('task-abc');

      // Belt: the daemon-client mock was called with the exact tuple the
      // binder's routing contract promises.
      const sawDaemonCall = await waitFor(
        () => daemonUpdateTask.mock.calls.length > 0,
        5000,
      );
      expect(sawDaemonCall).toBe(true);
      const [socketArg, taskIdArg, updatesArg, localPathArg] = daemonUpdateTask.mock.calls[0]!;
      expect(socketArg).toBe('/tmp/fake-cc-swarm-socket');
      expect(taskIdArg).toBe('task-abc');
      expect(updatesArg).toEqual({ status: 'completed' });
      expect(localPathArg).toBe(opentasksDir);

      closeCascadeTracker(tracker);
      await conn.disconnect();
      const idx = activeConns.indexOf(conn);
      if (idx >= 0) activeConns.splice(idx, 1);
    } finally {
      mapHubEvents.off('cascade_stream_merged', captureMerged);
      stopTaskBinder();
    }
  }, 60_000);
});
