/**
 * Live Agent E2E: Mail + lifecycle='reuse' Dispatch Flow
 *
 * The mail-route mirror of `live-acp-reuse-dispatch.test.ts`. Where that
 * exercises ACP transport + reuse lifecycle (existing ACP coordinator
 * processes the dispatch via its existing session), this test exercises
 * MAIL transport + reuse lifecycle:
 *
 *   1. The swarm boots with `MACRO_BOOTSTRAP_COORDINATOR=true` so a
 *      long-lived agent registers immediately with `messaging.canReceive: true`
 *      per-agent. This is the agent that will be REUSED.
 *
 *   2. The dispatch row carries `mail_lifecycle: 'reuse'`, which makes the
 *      hub mail port pass-through to the prefer-route choice (the
 *      bootstrap coord, since it's non-busy and matches the role).
 *
 *   3. The orchestrator routes via `prefer-route`. The hub mail-transport
 *      sees the worker has `messaging.canReceive` per-agent (but no
 *      `mail.canJoin`), so it routes via the `map/dispatch/message`
 *      JSON-RPC notification with `to_agent_id: <hub-assigned ULID>`.
 *
 *   4. The macro-agent sidecar's NEW `map/dispatch/message` handler
 *      translates the hub ULID → local agent id and delivers the envelope
 *      into the local inbox under that agent's local id.
 *
 *   5. The new `mail-inbound-reuse-consumer` filters envelopes addressed
 *      to non-sidecar agents, drives the existing session via
 *      `agentManager.prompt()` (NOT `promptUntilDone` — that auto-
 *      terminates), captures `args.summary` from done() inline, posts
 *      back as a mail turn via `mapSidecar.postMailTurn`.
 *
 *   6. The reply turn lands in the hub's mail conversation; the test's
 *      `mail.turn.added` listener captures it; we assert markers in the
 *      content.
 *
 * Capability semantics (the same advisory tradeoff as ACP+reuse):
 *
 *   ✅ Addendum reaches the agent (SENTINEL in reply)
 *   ✅ Skill catalog reaches the agent (SKILL_MARKER)
 *   ✅ MCP tools work (AGENT_COUNT>0)
 *   ❌ Loadout permissions are NOT enforced — the existing coordinator's
 *      Claude session was created at boot, before this loadout was
 *      authored. PERM_DENIED intentionally NOT asserted.
 *
 * The test asserts the three positive markers; PERM_DENIED is in the
 * loadout to verify that shipping it through the wire does NOT crash
 * the reuse path.
 *
 * No new ACP-capable agent should appear during the test — we assert
 * that the orchestrator did NOT spawn a fresh coordinator.
 *
 * REQUIRES: LIVE_AGENT_E2E=true
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
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
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
import { teamsRoutes } from '../../api/routes/teams.js';
import { loadoutsRoutes } from '../../api/routes/loadouts.js';
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
import type { SpecContentFetcher } from '../../dispatch/openhive-source.js';
import type { Orchestrator } from 'swarm-dispatch';
import { ConfigSchema, type Config } from '../../config.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { setAcpAvailabilityProbe } from '../../dispatch/routing.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import {
  createTestSkillBank,
  MARKER_SKILL,
  SKILL_MARKER,
} from '../helpers/skill-bank-fixture.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE_AGENT ? describe : describe.skip;

const TEST_ROOT = testRoot('live-mail-reuse-dispatch');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-mail-reuse.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19960;
const PORT_RANGE_MAX = 19975;
const SERVER_PORT = 19978;

const SC_PREFIX = '/api/swarmcraft';
const SC_WS_PATH = '/ws/swarmcraft';

const SYNTHETIC_SPEC_RESOURCE_ID = 'res_live_mail_reuse_spec';
const SYNTHETIC_SPEC_ID = 'spec_live_mail_reuse_001';

const SENTINEL = 'WIDGET_SENTINEL_43';

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch { /* ignore */ }
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
      name: 'Live Mail Reuse Dispatch E2E',
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
      iamSecret: 'test-iam-secret-mail-reuse',
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
  });
}

function buildLoadoutContent(skillBankRef?: string): LoadoutContent {
  const base: LoadoutContent = {
    name: 'live-mail-reuse-loadout',
    description: 'Loadout for live mail+reuse E2E',
    capabilities: [],
    permissions: {
      allow: [],
      // Included to verify wire shipping works on reuse path. NOT asserted
      // (would require a fresh session — see test docstring).
      deny: ['Bash(echo perm-deny-test:*)'],
    },
    mcp_servers: ['agent-inbox'],
    prompt_addendum: [
      `You have three required tasks. Complete all three, then end your turn by calling the \`done\` tool from the macro-agent MCP server.`,
      ``,
      `Task 1 — Skill consumption: Read your <available_skills> section. If you find a skill named "Marker Skill", extract the marker token from its description (a token like SKILL_MARKER_*).`,
      ``,
      `Task 2 — MCP invocation: Call the \`list_agents\` tool from the agent-inbox MCP server. Note the count of agents returned.`,
      ``,
      `Task 3 — Reply via done: Call \`done\` with status="completed" and a summary that contains, in order:`,
      `  - "${SENTINEL}" at the very start`,
      `  - The marker token from Task 1 (verbatim, e.g. ${SKILL_MARKER})`,
      `  - "AGENT_COUNT=N" (N is the integer count from Task 2)`,
      ``,
      `Example summary: "${SENTINEL} ${SKILL_MARKER} AGENT_COUNT=2"`,
    ].join('\n'),
  };
  if (skillBankRef) {
    return {
      ...base,
      skills: { include: [MARKER_SKILL.id] },
      openhive: { skillBankRef },
    } as LoadoutContent;
  }
  return base;
}

function buildTeamContent(skillBankRef?: string): TeamTemplateContent {
  return {
    manifest: {
      name: 'live-mail-reuse-team',
      version: 1,
      roles: ['coordinator'],
      topology: { root: { role: 'coordinator' } },
    },
    roles: { coordinator: { loadout: buildLoadoutContent(skillBankRef) } },
    loadouts: {},
    prompts: {},
  };
}

describeIf(
  'Live Agent E2E — Mail + lifecycle=reuse: existing coordinator processes dispatch via mail turn',
  () => {
    let app: FastifyInstance;
    let config: Config;
    let swarmManager: SwarmManager;
    let testAgent: { id: string; apiKey: string };
    let swarmId: string | undefined;
    let assignedPort: number | undefined;
    let hostedSwarmId: string | undefined;
    let orchestrator: Orchestrator | undefined;
    let mailTransportCleanup: (() => void) | undefined;
    let skillBankId: string | undefined;
    const originalHome = process.env.OPENHIVE_HOME;
    const originalBootstrap = process.env.MACRO_BOOTSTRAP_COORDINATOR;

    // Captured mail turns. The reuse-consumer's reply path posts a mail
    // turn back via `mapSidecar.postMailTurn`, which lands here as a
    // `mail.turn.added` event. Asserted markers must appear in turn
    // content where `participant_id !== DISPATCHER_PARTICIPANT_ID`.
    const capturedTurns: Array<{
      conversation_id: string;
      participant_id: string;
      content_type: string;
      content: unknown;
    }> = [];

    beforeAll(async () => {
      cleanTestRoot(TEST_ROOT);
      process.env.OPENHIVE_HOME = TEST_ROOT;
      process.env.MACRO_BOOTSTRAP_COORDINATOR = 'true';

      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
      initDatabase(TEST_DB_PATH);
      _resetCacheForTest();
      await initMail();

      config = createTestConfig();
      initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

      const agentResult = await agentsDAL.createAgent({
        name: 'live-mail-reuse-owner',
        description: 'Owner for live mail+reuse E2E',
        is_admin: true,
      });
      testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
      setLocalAgent(agentResult.agent);

      skillBankId = createTestSkillBank({
        agentId: testAgent.id,
        bankDir: path.join(TEST_ROOT, 'skill-bank'),
        nameSuffix: '-live-mail-reuse',
      });

      hivesDAL.createHive({
        name: 'live-mail-reuse-hive',
        description: 'Hive for live mail+reuse E2E',
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sc = (app as any).swarmcraft;
      await setupOpenHiveBridge({
        db: sc.db,
        wsHub: sc.wsHub,
        positionService: sc.positionService,
        trajectoryService: sc.trajectoryService,
        mapClientManager: sc.mapClientManager,
        acpStreamManager: sc.acpStreamManager,
        pipelineService: undefined,
      });

      const agentsByKey = new Map<string, { id: string; name: string }>();
      agentsByKey.set(testAgent.apiKey, {
        id: testAgent.id,
        name: 'live-mail-reuse-owner',
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
          await api.register(teamsRoutes, { config });
          await api.register(loadoutsRoutes, { config });
          await api.register(swarmHostingRoutes, { config } as never);
        },
        { prefix: '/api/v1' },
      );

      await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
      console.log(`[live-mail-reuse] OpenHive listening on port ${SERVER_PORT}`);

      // Attach mail turn listener BEFORE spawning the swarm.
      const mailEvts = getMailEvents();
      const onTurnAdded = (turn: unknown): void => {
        if (turn && typeof turn === 'object') {
          capturedTurns.push(turn as (typeof capturedTurns)[number]);
        }
      };
      mailEvts.on('mail.turn.added', onTurnAdded);
      mailTransportCleanup = () => mailEvts.off('mail.turn.added', onTurnAdded);

      console.log(
        '[live-mail-reuse] Spawning real macro-agent swarm with bootstrap coordinator...',
      );
      const hosted = await swarmManager.spawn(testAgent.id, {
        name: 'live-mail-reuse-swarm',
        adapter: 'macro-agent',
        hive: 'live-mail-reuse-hive',
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
      console.log(`[live-mail-reuse] Swarm spawned: ${hosted.id}, port=${assignedPort}`);

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
        console.warn(`[live-mail-reuse] Sidecar did not connect in 60s. Logs:\n${logs}`);
        return;
      }

      const bootstrapReady = await waitFor(() => {
        if (!swarmId) return false;
        const conn = getInbound(swarmId);
        if (!conn) return false;
        for (const agent of conn.registeredAgents.values()) {
          // Long-lived non-sidecar agent — the one that will be reused.
          if (agent.role !== 'sidecar') return true;
        }
        return false;
      }, 60_000);

      if (bootstrapReady) {
        console.log('[live-mail-reuse] Bootstrap coordinator registered (will be reused)');
      }

      await sleep(1_000);
    }, 180_000);

    afterAll(async () => {
      if (orchestrator) {
        try { await orchestrator.stop(); } catch { /* best effort */ }
      }
      mailTransportCleanup?.();
      if (swarmManager) {
        await swarmManager.shutdown();
      }
      stopMapWebSocket();
      if (app) await app.close();
      setLocalAgent(null);
      closeDatabase();
      cleanTestRoot(TEST_ROOT);
      if (originalHome) process.env.OPENHIVE_HOME = originalHome;
      else delete process.env.OPENHIVE_HOME;
      if (originalBootstrap !== undefined) {
        process.env.MACRO_BOOTSTRAP_COORDINATOR = originalBootstrap;
      } else {
        delete process.env.MACRO_BOOTSTRAP_COORDINATOR;
      }
    }, 30_000);

    it(
      'existing coordinator handles mail-routed dispatch via reuse — markers in reply turn',
      async () => {
        expect(swarmId).toBeDefined();

        const ldtRes = await app.inject({
          method: 'POST',
          url: '/api/v1/loadouts',
          headers: { authorization: `Bearer ${testAgent.apiKey}` },
          payload: {
            name: 'live-mail-reuse-loadout',
            content: buildLoadoutContent(skillBankId),
          },
        });
        expect([201, 409]).toContain(ldtRes.statusCode);

        const tmplCreate = await app.inject({
          method: 'POST',
          url: '/api/v1/teams',
          headers: { authorization: `Bearer ${testAgent.apiKey}` },
          payload: {
            name: 'live-mail-reuse-team',
            content: buildTeamContent(skillBankId),
          },
        });
        expect([201, 409]).toContain(tmplCreate.statusCode);

        const tmpl = teamTemplatesDAL.getTeamTemplateByName(
          'live-mail-reuse-team',
          testAgent.id,
        );
        expect(tmpl).toBeTruthy();

        // Snapshot non-sidecar agent count BEFORE — must be unchanged after.
        const conn = getInbound(swarmId!)!;
        const nonSidecarBefore = [...conn.registeredAgents.values()].filter(
          (a) => a.role !== 'sidecar',
        );
        const beforeCount = nonSidecarBefore.length;
        console.log(`[live-mail-reuse] Non-sidecar agents BEFORE dispatch: ${beforeCount}`);
        expect(beforeCount).toBeGreaterThanOrEqual(1);

        const specFetcher: SpecContentFetcher = {
          async fetch(_resourceId: string, _specId: string) {
            return {
              title: 'Live Mail Reuse E2E Task',
              content: 'Execute the three tasks per the role addendum.',
              tasks: [],
              metadata: {
                team_role_ref: {
                  teamTemplateId: tmpl!.id,
                  role: 'coordinator',
                },
              },
            };
          },
        };

        const insertedDispatch = dispatchesDAL.createDispatch({
          spec_resource_id: SYNTHETIC_SPEC_RESOURCE_ID,
          spec_id: SYNTHETIC_SPEC_ID,
          target_swarm_id: swarmId!,
          initiator_type: 'user',
          initiator_id: testAgent.id,
          status: 'queued',
          // Explicit reuse — exercises the per-dispatch override even
          // though it matches the cluster default. Catches regressions in
          // the column → side-channel → mail-port plumbing.
          mail_lifecycle: 'reuse',
        });
        console.log(`[live-mail-reuse] Dispatch row inserted (id=${insertedDispatch.id})`);

        const realMailTransport = createOpenHiveMailTransport({
          getMailJsonRpc,
          getMailStorage,
          getMailEvents,
          sendToSwarm,
        });

        // Wrap sendToAgent so we can prove THIS dispatch's wire send hit
        // the right swarm+agent (and surface failures with their reason).
        const sendResults: Array<{
          swarmId: string;
          agentId: string;
          taskId?: string;
          delivered: boolean;
          reason?: string;
        }> = [];
        const mailTransport = {
          ...realMailTransport,
          async sendToAgent(swarmId: string, agentId: string, envelope: unknown) {
            const result = await realMailTransport.sendToAgent(
              swarmId,
              agentId,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              envelope as any,
            );
            const taskId = (envelope as { body?: { taskId?: string } })?.body?.taskId;
            sendResults.push({ swarmId, agentId, taskId, ...result });
            return result;
          },
        };
        const messagePort = createOpenHiveMailPort(mailTransport, {
          mailLifecycleDefault: 'reuse',
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sc = (app as any).swarmcraft;
        orchestrator = setupOrchestrator({
          specFetcher,
          runtimeDeps: {
            getAcpStreamManager: () => sc.acpStreamManager,
          },
          messagePort,
          // prefer-route is the natural mail+reuse mode — orchestrator
          // queries the roster for a non-busy worker matching the spec's
          // role/tags and routes the envelope there. Falls back to spawn
          // (ACP runtime) only if no roster match.
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
        console.log('[live-mail-reuse] Orchestrator started (prefer-route)');

        // Wait for the existing coord to process the dispatch and produce
        // a reply mail turn containing the three markers. Reply path:
        //   1. mail-bridge or map/dispatch/message handler delivers envelope
        //      to the local agent's inbox
        //   2. mail-inbound-reuse-consumer drives prompt() on the existing
        //      session, captures done() args.summary
        //   3. mapSidecar.postMailTurn(conv, agentId, summary) → hub
        //      mail.turn.added fires
        const waitMs = 120_000;
        console.log(
          `[live-mail-reuse] Waiting up to ${waitMs / 1000}s for reply mail turn...`,
        );
        // Reply turns are turns whose participant_id is NOT the dispatcher.
        // Without this filter, the outbound dispatch envelope (hub →
        // swarm) would itself match the markers — its prompt body
        // contains SENTINEL, SKILL_MARKER, and "AGENT_COUNT=2" verbatim
        // as the example summary in the loadout addendum text. The
        // markers must come from the agent's done() summary on the
        // INBOUND reply turn, which is what proves the agent processed
        // the dispatch.
        const isReplyTurn = (turn: { participant_id: string }): boolean =>
          turn.participant_id !== DISPATCHER_PARTICIPANT_ID;

        const turnContentString = (turn: { content: unknown }): string =>
          typeof turn.content === 'string'
            ? turn.content
            : JSON.stringify(turn.content ?? '');

        const allMarkersSeen = await waitFor(
          () => {
            for (const turn of capturedTurns) {
              if (!isReplyTurn(turn)) continue;
              const raw = turnContentString(turn);
              if (
                raw.includes(SENTINEL) &&
                raw.includes(SKILL_MARKER) &&
                /AGENT_COUNT\s*=\s*\d+/.test(raw)
              ) {
                return true;
              }
            }
            return false;
          },
          waitMs,
          1_000,
        );

        // Locate the reply turn for diagnostics + assertion.
        const replyTurn = capturedTurns.find(
          (turn) => isReplyTurn(turn) && turnContentString(turn).includes(SENTINEL),
        );
        const replyText = replyTurn
          ? typeof replyTurn.content === 'string'
            ? replyTurn.content
            : JSON.stringify(replyTurn.content ?? '')
          : '';

        console.log(
          `[live-mail-reuse] Captured turns: ${capturedTurns.length}\n` +
            `[live-mail-reuse] Reply excerpt: ${replyText.slice(0, 600)}`,
        );

        // After the dispatch — non-sidecar agent count must be unchanged.
        // The reuse path explicitly used the existing bootstrap coord; no
        // fresh worker should have spawned.
        const nonSidecarAfter = [...conn.registeredAgents.values()].filter(
          (a) => a.role !== 'sidecar',
        );
        const afterCount = nonSidecarAfter.length;
        console.log(`[live-mail-reuse] Non-sidecar agents AFTER dispatch: ${afterCount}`);

        if (!allMarkersSeen) {
          const logs = await swarmManager
            .getLogs(hostedSwarmId!, testAgent.id, { lines: 100 })
            .catch(() => '(unavailable)');
          console.warn(
            `[live-mail-reuse] Markers not all seen.\n` +
              `Reply turn: ${replyText}\n\nSendResults: ${JSON.stringify(
                sendResults,
              )}\n\nLogs:\n${logs.slice(-3000)}`,
          );
        }

        // ── Capability proofs (subset — permissions intentionally omitted) ──
        const sentinelSeen = replyText.includes(SENTINEL);
        const skillUsed = replyText.includes(SKILL_MARKER);
        const agentCountMatch = replyText.match(/AGENT_COUNT\s*=\s*(\d+)/);
        const mcpFollowThrough = agentCountMatch !== null;
        const reportedCount = mcpFollowThrough ? parseInt(agentCountMatch![1], 10) : null;
        const mcpActuallyInvoked = reportedCount !== null && reportedCount > 0;

        if (allMarkersSeen) {
          console.log(
            `[live-mail-reuse] CAPABILITY PROVEN — addendum: ${sentinelSeen}; ` +
              `skill: ${skillUsed}; mcp: AGENT_COUNT=${reportedCount}.\n` +
              `[live-mail-reuse] Permissions intentionally NOT asserted — see test docstring.`,
          );
        }

        // Hard assertions: prompt-body fields reach the agent + reply
        // round-trips back via the mail conversation.
        expect(sentinelSeen).toBe(true);
        expect(skillUsed).toBe(true);
        expect(mcpFollowThrough).toBe(true);
        expect(mcpActuallyInvoked).toBe(true);

        // Hard assertion: NO new agent spawned. The reuse path explicitly
        // used the existing bootstrap coord. If this fails, the lifecycle
        // hint plumbing somehow routed to fresh-spawn instead of reuse.
        expect(afterCount).toBe(beforeCount);
      },
      180_000,
    );
  },
);
