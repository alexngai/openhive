/**
 * Live Agent E2E — Scheduler-initiated dispatch lifecycle reaches terminal
 *
 * Asserts the full scheduler-initiated pipeline runs end-to-end with a real
 * macro-agent subprocess:
 *
 *   tick → fire handler → dispatch row (initiator_id='schedule:<id>')
 *     → orchestrator claim → mail-route to worker → agent processes
 *     → done() → reply mail turn captured → dispatch reaches terminal
 *
 * Bars this test asserts on (matches the existing user-initiated live test
 * bar — `live-mail-reuse-dispatch.test.ts`):
 *   - Scheduler fired (schedule.last_fired_at advanced)
 *   - Dispatch row created with `initiator_id='schedule:<id>'`
 *   - Agent's reply mail turn was captured (proves agent processed the
 *     scheduler-initiated envelope correctly)
 *   - Dispatch reaches a terminal state (complete | failed | cancelled)
 *
 * NOT asserted: strict `status === 'complete'`. Macro-agent's mail-inbound
 * consumer reports completion via `postMailTurn` (captured here), not via
 * an explicit `map/dispatches/report` RPC — so the status-flip path goes
 * through the orchestrator's event bridge, not via the agent. The existing
 * `live-mail-reuse-dispatch.test.ts` makes the same call.
 *
 * Architectural argument: scheduler-initiated dispatches are byte-identical
 * to user-initiated dispatches after the row is created — only the
 * `initiator_id` string differs. So if a user-initiated live dispatch round-
 * trips its agent reply (proven by existing tests), a scheduler-initiated
 * one does too. This test provides the direct datapoint for the latter.
 *
 * REQUIRES: LIVE_AGENT_E2E=true and an environment with Claude credentials
 * macro-agent can use (Claude Max etc).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import * as schedulesDAL from '../../db/dal/schedules.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService } from '../../map/token-service.js';
import {
  getAllInbound,
  getInbound,
} from '../../map/connection-registry.js';
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
import { createOpenHiveMailTransport, DISPATCHER_PARTICIPANT_ID } from '../../dispatch/mail-transport.js';
import { createOpenHiveMailPort } from '../../dispatch/openhive-mail-port.js';
import { setupOrchestrator } from '../../dispatch/setup.js';
import { setupMailCompletionObserver } from '../../dispatch/mail-completion.js';
import { setupScheduler, createOpenHiveSpecResolver } from '../../scheduler/setup.js';
import type { SpecContentFetcher } from '../../dispatch/openhive-source.js';
import type { Orchestrator, Scheduler } from 'swarm-dispatch';
import { ConfigSchema, type Config } from '../../config.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { setAcpAvailabilityProbe } from '../../dispatch/routing.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE_AGENT ? describe : describe.skip;

const TEST_ROOT = testRoot('live-scheduler-completion');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-scheduler-completion.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19980;
const PORT_RANGE_MAX = 19995;
const SERVER_PORT = 19996;

const SC_PREFIX = '/api/swarmcraft';
const SC_WS_PATH = '/ws/swarmcraft';

const SYNTHETIC_SPEC_RESOURCE_ID = 'res_live_sched_completion';
const SYNTHETIC_SPEC_ID = 'spec_live_sched_completion_001';

// Marker the agent must emit in its done() summary. Proves the agent
// actually executed the prompt (vs. crashing, aborting, or replying with
// arbitrary content). Same technique as live-mail-reuse-dispatch's
// SENTINEL/SKILL_MARKER assertions — content-level evidence of execution.
const SCHEDULER_E2E_MARKER = 'SCHEDULER_E2E_OK_X9F3K';

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
      name: 'Live Scheduler Completion E2E',
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
      iamSecret: 'test-iam-secret-scheduler-completion',
    },
    swarmcraft: { enabled: true, prefix: SC_PREFIX, wsPath: SC_WS_PATH },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      openswarm_command: 'npx openswarm serve',
      data_dir: TEST_DATA_DIR,
      port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX],
      max_swarms: 2,
      health_check_interval: 600_000,
      max_health_failures: 3,
      auto_restart: false,
      credentials: { inherit_env: true },
    },
    // Scheduler config — fast tick so the schedule fires within seconds
    scheduler: {
      tickIntervalMs: 1_000,
      maxConcurrentFires: 5,
      maxSchedulesPerAgent: 100,
    },
  });
}

describeIf(
  'Live Agent E2E — scheduler-initiated dispatch reaches `complete`',
  () => {
    let app: FastifyInstance;
    let config: Config;
    let swarmManager: SwarmManager;
    let testAgent: { id: string; apiKey: string };
    let swarmId: string | undefined;
    let assignedPort: number | undefined;
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
      // Bootstrap a coordinator AND a parented worker so the dispatch has
      // a known mail target ready when the schedule first fires.
      process.env.MACRO_BOOTSTRAP_COORDINATOR = 'true';
      process.env.MACRO_BOOTSTRAP_WORKER = 'true';

      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
      initDatabase(TEST_DB_PATH);
      _resetCacheForTest();
      await initMail();

      config = createTestConfig();
      initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

      const agentResult = await agentsDAL.createAgent({
        name: 'live-sched-completion-owner',
        description: 'Owner for live scheduler completion E2E',
        is_admin: true,
      });
      testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
      setLocalAgent(agentResult.agent);

      hivesDAL.createHive({
        name: 'live-sched-completion-hive',
        description: 'Hive for live scheduler completion E2E',
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
      const sc = (app as unknown as {
        swarmcraft: {
          db: unknown;
          wsHub: unknown;
          positionService: unknown;
          trajectoryService: unknown;
          mapClientManager: unknown;
          acpStreamManager: unknown;
        };
      }).swarmcraft;
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

      // Auth pre-handler: map bearer token to the test owner agent.
      const agentsByKey = new Map<string, { id: string; name: string }>();
      agentsByKey.set(testAgent.apiKey, {
        id: testAgent.id,
        name: 'live-sched-completion-owner',
      });
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
      console.log(`[live-sched-completion] OpenHive listening on port ${SERVER_PORT}`);

      // Wire mail-turn capture BEFORE spawning. This is the same approach
      // `live-mail-reuse-dispatch.test.ts` uses to verify agent reply
      // round-trip without depending on an explicit dispatch.status flip.
      const mailEvts = getMailEvents();
      const onTurnAdded = (turn: unknown): void => {
        if (turn && typeof turn === 'object') {
          capturedTurns.push(turn as (typeof capturedTurns)[number]);
        }
      };
      mailEvts.on('mail.turn.added', onTurnAdded);
      mailListenerCleanup = () => mailEvts.off('mail.turn.added', onTurnAdded);

      // Wire the mail-route completion observer. Without this, mail-route
      // dispatches sit at `running` until the stall timeout — see
      // `src/dispatch/mail-completion.ts`.
      mailCompletionCleanup = setupMailCompletionObserver({
        getMailEvents: () => mailEvts,
      });

      console.log('[live-sched-completion] Spawning macro-agent...');
      const hosted = await swarmManager.spawn(testAgent.id, {
        name: 'live-sched-completion-swarm',
        adapter: 'macro-agent',
        hive: 'live-sched-completion-hive',
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
      assignedPort = hosted.assigned_port!;
      hostedSwarmId = hosted.id;
      console.log(
        `[live-sched-completion] Swarm spawned: ${hosted.id}, port=${assignedPort}`,
      );

      // Wait for sidecar.
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
        console.warn(`[live-sched-completion] Sidecar did not connect in 60s. Logs:\n${logs}`);
        return;
      }

      // Wait for bootstrap coordinator + worker.
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
      if (bootstrapReady) {
        console.log(
          '[live-sched-completion] Bootstrap coordinator + worker registered',
        );
      } else {
        const logs = await swarmManager
          .getLogs(hosted.id, testAgent.id, { lines: 30 })
          .catch(() => '(no logs)');
        console.warn(
          `[live-sched-completion] Bootstrap not fully ready in 60s. Logs:\n${logs}`,
        );
      }

      await sleep(1_000);
    }, 180_000);

    afterAll(async () => {
      if (scheduler) {
        try { await scheduler.stop(); } catch { /* best effort */ }
      }
      if (orchestrator) {
        try { await orchestrator.stop(); } catch { /* best effort */ }
      }
      mailListenerCleanup?.();
      mailCompletionCleanup?.();
      if (swarmManager) {
        await swarmManager.shutdown();
      }
      try {
        stopMapWebSocket();
      } catch { /* best effort */ }
      try {
        await app?.close();
      } catch { /* best effort */ }
      try {
        closeDatabase();
      } catch { /* best effort */ }
      cleanTestRoot(TEST_ROOT);
      // Restore env.
      if (originalHome === undefined) delete process.env.OPENHIVE_HOME;
      else process.env.OPENHIVE_HOME = originalHome;
      if (originalBootstrap === undefined) delete process.env.MACRO_BOOTSTRAP_COORDINATOR;
      else process.env.MACRO_BOOTSTRAP_COORDINATOR = originalBootstrap;
      if (originalBootstrapWorker === undefined) delete process.env.MACRO_BOOTSTRAP_WORKER;
      else process.env.MACRO_BOOTSTRAP_WORKER = originalBootstrapWorker;
    }, 60_000);

    it(
      'a schedule fires → dispatch row created → agent processes → reply captured → dispatch reaches terminal',
      async () => {
        if (!swarmId) throw new Error('Test setup did not produce a swarmId');

        // ── 1. Seed a syncable_resources row matching the schedule's
        // payload.spec_ref. createOpenHiveSpecResolver does an
        // existence-only check via findResourceById — this row makes it
        // pass without needing an opentasks daemon.
        const db = (await import('../../db/index.js')).getDatabase();
        db.prepare(
          `INSERT OR IGNORE INTO syncable_resources (
             id, resource_type, name, git_remote_url, owner_agent_id
           ) VALUES (?, 'task', ?, ?, ?)`,
        ).run(
          SYNTHETIC_SPEC_RESOURCE_ID,
          'live-sched-completion-resource',
          `local://${SYNTHETIC_SPEC_RESOURCE_ID}`,
          testAgent.id,
        );

        // ── 2. Synthetic spec content — agent must call done() AND emit
        // the marker. The marker assertion below proves the agent
        // actually executed the prompt rather than aborting or emitting
        // an error reply.
        const specFetcher: SpecContentFetcher = {
          async fetch(_resourceId: string, _specId: string) {
            return {
              title: 'Scheduler Completion E2E',
              content: [
                'You are confirming end-to-end scheduler delivery.',
                'Call the `done` tool from the macro-agent MCP server with:',
                '  - status="completed"',
                `  - summary containing the literal token ${SCHEDULER_E2E_MARKER}`,
                'No other actions required.',
              ].join('\n'),
              tasks: [],
              metadata: {},
            };
          },
        };

        // ── 3. Wire orchestrator (prefer-route mail) and start it.
        const mailTransport = createOpenHiveMailTransport({
          getMailJsonRpc,
          getMailStorage,
          getMailEvents,
          sendToSwarm,
        });
        const messagePort = createOpenHiveMailPort(mailTransport, {
          mailLifecycleDefault: 'reuse',
        });

        const sc = (app as unknown as {
          swarmcraft: { acpStreamManager: unknown };
        }).swarmcraft;
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
        console.log('[live-sched-completion] Orchestrator started');

        // ── 4. Wire the scheduler. Use the production fire handler +
        // existence-only fetchSpec (the same factory openhive's
        // server.ts uses). The scheduler tick is fast (1s) so the
        // schedule fires within seconds of `next_fires_at`.
        scheduler = setupScheduler({
          fetchSpec: createOpenHiveSpecResolver({
            findResourceById: (id) => {
              return db
                .prepare('SELECT id FROM syncable_resources WHERE id = ?')
                .get(id) as { id: string } | null;
            },
          }),
          isAutonomousDispatchPaused: () => false,
          tickIntervalMs: config.scheduler.tickIntervalMs,
          maxConcurrentFires: config.scheduler.maxConcurrentFires,
        });
        scheduler.start();
        console.log('[live-sched-completion] Scheduler started');

        // ── 5. Insert a schedule whose first fire is 1s in the past, so
        // the next tick fires it immediately. Future fires won't matter
        // because we tear down within minutes.
        const created = schedulesDAL.createSchedule({
          cron: '*/5 * * * *', // every 5 minutes (irrelevant — we only need the first fire)
          payload: {
            spec_ref: {
              resource_id: SYNTHETIC_SPEC_RESOURCE_ID,
              spec_id: SYNTHETIC_SPEC_ID,
            },
            target_swarm_ids: [swarmId],
          },
          next_fires_at: new Date(Date.now() - 1_000).toISOString(),
          hive_id: '',
          initiator_type: 'user',
          initiator_id: testAgent.id,
        });
        console.log(`[live-sched-completion] Schedule created: ${created.id}`);

        // ── 6. Wait for the schedule to fire AND produce a dispatch row.
        const initiatorMarker = `schedule:${created.id}`;
        const dispatchAppeared = await waitFor(
          () => {
            const list = dispatchesDAL.listDispatches({
              initiator_id: initiatorMarker,
              limit: 5,
            });
            return list.data.length > 0;
          },
          30_000,
          500,
        );
        expect(dispatchAppeared, 'expected scheduler to produce a dispatch within 30s').toBe(
          true,
        );

        const dispatches = dispatchesDAL.listDispatches({
          initiator_id: initiatorMarker,
          limit: 5,
        });
        expect(dispatches.data.length).toBeGreaterThanOrEqual(1);
        const dispatch = dispatches.data[0];
        console.log(
          `[live-sched-completion] Dispatch produced: ${dispatch.id} (status=${dispatch.status})`,
        );
        expect(dispatch.initiator_id).toBe(initiatorMarker);
        expect(dispatch.initiator_type).toBe('agent');

        // Also assert the schedule itself advanced.
        const afterFire = schedulesDAL.findScheduleById(created.id)!;
        expect(afterFire.last_fired_at).not.toBeNull();

        // ── 7. Wait for the agent's reply mail turn to come back. This is
        // the same evidence the existing live-mail-reuse test asserts on
        // — proves the agent received the dispatch envelope, processed it,
        // and replied. The reply turn's participant_id is NOT the
        // dispatcher; it's a real agent id from the swarm.
        const replyReceived = await waitFor(
          () => {
            return capturedTurns.some(
              (turn) =>
                turn.participant_id !== 'dispatcher' &&
                turn.participant_id !== '' &&
                turn.participant_id != null,
            );
          },
          300_000,
          2_000,
        );

        const finalDispatch = dispatchesDAL.findDispatchById(dispatch.id)!;
        console.log(
          `[live-sched-completion] Final dispatch status: ${finalDispatch.status}; ` +
            `captured turns: ${capturedTurns.length}; ` +
            `reply received: ${replyReceived}`,
        );

        if (!replyReceived) {
          const logs = await swarmManager
            .getLogs(hostedSwarmId!, testAgent.id, { lines: 200 })
            .catch(() => '(no logs)');
          console.warn(
            `[live-sched-completion] Agent reply was NOT captured.\n` +
              `  finalStatus=${finalDispatch.status}\n` +
              `  attempts_history=${JSON.stringify(finalDispatch.attempts_history)}\n` +
              `  capturedTurns=${capturedTurns.length}\n\n` +
              `Macro-agent logs:\n${logs.slice(-6000)}`,
          );
        }

        // ── 8. Wait for dispatch.status to reach `complete`. With the
        // mail-completion observer wired in beforeAll, the agent's reply
        // turn → in-flight-dispatch lookup → finalizeDispatch path
        // should fire within seconds of the reply being captured.
        const dispatchComplete = await waitFor(
          () => {
            const d = dispatchesDAL.findDispatchById(dispatch.id);
            return d?.status === 'complete';
          },
          30_000,
          1_000,
        );
        const trulyFinal = dispatchesDAL.findDispatchById(dispatch.id)!;
        console.log(
          `[live-sched-completion] After completion-observer wait: status=${trulyFinal.status}`,
        );

        // ── 9. Content-level proof: the agent emitted the marker in its
        // reply, proving it actually executed the prompt (not just
        // crashed-and-the-bridge-synthesized-an-error-reply).
        const replyTurn = capturedTurns.find(
          (turn) =>
            turn.participant_id !== DISPATCHER_PARTICIPANT_ID &&
            turn.participant_id !== '' &&
            turn.participant_id != null,
        );
        const replyContent =
          replyTurn != null
            ? typeof replyTurn.content === 'string'
              ? replyTurn.content
              : JSON.stringify(replyTurn.content ?? '')
            : '';
        const markerSeen = replyContent.includes(SCHEDULER_E2E_MARKER);
        console.log(
          `[live-sched-completion] Marker seen in reply: ${markerSeen}; ` +
            `reply excerpt: ${replyContent.slice(0, 300)}`,
        );

        if (!markerSeen) {
          const logs = await swarmManager
            .getLogs(hostedSwarmId!, testAgent.id, { lines: 300 })
            .catch(() => '(no logs)');
          console.warn(
            `[live-sched-completion] Agent reply did not contain marker.\n` +
              `  reply=${replyContent}\n\n` +
              `Macro-agent logs:\n${logs.slice(-8000)}`,
          );
        }

        // ── 10. Hard assertions — full e2e, content-level proof:
        //   (a) Agent replied (envelope reached agent + agent processed)
        //   (b) Reply contains the marker we asked the agent to emit
        //       (agent actually executed the prompt, didn't just crash)
        //   (c) Dispatch flipped from `running` to `complete` (full
        //       lifecycle observation works)
        //   (d) Scheduler-specific evidence (initiator_id, last_fired_at)
        expect(replyReceived, 'agent should have replied to the scheduler-initiated dispatch').toBe(true);
        expect(markerSeen, `agent's reply should contain marker "${SCHEDULER_E2E_MARKER}"`).toBe(true);
        expect(dispatchComplete, 'dispatch should have flipped to complete via mail-completion observer').toBe(true);
        expect(trulyFinal.status).toBe('complete');
        expect(trulyFinal.initiator_id).toBe(initiatorMarker);
        expect(afterFire.last_fired_at).not.toBeNull();
      },
      // Test-level timeout: 6 minutes. Real-agent Claude calls can be slow.
      6 * 60 * 1000,
    );
  },
);
