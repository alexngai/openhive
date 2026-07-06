/**
 * Live Agent E2E — idea-lab role fires at a real agent (the full drive path).
 *
 * Proves the OpenHive drive path the idea-lab adds — that a role schedule
 * provisioned by `provisionIdeaLab` fires as a `dispatch_prompt`, produces a
 * correctly-attributed dispatch, and the orchestrator routes it to a real
 * connected agent:
 *
 *   provisionIdeaLab → role schedule (dispatch_prompt) → scheduler tick
 *     → fire handler → dispatch row (initiator_id='schedule:<id>')
 *     → orchestrator claim → mail-route (conversation attached) → agent swarm
 *
 * HARD assertions (all OpenHive-owned, deterministic):
 *   - provisionIdeaLab created the role schedule (unpaused, targeted)
 *   - the schedule fired (last_fired_at advanced) into a dispatch row with
 *     initiator_id='schedule:<id>'
 *   - the orchestrator claimed the dispatch (status left 'queued')
 *
 * BEST-EFFORT (logged, not asserted): the agent's reply turn + the marker we
 * asked the role to emit. Agent-side completion of a `dispatch_prompt` is a
 * macro-agent concern, not idea-lab's: in some environments the macro-agent's
 * reuse consumer races the worker consumer and finishes without calling
 * done(), and its own OpenTasks daemon may be unavailable. When those hold,
 * the marker appears; when they don't, the drive path is still proven. The
 * full agent-authoring loop (roles acting on shared state) is a separate,
 * heavier proof — see src/idea-lab/CLAUDE.md follow-ups.
 *
 * REQUIRES: LIVE_AGENT_E2E=true and Claude credentials the macro-agent can
 * use (Claude Max etc).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import * as schedulesDAL from '../../db/dal/schedules.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService } from '../../map/token-service.js';
import { getAllInbound, getInbound } from '../../map/connection-registry.js';
import { SwarmManager } from '../../swarm/manager.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { mapRoutes } from '../../api/routes/map.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { mailRoutes } from '../../api/routes/mail.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import {
  initMail,
  getMailJsonRpc,
  getMailStorage,
  getMailEvents,
} from '../../mail/index.js';
import { sendToSwarm } from '../../map/sync-listener.js';
import {
  createOpenHiveMailTransport,
  DISPATCHER_PARTICIPANT_ID,
} from '../../dispatch/mail-transport.js';
import { createOpenHiveMailPort } from '../../dispatch/openhive-mail-port.js';
import { setupOrchestrator } from '../../dispatch/setup.js';
import { setupMailCompletionObserver } from '../../dispatch/mail-completion.js';
import { setupScheduler, createOpenHiveSpecResolver } from '../../scheduler/setup.js';
import type { SpecContentFetcher } from '../../dispatch/openhive-source.js';
import type { Orchestrator, Scheduler } from 'swarm-dispatch';
import { ConfigSchema, type Config } from '../../config.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { setAcpAvailabilityProbe } from '../../dispatch/routing.js';
import {
  provisionIdeaLab,
  parseIdeaLabPack,
  IDEA_LAB_INITIATOR,
  roleKey,
} from '../../idea-lab/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE_AGENT ? describe : describe.skip;

const TEST_ROOT = testRoot('idea-lab-live-role');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'idea-lab-live-role.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19960;
const PORT_RANGE_MAX = 19975;
const SERVER_PORT = 19976;

const SC_PREFIX = '/api/swarmcraft';
const SC_WS_PATH = '/ws/swarmcraft';

// Marker the role prompt asks the agent to emit — content-level proof the
// agent executed the (verbatim) role prompt rather than crashing.
const IDEA_LAB_E2E_MARKER = 'IDEA_LAB_E2E_OK_Q7R2M';

// A test-only "ideator" role prompt: deterministic, single-turn, emits the
// marker. The production prompts drive multi-pass behavior; here we only need
// to prove the role reaches and runs on a real agent.
const TEST_IDEATOR_PROMPT = [
  'You are the ideator role in an autonomous idea lab (test run).',
  'Do exactly one thing: call the `done` tool from the macro-agent MCP server with',
  '  - status="completed"',
  `  - summary that brainstorms ONE new idea in a sentence, then appends the literal token ${IDEA_LAB_E2E_MARKER}`,
  'No other actions required.',
].join('\n');

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: {
      name: 'Idea-Lab Live Role E2E',
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
      iamSecret: 'test-iam-secret-idea-lab-live-role',
    },
    swarmcraft: { enabled: true, prefix: SC_PREFIX, wsPath: SC_WS_PATH },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      swarm_runner_command: 'npx @swarmkit-ai/swarm-runner serve',
      data_dir: TEST_DATA_DIR,
      port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX],
      max_swarms: 2,
      health_check_interval: 600_000,
      max_health_failures: 3,
      auto_restart: false,
      credentials: { inherit_env: true },
    },
    scheduler: {
      tickIntervalMs: 1_000,
      maxConcurrentFires: 5,
      maxSchedulesPerAgent: 100,
    },
  });
}

describeIf('Live Agent E2E — idea-lab role fires at a real agent', () => {
  let app: FastifyInstance;
  let config: Config;
  let swarmManager: SwarmManager;
  let testAgent: { id: string; apiKey: string };
  let swarmId: string | undefined;
  let hostedSwarmId: string | undefined;
  let orchestrator: Orchestrator | undefined;
  let scheduler: Scheduler | undefined;
  let mailListenerCleanup: (() => void) | undefined;
  let mailCompletionCleanup: (() => void) | undefined;
  const capturedTurns: Array<{
    conversation_id: string;
    participant_id: string;
    content_type: string;
    content: unknown;
  }> = [];
  const originalHome = process.env.OPENHIVE_HOME;
  const originalBootstrap = process.env.MACRO_BOOTSTRAP_COORDINATOR;
  const originalBootstrapWorker = process.env.MACRO_BOOTSTRAP_WORKER;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    process.env.MACRO_BOOTSTRAP_COORDINATOR = 'true';
    process.env.MACRO_BOOTSTRAP_WORKER = 'true';

    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    initDatabase(TEST_DB_PATH);
    _resetCacheForTest();
    await initMail();

    config = createTestConfig();
    initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

    const agentResult = await agentsDAL.createAgent({
      name: 'idea-lab-live-owner',
      description: 'Owner for idea-lab live role E2E',
      is_admin: true,
    });
    testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
    setLocalAgent(agentResult.agent);

    hivesDAL.createHive({
      name: 'idea-lab-live-hive',
      description: 'Hive for idea-lab live role E2E',
      owner_id: testAgent.id,
    });

    swarmManager = new SwarmManager(
      config.swarmHosting as unknown as SwarmHostingConfig,
      `http://127.0.0.1:${SERVER_PORT}`,
    );

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(fastifyWebsocket);
    setupMapWebSocket(app, config);

    const { swarmcraftPlugin } = await import('swarmcraft/plugin');
    await app.register(swarmcraftPlugin, {
      database: { type: 'sqlite', path: TEST_DB_PATH, tablePrefix: 'sc_' },
      prefix: SC_PREFIX,
      wsPath: SC_WS_PATH,
      logLevel: 'warn',
    });

    setAcpAvailabilityProbe(() => true);

    const { setupOpenHiveBridge } = await import('../../swarmcraft/bridge.js');
    const sc = (
      app as unknown as {
        swarmcraft: {
          db: unknown;
          wsHub: unknown;
          positionService: unknown;
          trajectoryService: unknown;
          mapClientManager: unknown;
          acpStreamManager: unknown;
        };
      }
    ).swarmcraft;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setupOpenHiveBridge({
      db: sc.db as any,
      wsHub: sc.wsHub as any,
      positionService: sc.positionService as any,
      trajectoryService: sc.trajectoryService as any,
      mapClientManager: sc.mapClientManager as any,
      acpStreamManager: sc.acpStreamManager as any,
      pipelineService: undefined,
    } as any);

    const agentsByKey = new Map<string, { id: string; name: string }>();
    agentsByKey.set(testAgent.apiKey, { id: testAgent.id, name: 'idea-lab-live-owner' });
    app.addHook(
      'preHandler',
      async (request: { headers: { authorization?: string }; agent?: unknown }) => {
        const auth = request.headers.authorization;
        if (auth?.startsWith('Bearer ')) {
          const agent = agentsByKey.get(auth.slice(7));
          if (agent) request.agent = agent;
        }
      },
    );

    (app as unknown as { swarmManager: SwarmManager }).swarmManager = swarmManager;

    await app.register(
      async (api) => {
        await api.register(mapRoutes, { config });
        await api.register(sessionsRoutes, { config });
        await api.register(mailRoutes, { config });
        await api.register(swarmHostingRoutes, { config } as never);
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
    console.log(`[idea-lab-live] OpenHive listening on port ${SERVER_PORT}`);

    const mailEvts = getMailEvents();
    const onTurnAdded = (turn: unknown): void => {
      if (turn && typeof turn === 'object') {
        capturedTurns.push(turn as (typeof capturedTurns)[number]);
      }
    };
    mailEvts.on('mail.turn.added', onTurnAdded);
    mailListenerCleanup = () => mailEvts.off('mail.turn.added', onTurnAdded);

    mailCompletionCleanup = setupMailCompletionObserver({
      getMailEvents: () => mailEvts,
    });

    console.log('[idea-lab-live] Spawning macro-agent...');
    const hosted = await swarmManager.spawn(testAgent.id, {
      name: 'idea-lab-live-swarm',
      adapter: 'macro-agent',
      hive: 'idea-lab-live-hive',
      metadata: { role: 'coordinator' },
      adapter_config: {
        dispatch: {
          enabled: true,
          enableMailRouting: true,
          dispatchMode: 'prefer-route',
          pollIntervalMs: 5_000,
          maxRetries: 1,
        },
      },
    });
    hostedSwarmId = hosted.id;
    console.log(`[idea-lab-live] Swarm spawned: ${hosted.id}, port=${hosted.assigned_port}`);

    const sidecarReady = await waitFor(() => {
      for (const [id, conn] of getAllInbound()) {
        if (conn.registeredAgents.size > 0) {
          swarmId = id;
          return true;
        }
      }
      return false;
    }, 60_000);
    if (!sidecarReady) {
      const logs = await swarmManager
        .getLogs(hosted.id, testAgent.id, { lines: 30 })
        .catch(() => '(no logs)');
      console.warn(`[idea-lab-live] Sidecar did not connect in 60s. Logs:\n${logs}`);
      return;
    }

    const bootstrapReady = await waitFor(() => {
      if (!swarmId) return false;
      const conn = getInbound(swarmId);
      if (!conn) return false;
      let hasCoord = false;
      let hasWorker = false;
      for (const agent of conn.registeredAgents.values()) {
        if (agent.role === 'coordinator') hasCoord = true;
        if (agent.role === 'worker') hasWorker = true;
      }
      return hasCoord && hasWorker;
    }, 60_000);
    console.log(
      `[idea-lab-live] Bootstrap ready: ${bootstrapReady} (coordinator + worker registered)`,
    );

    await sleep(1_000);
  }, 180_000);

  afterAll(async () => {
    if (scheduler) {
      try {
        await scheduler.stop();
      } catch {
        /* best effort */
      }
    }
    if (orchestrator) {
      try {
        await orchestrator.stop();
      } catch {
        /* best effort */
      }
    }
    mailListenerCleanup?.();
    mailCompletionCleanup?.();
    if (swarmManager) await swarmManager.shutdown();
    try {
      stopMapWebSocket();
    } catch {
      /* best effort */
    }
    try {
      await app?.close();
    } catch {
      /* best effort */
    }
    try {
      closeDatabase();
    } catch {
      /* best effort */
    }
    cleanTestRoot(TEST_ROOT);
    if (originalHome === undefined) delete process.env.OPENHIVE_HOME;
    else process.env.OPENHIVE_HOME = originalHome;
    if (originalBootstrap === undefined) delete process.env.MACRO_BOOTSTRAP_COORDINATOR;
    else process.env.MACRO_BOOTSTRAP_COORDINATOR = originalBootstrap;
    if (originalBootstrapWorker === undefined) delete process.env.MACRO_BOOTSTRAP_WORKER;
    else process.env.MACRO_BOOTSTRAP_WORKER = originalBootstrapWorker;
  }, 60_000);

  it(
    'provisionIdeaLab role schedule fires → dispatch (schedule initiator) → orchestrator routes to real agent',
    async () => {
      if (!swarmId) throw new Error('Test setup did not produce a swarmId');
      const db = getDatabase();

      // ── 1. Orchestrator (prefer-route mail). specFetcher is unused for
      // dispatch_prompt (the role prompt IS the seed), but the type requires
      // one — throw if it is ever consulted so misuse is loud.
      const specFetcher: SpecContentFetcher = {
        async fetch() {
          throw new Error('specFetcher should not be called for a dispatch_prompt role');
        },
      };
      const mailTransport = createOpenHiveMailTransport({
        getMailJsonRpc,
        getMailStorage,
        getMailEvents,
        sendToSwarm,
      });
      const messagePort = createOpenHiveMailPort(mailTransport, {
        mailLifecycleDefault: 'reuse',
      });
      const sc = (app as unknown as { swarmcraft: { acpStreamManager: unknown } }).swarmcraft;
      orchestrator = setupOrchestrator({
        specFetcher,
        runtimeDeps: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getAcpStreamManager: () => sc.acpStreamManager as any,
        },
        messagePort,
        dispatchMode: 'prefer-route',
        dispatchConfig: {
          pollIntervalMs: 1_000,
          globalConcurrency: 1,
          retry: { maxRetries: 0, baseDelayMs: 1_000, maxDelayMs: 5_000 },
          reconcileIntervalMs: 30_000,
          scorer: 'noop',
        },
      });
      await orchestrator.start();

      // ── 2. Scheduler with the production fire handler.
      scheduler = setupScheduler({
        fetchSpec: createOpenHiveSpecResolver({
          findResourceById: (id) =>
            db.prepare('SELECT id FROM syncable_resources WHERE id = ?').get(id) as
              | { id: string }
              | null,
        }),
        isAutonomousDispatchPaused: () => false,
        tickIntervalMs: config.scheduler.tickIntervalMs,
        maxConcurrentFires: config.scheduler.maxConcurrentFires,
      });
      scheduler.start();

      // ── 3. Provision the lab with a single test "ideator" role, targeted
      // at the live swarm. This exercises the real provisioner end-to-end
      // (resource upsert + schedule creation, keyed + idempotent). No
      // objectives → no OpenTasks daemon needed for this drive-path test.
      const pack = parseIdeaLabPack({
        version: 1,
        graph: { name: 'idea-lab/graph' },
        ledger: { name: 'idea-lab/ledger' },
        objectives: [],
        roles: [{ key: 'ideator', cron: '*/5 * * * *', prompt: TEST_IDEATOR_PROMPT }],
      });
      const summary = await provisionIdeaLab({
        dataDir: TEST_ROOT,
        pack,
        hiveId: '',
        targetSwarmIds: [swarmId],
      });
      expect(summary.ok).toBe(true);
      expect(summary.schedules.created).toBe(1);
      expect(summary.schedules.paused).toBe(0);

      // Find the provisioned role schedule and pull its first fire into the
      // past so the next tick fires it immediately.
      const labScheds = schedulesDAL.listSchedules({
        initiator_id: IDEA_LAB_INITIATOR,
        limit: 10,
      }).data;
      const roleSched = labScheds.find((s) => {
        const p = typeof s.payload === 'string' ? JSON.parse(s.payload) : (s.payload as Record<string, unknown>);
        return p.idealab_key === roleKey('ideator');
      });
      expect(roleSched, 'provisioned ideator role schedule should exist').toBeTruthy();
      schedulesDAL.updateSchedule(roleSched!.id, {
        next_fires_at: new Date(Date.now() - 1_000).toISOString(),
      });
      console.log(`[idea-lab-live] Role schedule ${roleSched!.id} armed to fire now`);

      // ── 4. Wait for the fire → dispatch row.
      const initiatorMarker = `schedule:${roleSched!.id}`;
      const dispatchAppeared = await waitFor(
        () =>
          dispatchesDAL.listDispatches({ initiator_id: initiatorMarker, limit: 5 }).data
            .length > 0,
        30_000,
        500,
      );
      expect(dispatchAppeared, 'expected the role schedule to produce a dispatch within 30s').toBe(
        true,
      );
      const dispatch = dispatchesDAL.listDispatches({
        initiator_id: initiatorMarker,
        limit: 5,
      }).data[0];
      console.log(`[idea-lab-live] Dispatch produced: ${dispatch.id} (status=${dispatch.status})`);
      expect(dispatch.initiator_id).toBe(initiatorMarker);

      const afterFire = schedulesDAL.findScheduleById(roleSched!.id)!;
      expect(afterFire.last_fired_at).not.toBeNull();

      // ── 5. Best-effort: give the agent a bounded window to reply. Not
      // asserted (see header) — kept short so the drive-path assertions below
      // are always reached well within the test timeout.
      const replyReceived = await waitFor(
        () =>
          capturedTurns.some(
            (t) =>
              t.participant_id !== DISPATCHER_PARTICIPANT_ID &&
              t.participant_id !== '' &&
              t.participant_id != null,
          ),
        60_000,
        2_000,
      );

      // ── 6. Best-effort content-level observation: the marker the role
      // asked the agent to emit. Logged, not asserted (see header).
      const replyTurn = capturedTurns.find(
        (t) =>
          t.participant_id !== DISPATCHER_PARTICIPANT_ID &&
          t.participant_id !== '' &&
          t.participant_id != null,
      );
      const replyContent =
        replyTurn != null
          ? typeof replyTurn.content === 'string'
            ? replyTurn.content
            : JSON.stringify(replyTurn.content ?? '')
          : '';
      const markerSeen = replyContent.includes(IDEA_LAB_E2E_MARKER);
      if (!replyReceived) {
        const logs = await swarmManager
          .getLogs(hostedSwarmId!, testAgent.id, { lines: 200 })
          .catch(() => '(no logs)');
        console.warn(
          `[idea-lab-live] Agent reply not captured (best-effort). Macro-agent logs:\n${logs.slice(-4000)}`,
        );
      }
      console.log(
        `[idea-lab-live] agent reply captured=${replyReceived} marker=${markerSeen}; ` +
          `excerpt: ${replyContent.slice(0, 200)}`,
      );

      // ── 7. Confirm the orchestrator claimed + routed the role dispatch
      // (status leaves 'queued'). This is the far end of the OpenHive drive
      // path — the role reached routing toward the real agent.
      const claimed = await waitFor(
        () => {
          const d = dispatchesDAL.findDispatchById(dispatch.id);
          return d != null && d.status !== 'queued';
        },
        60_000,
        1_000,
      );
      const finalDispatch = dispatchesDAL.findDispatchById(dispatch.id)!;
      console.log(`[idea-lab-live] Dispatch claimed=${claimed} final status=${finalDispatch.status}`);

      // ── 8. HARD assertions — the OpenHive drive path (deterministic).
      expect(summary.schedules.created).toBe(1);
      expect(dispatch.initiator_id).toBe(initiatorMarker);
      expect(afterFire.last_fired_at).not.toBeNull();
      expect(claimed, 'orchestrator should claim + route the role dispatch off the queue').toBe(true);
    },
    6 * 60 * 1000,
  );
});
