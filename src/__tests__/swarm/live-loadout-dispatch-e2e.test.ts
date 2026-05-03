/**
 * Live Agent E2E: Loadout Dispatch Flow
 *
 * Proves end-to-end: author a loadout → dispatch a spec with a team_role_ref
 * → macro-agent sidecar receives the materialized prompt via the mail port →
 * the delivered mail turn body contains the sentinel instruction from the
 * loadout's prompt_addendum.
 *
 * ─── Routing ────────────────────────────────────────────────────────────────
 *
 * When a swarm is spawned with `adapter: 'macro-agent'` and no team config,
 * only the sidecar registers — and the sidecar publishes sidecar-level
 * capabilities (mail.canJoin, messaging.canReceive, trajectory.canReport)
 * but NOT ACP (ACP is per-coordinator-agent and coordinators don't spawn
 * automatically). The dispatch orchestrator's `prefer-route` mode routes
 * via the mail port when no ACP target is present.
 *
 * ─── Observation point ──────────────────────────────────────────────────────
 *
 * We listen on the `mail.turn.added` event emitted by the mail module's
 * EventEmitter. This fires synchronously when `mail/turn` JSON-RPC completes —
 * i.e., immediately after the dispatch mail-transport deposits the work
 * envelope into the agent-inbox conversation. The turn body (JSON) must
 * contain the sentinel string from the loadout's prompt_addendum.
 *
 * This is Level 1 assertion: proves the full chain
 *   loadout DB → enrichWithLoadout → openHivePromptBuilder → mail port
 *   deliver() → agent-inbox → mail.turn.added event body
 * without requiring macro-agent to actually process the turn.
 *
 * ─── Spec creation ──────────────────────────────────────────────────────────
 *
 * We skip a real opentasks daemon. Instead we inject a dispatch row directly
 * via the DAL with a synthetic spec_resource_id / spec_id, and provide a
 * SpecContentFetcher stub that returns metadata containing the team_role_ref.
 * Identical to the approach used by dispatch-mail-routing.test.ts.
 *
 * ─── Constraints ────────────────────────────────────────────────────────────
 * REQUIRES: LIVE_AGENT_E2E=true
 * REQUIRES: real macro-agent (references/macro-agent built + available via npx openswarm)
 * REQUIRES: Claude Max plan or ANTHROPIC_API_KEY (the sidecar itself uses the API)
 *
 * Run:
 *   LIVE_AGENT_E2E=true npx vitest run \
 *     src/__tests__/swarm/live-loadout-dispatch-e2e.test.ts
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
import { getAllInbound, hasCapability } from '../../map/connection-registry.js';
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
  DISPATCH_CONVERSATION_SCOPE,
} from '../../dispatch/mail-transport.js';
import { createOpenHiveMailPort } from '../../dispatch/openhive-mail-port.js';
import { setupOrchestrator } from '../../dispatch/setup.js';
import type { SpecContentFetcher } from '../../dispatch/openhive-source.js';
import type { Orchestrator } from 'swarm-dispatch';
import { ConfigSchema, type Config } from '../../config.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { canRouteToSwarm } from '../../dispatch/routing.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

// ============================================================================
// Gate
// ============================================================================

const LIVE_AGENT = process.env.LIVE_AGENT_E2E === 'true';
const describeIf = LIVE_AGENT ? describe : describe.skip;

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('live-loadout-dispatch-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-loadout.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19910;
const PORT_RANGE_MAX = 19925;
const SERVER_PORT = 19926;

const SC_PREFIX = '/api/swarmcraft';
const SC_WS_PATH = '/ws/swarmcraft';

/**
 * The sentinel the delivered mail turn must contain.
 * Distinctive enough it cannot appear in ordinary output.
 * The loadout's prompt_addendum instructs the agent to prefix its response
 * with this string — this string is embedded in the materialized prompt that
 * the mail port delivers to the swarm's inbox.
 */
const SENTINEL = 'WIDGET_SENTINEL_42';

/**
 * Fake spec IDs used to seed the dispatch row.
 * These are synthetic — no real opentasks daemon is needed.
 */
const SYNTHETIC_SPEC_RESOURCE_ID = 'res_live_loadout_e2e_spec';
const SYNTHETIC_SPEC_ID = 'spec_live_loadout_e2e_001';

// ============================================================================
// Helpers
// ============================================================================

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
      /* ignore transient errors */
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
      name: 'Live Loadout Dispatch E2E',
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
      iamSecret: 'test-iam-secret-live-loadout',
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

/** The loadout content that the agent must demonstrably receive. */
function buildLoadoutContent(): LoadoutContent {
  return {
    name: 'live-dispatch-loadout',
    description: 'Loadout for live dispatch E2E',
    capabilities: [],
    permissions: { allow: [] },
    mcp_servers: [],
    prompt_addendum: [
      `SPECIAL INSTRUCTION: When you finish, call the \`done\` tool from the macro-agent MCP server with summary starting with "${SENTINEL}".`,
      `The summary string is what gets sent back as the reply, so the very first characters of the summary must be "${SENTINEL}".`,
      `Do this immediately — do not respond with text before calling done. Just call done({ status: "completed", summary: "${SENTINEL} ..." }) right away.`,
    ].join('\n'),
  };
}

/** A minimal team template that wraps the loadout under the 'executor' role. */
function buildTeamContent(): TeamTemplateContent {
  return {
    manifest: {
      name: 'live-dispatch-team',
      version: 1,
      roles: ['executor'],
      topology: { root: { role: 'executor' } },
    },
    roles: { executor: { loadout: buildLoadoutContent() } },
    loadouts: {},
    prompts: {},
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describeIf(
  'Live Agent E2E — Loadout dispatch flow reaches agent mail inbox',
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
    const originalHome = process.env.OPENHIVE_HOME;

    // Accumulated mail turns from mail.turn.added events.
    const capturedTurns: Array<{
      conversation_id: string;
      participant_id: string;
      content_type: string;
      content: unknown;
    }> = [];

    beforeAll(async () => {
      cleanTestRoot(TEST_ROOT);
      process.env.OPENHIVE_HOME = TEST_ROOT;
      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

      initDatabase(TEST_DB_PATH);
      _resetCacheForTest();

      await initMail();

      config = createTestConfig();

      // Token service required for hosted-swarm spawn (mints onboard token).
      initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

      const agentResult = await agentsDAL.createAgent({
        name: 'live-loadout-dispatch-owner',
        description: 'Owner for live loadout dispatch E2E',
        is_admin: true,
      });
      testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
      setLocalAgent(agentResult.agent);

      hivesDAL.createHive({
        name: 'live-dispatch-hive',
        description: 'Hive for live dispatch E2E',
        owner_id: testAgent.id,
      });

      swarmManager = new SwarmManager(
        config.swarmHosting as unknown as SwarmHostingConfig,
        `http://127.0.0.1:${SERVER_PORT}`,
      );

      // ── Build Fastify with all routes the dispatch flow needs ──────────
      app = Fastify({ logger: false });
      app.decorateRequest('agent');
      await app.register(fastifyWebsocket);

      setupMapWebSocket(app, config);

      // SwarmCraft plugin (provides acpStreamManager; also used by swarm-bridge).
      const { swarmcraftPlugin } = await import('swarmcraft/plugin');
      await app.register(swarmcraftPlugin, {
        database: { type: 'sqlite', path: TEST_DB_PATH, tablePrefix: 'sc_' },
        prefix: SC_PREFIX,
        wsPath: SC_WS_PATH,
        logLevel: 'warn',
      });

      // OpenHive → SwarmCraft bridge (MAP client events).
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
        pipelineService: sc.pipelineService,
      });

      // Auth hook so API routes recognise testAgent's key.
      const agentsByKey = new Map<string, { id: string; name: string }>();
      agentsByKey.set(testAgent.apiKey, {
        id: testAgent.id,
        name: 'live-loadout-dispatch-owner',
      });
      app.addHook('preHandler', async (request: { headers: { authorization?: string }; agent?: unknown }) => {
        const auth = request.headers.authorization;
        if (auth?.startsWith('Bearer ')) {
          const token = auth.slice(7);
          const agent = agentsByKey.get(token);
          if (agent) request.agent = agent;
        }
      });

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
      console.log(`[live-loadout] OpenHive listening on port ${SERVER_PORT}`);

      // ── Attach mail turn listener BEFORE spawning the swarm ───────────
      // Listen on the agent-inbox EventEmitter so we capture every turn
      // added to any conversation, including the dispatch work envelope.
      const mailEvts = getMailEvents();
      const onTurnAdded = (turn: unknown): void => {
        if (turn && typeof turn === 'object') {
          capturedTurns.push(turn as (typeof capturedTurns)[number]);
        }
      };
      mailEvts.on('mail.turn.added', onTurnAdded);
      mailTransportCleanup = () => mailEvts.off('mail.turn.added', onTurnAdded);

      // ── Spawn a real macro-agent swarm ─────────────────────────────────
      console.log('[live-loadout] Spawning real macro-agent swarm...');
      const hosted = await swarmManager.spawn(testAgent.id, {
        name: 'live-loadout-swarm',
        adapter: 'macro-agent',
        hive: 'live-dispatch-hive',
        metadata: { role: 'executor' },
        adapter_config: {
          // Enable swarm-dispatch inside the spawned macro-agent process.
          // Without this, config.dispatch?.enabled is undefined and the
          // entire dispatch block (including the mail-bridge's
          // dispatcherAgentId registration) is skipped, so
          // mail/turn.received notifications are never picked up.
          dispatch: {
            enabled: true,
            enableMailRouting: true,
            // Prefer routing to a running agent (prefer-route) rather than
            // always spawning a new one (spawn-only). The E2E swarm is a
            // sidecar-only connection without ACP, so spawn-only would block;
            // prefer-route falls back gracefully.
            dispatchMode: 'prefer-route',
            pollIntervalMs: 5_000,
            maxRetries: 1,
          },
        },
      });
      assignedPort = hosted.assigned_port!;
      hostedSwarmId = hosted.id;
      console.log(`[live-loadout] Swarm spawned: ${hosted.id}, port=${assignedPort}`);

      // ── Wait for sidecar to connect to the hub ─────────────────────────
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
        const logs = await swarmManager.getLogs(hosted.id, testAgent.id, { lines: 30 }).catch(() => '(no logs)');
        console.warn(`[live-loadout] Sidecar did not connect in 60s. Logs:\n${logs}`);
        return;
      }

      // ── Wait for mail capabilities (sidecar-level, available immediately) ──
      // The sidecar publishes mail.canJoin + messaging.canReceive at connection
      // time. These are the capabilities the dispatch orchestrator routes on
      // when there is no ACP coordinator registered. We do NOT wait for ACP —
      // coordinators only spawn when a team config is loaded, which does not
      // happen in this test.
      const mailReady = await waitFor(() => {
        if (!swarmId) return false;
        return (
          hasCapability(swarmId, 'mail.canJoin') ||
          hasCapability(swarmId, 'messaging.canReceive')
        );
      }, 30_000);

      if (mailReady) {
        console.log('[live-loadout] Mail capabilities confirmed on sidecar');
      } else {
        console.warn(
          '[live-loadout] Mail capabilities not detected within 30s; ' +
          'the dispatch will fail at route-selection. ' +
          'Verify that the installed macro-agent version publishes mail.canJoin.',
        );
      }

      // Allow identity to stabilize after possible reconnects.
      await sleep(1_000);
      // Re-resolve swarmId to the most recent inbound with registered agents.
      for (const [id, conn] of getAllInbound()) {
        if (conn.registeredAgents.size > 0) swarmId = id;
      }

      console.log(
        `[live-loadout] Route decision: ${swarmId ? canRouteToSwarm(swarmId).route : 'n/a (no swarmId)'}`,
      );
    }, 120_000);

    afterAll(async () => {
      if (orchestrator) {
        try { await orchestrator.stop(); } catch { /* best effort */ }
      }
      mailTransportCleanup?.();
      if (swarmManager) {
        console.log('[live-loadout] Shutting down swarm manager...');
        await swarmManager.shutdown();
      }
      stopMapWebSocket();
      if (app) await app.close();
      setLocalAgent(null);
      closeDatabase();
      cleanTestRoot(TEST_ROOT);
      if (originalHome) process.env.OPENHIVE_HOME = originalHome;
      else delete process.env.OPENHIVE_HOME;
    }, 30_000);

    // ── Sanity: swarm connected ──────────────────────────────────────────────

    it('real swarm is connected via MAP', () => {
      expect(getAllInbound().size).toBeGreaterThanOrEqual(1);
      expect(swarmId).toBeDefined();
      console.log(`[live-loadout] Connected swarms: ${[...getAllInbound().keys()].join(', ')}`);
    });

    // ── Routing sanity: dispatch will use mail (not ACP) ─────────────────────

    it('canRouteToSwarm chooses mail for a sidecar-only connection', () => {
      expect(swarmId).toBeDefined();
      const decision = canRouteToSwarm(swarmId!);
      console.log(`[live-loadout] Route decision: ${decision.route} (${decision.reason ?? 'ok'})`);
      // The sidecar publishes mail/messaging caps but no ACP; we expect mail.
      // If the swarm happened to publish ACP anyway (future version change),
      // 'acp' is also acceptable — we just assert it's not 'none'.
      expect(decision.route).not.toBe('none');
    });

    // ── Author loadout + team_template ───────────────────────────────────────

    it('authors loadout and team_template via REST', async () => {
      const ldtRes = await app.inject({
        method: 'POST',
        url: '/api/v1/loadouts',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
        payload: { name: 'live-dispatch-loadout', content: buildLoadoutContent() },
      });
      expect(ldtRes.statusCode).toBe(201);
      console.log('[live-loadout] Loadout created');

      const tmplRes = await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
        payload: { name: 'live-dispatch-team', content: buildTeamContent() },
      });
      expect(tmplRes.statusCode).toBe(201);
      console.log('[live-loadout] Team template created');
    });

    // ── Core assertion: mail turn body contains the loadout sentinel ──────────

    it(
      'dispatched spec with team_role_ref delivers mail turn body containing SENTINEL',
      async () => {
        expect(swarmId).toBeDefined();

        // Resolve the team template id for the spec fetcher stub.
        const tmpl = teamTemplatesDAL.getTeamTemplateByName('live-dispatch-team', testAgent.id);
        expect(tmpl).toBeTruthy();

        // ── Build the spec fetcher stub ──────────────────────────────────
        // Returns minimal spec content with a team_role_ref so enrichWithLoadout
        // materializes the loadout containing the SENTINEL instruction.
        const specFetcher: SpecContentFetcher = {
          async fetch(_resourceId: string, _specId: string) {
            return {
              title: 'Live Loadout E2E Task',
              content: 'Please respond with a brief greeting.',
              tasks: [],
              metadata: {
                team_role_ref: {
                  teamTemplateId: tmpl!.id,
                  role: 'executor',
                },
              },
            };
          },
        };

        // ── Insert queued dispatch row targeting the live swarm ──────────
        const insertedDispatch = dispatchesDAL.createDispatch({
          spec_resource_id: SYNTHETIC_SPEC_RESOURCE_ID,
          spec_id: SYNTHETIC_SPEC_ID,
          target_swarm_id: swarmId!,
          initiator_type: 'user',
          initiator_id: testAgent.id,
          status: 'queued',
        });
        console.log(`[live-loadout] Dispatch row inserted (id=${insertedDispatch.id})`);

        // ── Build the real mail transport + port (mirrors server.ts) ─────
        // Wrap sendToAgent so we can assert delivered === true and surface
        // failures with their reason. Without this, a mail JSON-RPC failure
        // (e.g., recipient_unreachable, mail_send_failed) would still leave
        // the test green if a stale mail.turn.added event matched the
        // sentinel. The wrapper lets us prove the wire-level send succeeded
        // for THIS dispatch's task id.
        const sendResults: Array<{
          swarmId: string;
          agentId: string;
          taskId?: string;
          delivered: boolean;
          reason?: string;
        }> = [];
        const realMailTransport = createOpenHiveMailTransport({
          getMailJsonRpc,
          getMailStorage,
          getMailEvents,
          sendToSwarm,
        });
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
        const messagePort = createOpenHiveMailPort(mailTransport);

        // ── Start the orchestrator with mail port ────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sc = (app as any).swarmcraft;
        orchestrator = setupOrchestrator({
          specFetcher,
          runtimeDeps: {
            // ACP stream manager provided but routing will choose mail
            // because the swarm has no ACP coordinator registered.
            getAcpStreamManager: () => sc.acpStreamManager,
          },
          messagePort,
          dispatchConfig: {
            pollIntervalMs: 1_000, // fast poll so the test picks up the row quickly
            globalConcurrency: 1,
            retry: { maxRetries: 0, baseDelayMs: 1_000, maxDelayMs: 5_000 },
            reconcileIntervalMs: 30_000,
            scorer: 'noop',
          },
        });

        await orchestrator.start();
        console.log('[live-loadout] Orchestrator started (mail-routed)');

        // ── Wait for a mail.turn.added event with the sentinel ───────────
        // Budget 30s: 1s orchestrator poll + enrichment + mail/turn JSON-RPC.
        // No Claude API round-trip needed — this is Level 1 (prompt delivered
        // to inbox, not agent response).
        const sentinelReceived = await waitFor(
          () => {
            for (const turn of capturedTurns) {
              const raw =
                typeof turn.content === 'string'
                  ? turn.content
                  : JSON.stringify(turn.content ?? '');
              if (raw.includes(SENTINEL)) return true;
            }
            return false;
          },
          30_000,
          500,
        );

        // Find the matching turn for diagnostics.
        const matchingTurn = capturedTurns.find((turn) => {
          const raw =
            typeof turn.content === 'string'
              ? turn.content
              : JSON.stringify(turn.content ?? '');
          return raw.includes(SENTINEL);
        });

        if (!sentinelReceived) {
          const summary = capturedTurns
            .map((t) => {
              const raw = typeof t.content === 'string' ? t.content : JSON.stringify(t.content);
              return `  [conv=${t.conversation_id}] ${raw.slice(0, 200)}`;
            })
            .join('\n');
          const sendSummary = sendResults
            .map((r) =>
              `  taskId=${r.taskId ?? 'n/a'} swarm=${r.swarmId} agent=${r.agentId} ` +
              `delivered=${r.delivered}${r.reason ? ` reason=${r.reason}` : ''}`,
            )
            .join('\n');
          console.error(
            `[live-loadout] Sentinel "${SENTINEL}" NOT found after 30s.\n` +
            `[live-loadout] Captured turns (${capturedTurns.length}):\n${summary}\n` +
            `[live-loadout] sendToAgent results (${sendResults.length}):\n${sendSummary}`,
          );
        } else {
          const raw =
            typeof matchingTurn!.content === 'string'
              ? matchingTurn!.content
              : JSON.stringify(matchingTurn!.content);
          console.log(
            `[live-loadout] Sentinel confirmed in delivered mail turn.\n` +
            `[live-loadout] Turn excerpt: ${raw.slice(0, 400)}`,
          );
        }

        expect(sentinelReceived).toBe(true);

        // ── Wire-level proof: sendToAgent succeeded for THIS dispatch ──────
        // Without these, a stale mail.turn.added from a prior conversation
        // could match the sentinel by accident and leave the test green
        // even though our dispatch's mail JSON-RPC failed silently.
        const matchingSend = sendResults.find((r) => r.taskId === insertedDispatch.id);
        expect(matchingSend).toBeDefined();
        expect(matchingSend!.delivered).toBe(true);
        expect(matchingSend!.reason).toBeUndefined();
        expect(matchingSend!.swarmId).toBe(swarmId!);
        console.log(
          `[live-loadout] Wire-level send confirmed: taskId=${matchingSend!.taskId} ` +
          `swarm=${matchingSend!.swarmId} agent=${matchingSend!.agentId} delivered=true`,
        );

        // ── Diagnostic: surface swarm subprocess logs around dispatch time ─
        // Helps inspect whether macro-agent's sidecar acknowledged the mail
        // turn. Not a hard assertion (Level 2 territory) — but visible
        // evidence in the test output that delivery hit the wire.
        try {
          if (!hostedSwarmId) throw new Error('hostedSwarmId not set');
          const logs = await swarmManager.getLogs(hostedSwarmId, testAgent.id, {
            lines: 60,
          });
          if (logs.length > 0) {
            console.log(
              `[live-loadout] Swarm subprocess logs (last 60 lines, ${logs.length} chars):\n${logs.slice(-3000)}`,
            );
          } else {
            console.warn('[live-loadout] Swarm logs unavailable (logs.length === 0)');
          }
        } catch (err) {
          console.warn(
            `[live-loadout] Could not retrieve swarm logs: ${(err as Error).message}`,
          );
        }

        // Verify the turn body is parseable and contains the sentinel in the prompt field.
        if (matchingTurn) {
          const content =
            typeof matchingTurn.content === 'string'
              ? matchingTurn.content
              : JSON.stringify(matchingTurn.content);

          // The dispatch mail transport stores the envelope as JSON in the
          // turn content (see mail-transport.ts sendViaMail). Parse and assert
          // the prompt field contains the sentinel.
          let envelope: Record<string, unknown> | null = null;
          try {
            envelope = JSON.parse(content) as Record<string, unknown>;
          } catch {
            // content is not JSON — might be stringified differently; the outer
            // includes() check already passed so the sentinel is present.
          }

          if (envelope) {
            expect(envelope.type).toBe('x-dispatch/work');
            const body = envelope.body as Record<string, unknown> | undefined;
            expect(body).toBeDefined();
            expect(typeof body?.prompt).toBe('string');
            expect(body!.prompt as string).toContain(SENTINEL);
          }
        }

        // Tear down the mail transport we created here (no leak into afterAll).
        mailTransport.destroy?.();
      },
      60_000,
    );

    // ── Level 2: macro-agent receives and acts on the dispatched mail turn ────
    //
    // This test proves that macro-agent:
    //   1. Received the dispatched mail turn from OpenHive's mail storage
    //      (via the `mail/turn.received` MAP notification forwarded by
    //      `forwardTurnToSwarms()` in src/mail/index.ts)
    //   2. Processed the prompt via the real Claude API
    //   3. Produced a response containing the SENTINEL prefix instructed in
    //      the loadout's prompt_addendum
    //
    // ── Observation channel ──────────────────────────────────────────────────
    //
    // When macro-agent's sidecar receives the `mail/turn.received` MAP
    // notification and processes the work, it posts a reply turn back to
    // OpenHive via the `mail/turn` MAP notification from the sidecar.
    // OpenHive's ws-map.ts routes `mail/*` notifications from connected swarms
    // to `getMailJsonRpc().handleRequest()`, which stores the turn in the
    // dispatch conversation and fires `mail.turn.added`.
    //
    // The existing `capturedTurns` array (populated by the Level 1 test's
    // `mail.turn.added` listener) therefore also captures macro-agent's reply.
    // We filter for turns where:
    //   - participant_id !== DISPATCHER_PARTICIPANT_ID ('openhive:dispatcher')
    //   - The conversation has metadata.source === DISPATCH_CONVERSATION_SCOPE
    //   - The turn content contains SENTINEL
    //
    // ── Architecture gap ────────────────────────────────────────────────────
    //
    // As of this writing, macro-agent's sidecar does NOT have an explicit
    // `mail/turn.received` notification handler registered via
    // `connection.onNotification()`. The MAP SDK may silently drop
    // unrecognised notifications, which would mean the work is never
    // delivered to macro-agent's processing loop.
    //
    // If that is the case, this test falls back to Level 1.5: asserting that
    // swarm subprocess logs contain evidence the mail turn or dispatch
    // conversation arrived at the sidecar (e.g., a log line referencing the
    // conversation id or the dispatch work schema).
    //
    // Level 2 is therefore structured as:
    //   - MUST-PASS: swarm logs show the dispatched work reached the sidecar
    //     process (Level 1.5 — conclusive without requiring Claude API round-trip)
    //   - BEST-EFFORT: a reply turn with SENTINEL appears in capturedTurns
    //     within 120s (Level 2 — proves end-to-end Claude API processing)
    //
    // If Level 2 passes, the test reports it. If it does not pass within the
    // budget, the test still passes (Level 1.5 succeeded) but logs the gap
    // clearly so developers know what infrastructure is missing.

    it(
      'Level 2 — macro-agent processes the dispatched mail turn and replies with SENTINEL',
      async () => {
        expect(swarmId).toBeDefined();
        expect(hostedSwarmId).toBeDefined();

        // ── Helper: is this turn a reply from macro-agent? ─────────────────
        // A reply turn is one posted to a swarm-dispatch conversation by a
        // participant who is NOT the dispatcher ('openhive:dispatcher').
        const storage = getMailStorage();
        const isAgentReplyWithSentinel = (turn: (typeof capturedTurns)[number]): boolean => {
          if (turn.participant_id === DISPATCHER_PARTICIPANT_ID) return false;

          // Verify the conversation belongs to the dispatch scope.
          const conv = storage.getConversation(turn.conversation_id);
          const meta = conv?.metadata as Record<string, unknown> | undefined;
          if (meta?.source !== DISPATCH_CONVERSATION_SCOPE) return false;

          const raw =
            typeof turn.content === 'string'
              ? turn.content
              : JSON.stringify(turn.content ?? '');
          return raw.includes(SENTINEL);
        };

        // ── Level 2: wait for a reply turn with SENTINEL ───────────────────
        // Bounded wait. macro-agent's sidecar mail-bridge forwards
        // `mail/turn.received` notifications into its local inbox, so the
        // dispatcher MessagePort can pick them up and route to a worker.
        // 300s: claude-code agent startup (~30-60s) + Claude API call (~60-120s)
        // + reply delivery via mail/turn MAP notification. 120s was too tight.
        const level2WaitMs = 60_000;
        console.log(
          `[live-loadout] Level 2: waiting up to ${level2WaitMs / 1000}s for macro-agent to ` +
          `reply with "${SENTINEL}" in a dispatch conversation turn...`,
        );
        const level2Reached = await waitFor(
          () => capturedTurns.some(isAgentReplyWithSentinel),
          level2WaitMs,
          1_000,
        );

        // ── Gather diagnostic context ───────────────────────────────────────
        let swarmLogs = '(unavailable)';
        try {
          swarmLogs = await swarmManager.getLogs(hostedSwarmId!, testAgent.id, { lines: 80 });
        } catch (err) {
          swarmLogs = `(error: ${(err as Error).message})`;
        }

        // ── Level 1.5: swarm logs must show the dispatch work arrived ──────
        // This is the minimum we can assert without a full Claude API round-trip.
        // The sidecar logs at INFO level when it receives MAP notifications and
        // when the inbox receives messages.  Evidence of the mail turn arriving
        // is a log line referencing the conversation scope or the dispatch schema.
        //
        // We check for ANY of these patterns:
        //   - 'swarm-dispatch'  — conversation scope metadata
        //   - 'x-dispatch'      — dispatch envelope schema prefix
        //   - 'mail/turn'       — the MAP notification method
        //   - 'mail.turn'       — agent-inbox event name
        //   - SENTINEL          — the sentinel itself (if macro-agent logged the prompt)
        const logPatterns = [
          DISPATCH_CONVERSATION_SCOPE,
          'x-dispatch',
          'mail/turn',
          'mail.turn',
          SENTINEL,
        ];
        const logsContainEvidence = logPatterns.some((pattern) =>
          swarmLogs.includes(pattern),
        );

        if (level2Reached) {
          const replyTurn = capturedTurns.find(isAgentReplyWithSentinel)!;
          const raw =
            typeof replyTurn.content === 'string'
              ? replyTurn.content
              : JSON.stringify(replyTurn.content);
          console.log(
            `[live-loadout] Level 2 PASSED — macro-agent replied with SENTINEL.\n` +
            `[live-loadout] Reply turn participant=${replyTurn.participant_id} ` +
            `conv=${replyTurn.conversation_id}\n` +
            `[live-loadout] Reply excerpt: ${raw.slice(0, 400)}`,
          );
          // Full Level 2 assertion: reply contains the sentinel.
          expect(level2Reached).toBe(true);
        } else {
          // Level 2 did not pass within budget. Dump diagnostics.
          const replyTurns = capturedTurns.filter(
            (t) => t.participant_id !== DISPATCHER_PARTICIPANT_ID,
          );
          const allTurnsSummary = capturedTurns
            .map((t) => {
              const raw =
                typeof t.content === 'string' ? t.content : JSON.stringify(t.content);
              return `  [conv=${t.conversation_id} participant=${t.participant_id}] ${raw.slice(0, 200)}`;
            })
            .join('\n');

          console.warn(
            `[live-loadout] Level 2 NOT reached within 120s.\n` +
            `[live-loadout] This is expected if macro-agent's sidecar does not ` +
            `have a mail/turn.received notification handler.\n` +
            `\n` +
            `[live-loadout] ── What was observed ──────────────────────────────\n` +
            `[live-loadout] Total captured turns: ${capturedTurns.length}\n` +
            `[live-loadout] Non-dispatcher reply turns: ${replyTurns.length}\n` +
            `[live-loadout] All turns:\n${allTurnsSummary}\n` +
            `\n` +
            `[live-loadout] ── Swarm logs (last 80 lines) ────────────────────\n` +
            `${swarmLogs.slice(-4000)}\n` +
            `\n` +
            `[live-loadout] ── What infrastructure would close the gap ────────\n` +
            `[live-loadout] 1. Add a mail/turn.received onNotification handler in\n` +
            `[live-loadout]    references/macro-agent/src/map/sidecar.ts or\n` +
            `[live-loadout]    coordination-handler.ts that:\n` +
            `[live-loadout]    a. Inspects incoming turn content for x-dispatch/work schema\n` +
            `[live-loadout]    b. Routes the prompt to a running agent or spawns one\n` +
            `[live-loadout]    c. Posts the agent's response back via mail/turn MAP notification\n` +
            `[live-loadout] 2. Alternatively, modify OpenHive's mail-transport.ts to prefer\n` +
            `[live-loadout]    map/dispatch/message over mail/turn when the agent has\n` +
            `[live-loadout]    messaging.canReceive — macro-agent boot-v2.ts already\n` +
            `[live-loadout]    classifies x-dispatch/work schema inbox messages correctly.`,
          );

          // Level 1.5: assert the swarm logs show the dispatch conversation scope
          // or the mail turn notification arrived.  This is the minimum evidence
          // that the dispatched work reached the process boundary.
          if (!logsContainEvidence) {
            console.warn(
              `[live-loadout] Level 1.5 ALSO NOT confirmed — swarm logs lack ` +
              `any evidence patterns: ${logPatterns.join(', ')}\n` +
              `[live-loadout] Full swarm logs:\n${swarmLogs}`,
            );
          } else {
            const matchingPattern = logPatterns.find((p) => swarmLogs.includes(p))!;
            console.log(
              `[live-loadout] Level 1.5 confirmed — swarm logs contain "${matchingPattern}". ` +
              `The dispatched mail turn reached the swarm process boundary.`,
            );
          }

          // Level 2 is now a hard assertion. The full bridge chain is wired:
          // hub → mail/turn.received → sidecar mail-bridge → local inbox →
          // swarm-dispatch classifier → worker spawn → Claude API → reply.
          expect(level2Reached).toBe(true);
        }
      },
      // 60s Level 2 wait + ~30s setup/teardown headroom.
      120_000,
    );
  },
);
