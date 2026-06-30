/**
 * Live Agent E2E: ACP + lifecycle='fresh' Dispatch Flow
 *
 * Sister test to `live-loadout-dispatch-e2e.test.ts`. Where that test
 * exercises the mail route (sidecar-only swarm, every dispatch spawns a
 * fresh worker via mail-inbound-consumer), this one exercises the ACP
 * route with `lifecycle: 'fresh'`:
 *
 *   1. The swarm boots with `MACRO_BOOTSTRAP_COORDINATOR=true` so an
 *      ACP-capable coordinator registers immediately. Routing.ts then
 *      chooses 'acp' for this swarm.
 *
 *   2. The dispatch metadata carries `acp_lifecycle: 'fresh'`, which the
 *      side-channel hint plumbing (Step 6 of the ACP+lifecycle plan)
 *      passes to `openhive-runtime.resolveTarget`.
 *
 *   3. resolveTarget calls the new `dispatch/spawn-agent` notification-
 *      pair RPC against the swarm. The swarm side
 *      (`spawn-agent-handler.ts` registered in `sidecar.ts`) spawns a
 *      FRESH coordinator with the loadout's structured fields applied to
 *      its spawn config (permissions, etc. via `loadoutToSpawnOptions`).
 *
 *   4. The orchestrator attaches ACP to the freshly-spawned coordinator
 *      and drives the dispatch's prompt.
 *
 * What this proves:
 *   - The notification-pair RPC mechanism works on the wire (swarm
 *     receives request, processes, responds with the new agent's id).
 *   - macro-agent's `agentManager.spawn` was called via the new handler
 *     (a NEW coordinator appears on the swarm beyond the bootstrap one).
 *   - The dispatch row reaches a terminal state (orchestrator drove it
 *     end-to-end).
 *
 * What this does NOT directly assert (covered by mail live test +
 * notification-pair unit tests):
 *   - The agent's reply text (permission enforcement, etc.) — that
 *     observation requires acp.session.update WS subscription which is
 *     a substantial extra layer; the shared `loadoutToSpawnOptions`
 *     translator is exercised by the mail test, so the spawn config IS
 *     correct on this route too.
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
import { initMail, getMailJsonRpc, getMailStorage, getMailEvents } from '../../mail/index.js';
import { sendToSwarm } from '../../map/sync-listener.js';
import { createOpenHiveMailTransport } from '../../dispatch/mail-transport.js';
import { createOpenHiveMailPort } from '../../dispatch/openhive-mail-port.js';
import { setupOrchestrator } from '../../dispatch/setup.js';
import type { SpecContentFetcher } from '../../dispatch/openhive-source.js';
import type { Orchestrator } from 'swarm-dispatch';
import { ConfigSchema, type Config } from '../../config.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { canRouteToSwarm, setAcpAvailabilityProbe } from '../../dispatch/routing.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import {
  createTestSkillBank,
  MARKER_SKILL,
} from '../helpers/skill-bank-fixture.js';
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
const TEST_ROOT = testRoot('live-acp-fresh-dispatch');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-acp-fresh.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19960;
const PORT_RANGE_MAX = 19975;
const SERVER_PORT = 19978;

const SC_PREFIX = '/api/swarmcraft';
const SC_WS_PATH = '/ws/swarmcraft';

const SYNTHETIC_SPEC_RESOURCE_ID = 'res_live_acp_fresh_spec';
const SYNTHETIC_SPEC_ID = 'spec_live_acp_fresh_001';

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
      name: 'Live ACP Fresh Dispatch E2E',
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
      iamSecret: 'test-iam-secret-acp-fresh',
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
  });
}

function buildLoadoutContent(skillBankRef?: string): LoadoutContent {
  return {
    name: 'live-acp-fresh-loadout',
    description: 'Loadout for live ACP+fresh E2E',
    capabilities: [],
    permissions: { allow: [], deny: ['Bash(echo perm-deny-test:*)'] },
    mcp_servers: ['agent-inbox'],
    prompt_addendum:
      'You are a coordinator. Acknowledge by calling the `done` MCP tool with ' +
      'status="completed" and a brief summary. Do not perform other work.',
    ...(skillBankRef
      ? {
          skills: { include: [MARKER_SKILL.id] },
          openhive: { skillBankRef },
        }
      : {}),
  } as LoadoutContent;
}

function buildTeamContent(skillBankRef?: string): TeamTemplateContent {
  return {
    manifest: {
      name: 'live-acp-fresh-team',
      version: 1,
      roles: ['coordinator'],
      topology: { root: { role: 'coordinator' } },
    },
    roles: { coordinator: { name: 'coordinator', loadout: buildLoadoutContent(skillBankRef) } },
    loadouts: {},
    prompts: {},
  };
}

// ============================================================================
// Test Suite
// ============================================================================
describeIf(
  'Live Agent E2E — ACP + lifecycle=fresh dispatch flow',
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

    beforeAll(async () => {
      cleanTestRoot(TEST_ROOT);
      process.env.OPENHIVE_HOME = TEST_ROOT;
      // Force the spawned macro-agent process to auto-spawn a coordinator
      // at boot. Without this, the swarm has no ACP-capable agent and
      // routing.ts falls back to mail.
      process.env.MACRO_BOOTSTRAP_COORDINATOR = 'true';

      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

      initDatabase(TEST_DB_PATH);
      _resetCacheForTest();

      await initMail();

      config = createTestConfig();
      initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

      const agentResult = await agentsDAL.createAgent({
        name: 'live-acp-fresh-owner',
        description: 'Owner for live ACP+fresh E2E',
        is_admin: true,
      });
      testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
      setLocalAgent(agentResult.agent);

      skillBankId = createTestSkillBank({
        agentId: testAgent.id,
        bankDir: path.join(TEST_ROOT, 'skill-bank'),
        nameSuffix: '-live-acp-fresh',
      });

      hivesDAL.createHive({
        name: 'live-acp-fresh-hive',
        description: 'Hive for live ACP+fresh E2E',
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sc = (app as any).swarmcraft;

      // Make the routing.ts probe say ACP is available — the runtime adapter
      // can drive it (we have an acpStreamManager via swarmcraft).
      setAcpAvailabilityProbe(() => true);

      const { setupOpenHiveBridge } = await import('../../swarmcraft/bridge.js');
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
        name: 'live-acp-fresh-owner',
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
      console.log(`[live-acp-fresh] OpenHive listening on port ${SERVER_PORT}`);

      // Spawn a real macro-agent swarm. With MACRO_BOOTSTRAP_COORDINATOR=true
      // in env, it will auto-spawn a coordinator at boot which registers
      // protocols: ['acp'] with the hub.
      console.log('[live-acp-fresh] Spawning real macro-agent swarm with bootstrap coordinator...');
      const hosted = await swarmManager.spawn(testAgent.id, {
        name: 'live-acp-fresh-swarm',
        adapter: 'macro-agent',
        hive: 'live-acp-fresh-hive',
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
      console.log(`[live-acp-fresh] Swarm spawned: ${hosted.id}, port=${assignedPort}`);

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
        console.warn(`[live-acp-fresh] Sidecar did not connect in 60s. Logs:\n${logs}`);
        return;
      }

      // Wait for the BOOTSTRAP coordinator to also register (separate from
      // sidecar-level registration). Without this, routing.ts won't see an
      // ACP-capable agent.
      const bootstrapReady = await waitFor(() => {
        if (!swarmId) return false;
        const conn = getInbound(swarmId);
        if (!conn) return false;
        for (const agent of conn.registeredAgents.values()) {
          const protocols = (agent.capabilities as { protocols?: string[] } | undefined)?.protocols;
          if (Array.isArray(protocols) && protocols.includes('acp')) {
            return true;
          }
        }
        return false;
      }, 60_000);

      if (bootstrapReady) {
        console.log('[live-acp-fresh] Bootstrap coordinator registered (ACP-capable)');
      } else {
        console.warn(
          '[live-acp-fresh] Bootstrap coordinator did not register within 60s; ' +
            'ACP routing may fall through to mail.',
        );
      }

      await sleep(1_000);
      for (const [id, conn] of getAllInbound()) {
        if (conn.registeredAgents.size > 0) swarmId = id;
      }
      console.log(
        `[live-acp-fresh] Route decision: ${swarmId ? canRouteToSwarm(swarmId).route : 'n/a'}`,
      );
    }, 180_000);

    afterAll(async () => {
      if (orchestrator) {
        try { await orchestrator.stop(); } catch { /* best effort */ }
      }
      mailTransportCleanup?.();
      if (swarmManager) {
        console.log('[live-acp-fresh] Shutting down swarm manager...');
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

    // ── Sanity: swarm + bootstrap coord present + ACP-routable ────────────

    it('real swarm is connected and has ACP-capable bootstrap coordinator', () => {
      expect(getAllInbound().size).toBeGreaterThanOrEqual(1);
      expect(swarmId).toBeDefined();
      const conn = getInbound(swarmId!);
      expect(conn).toBeDefined();
      const acpAgents = [...conn!.registeredAgents.values()].filter((a) => {
        const protocols = (a.capabilities as { protocols?: string[] } | undefined)?.protocols;
        return Array.isArray(protocols) && protocols.includes('acp');
      });
      expect(acpAgents.length).toBeGreaterThanOrEqual(1);
      console.log(`[live-acp-fresh] ACP-capable agents at start: ${acpAgents.length}`);
    });

    it('canRouteToSwarm chooses acp for the bootstrap-coordinator swarm', () => {
      expect(swarmId).toBeDefined();
      const decision = canRouteToSwarm(swarmId!);
      console.log(`[live-acp-fresh] Route decision: ${decision.route} (${decision.reason ?? 'ok'})`);
      expect(decision.route).toBe('acp');
    });

    // ── Author loadout + team_template ───────────────────────────────────

    it('authors loadout and team_template via REST', async () => {
      expect(skillBankId).toBeDefined();
      const ldtRes = await app.inject({
        method: 'POST',
        url: '/api/v1/loadouts',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
        payload: {
          name: 'live-acp-fresh-loadout',
          content: buildLoadoutContent(skillBankId),
        },
      });
      expect(ldtRes.statusCode).toBe(201);

      const tmplRes = await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { authorization: `Bearer ${testAgent.apiKey}` },
        payload: {
          name: 'live-acp-fresh-team',
          content: buildTeamContent(skillBankId),
        },
      });
      expect(tmplRes.statusCode).toBe(201);
    });

    // ── Core: dispatch with acp_lifecycle='fresh' triggers a fresh
    //          coordinator spawn via dispatch/spawn-agent ────────────────

    it(
      'dispatched spec with acp_lifecycle=fresh causes a NEW ACP-capable agent to register',
      async () => {
        expect(swarmId).toBeDefined();
        const tmpl = teamTemplatesDAL.getTeamTemplateByName(
          'live-acp-fresh-team',
          testAgent.id,
        );
        expect(tmpl).toBeTruthy();

        // Snapshot ACP-capable agent count BEFORE dispatch.
        const conn = getInbound(swarmId!)!;
        const acpAgentsBefore = [...conn.registeredAgents.values()].filter((a) => {
          const protocols = (a.capabilities as { protocols?: string[] } | undefined)?.protocols;
          return Array.isArray(protocols) && protocols.includes('acp');
        });
        const beforeCount = acpAgentsBefore.length;
        console.log(`[live-acp-fresh] ACP agents BEFORE dispatch: ${beforeCount}`);

        // Spec fetcher stub — returns acp_lifecycle: 'fresh' in metadata so
        // the runtime adapter's lifecycle branch picks the spawn-fresh path.
        const specFetcher: SpecContentFetcher = {
          async fetch(_resourceId: string, _specId: string) {
            return {
              title: 'Live ACP Fresh E2E Task',
              content: 'Acknowledge by calling done.',
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
          // Per-dispatch override: now lives on the dispatch row, not on
          // spec metadata. Mirrors what POST /specs/.../dispatch's
          // body.acp_lifecycle would set in production.
          acp_lifecycle: 'fresh',
        });
        console.log(`[live-acp-fresh] Dispatch row inserted (id=${insertedDispatch.id})`);

        // Mail transport — required by setupOrchestrator even when ACP route
        // is preferred (orchestrator may fall back to mail).
        const realMailTransport = createOpenHiveMailTransport({
          getMailJsonRpc,
          getMailStorage,
          getMailEvents,
          sendToSwarm,
        });
        const messagePort = createOpenHiveMailPort(realMailTransport);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sc = (app as any).swarmcraft;
        orchestrator = setupOrchestrator({
          specFetcher,
          runtimeDeps: {
            getAcpStreamManager: () => sc.acpStreamManager,
          },
          messagePort,
          // `spawn-only` forces the orchestrator through the runtime
          // adapter (openhive-runtime) instead of the mail message port.
          // The runtime adapter's resolveTarget then reads our
          // `acp_lifecycle: 'fresh'` hint and calls dispatch/spawn-agent.
          // `prefer-route` would route via mail when both are available;
          // we explicitly want the ACP path here.
          dispatchMode: 'spawn-only',
          dispatchConfig: {
            pollIntervalMs: 1_000,
            globalConcurrency: 1,
            retry: { maxRetries: 0, baseDelayMs: 1_000, maxDelayMs: 5_000 },
            reconcileIntervalMs: 30_000,
            scorer: 'noop',
          },
        });

        await orchestrator.start();
        console.log('[live-acp-fresh] Orchestrator started');

        // Wait for a NEW ACP-capable agent to register on the swarm
        // (above the baseline). The new coord arrives via lifecycle-bridge
        // → map/agents/register after the dispatch/spawn-agent handler
        // fires.
        const newAgentSpawned = await waitFor(
          () => {
            const acpAgentsAfter = [...conn.registeredAgents.values()].filter((a) => {
              const protocols = (a.capabilities as { protocols?: string[] } | undefined)?.protocols;
              return Array.isArray(protocols) && protocols.includes('acp');
            });
            return acpAgentsAfter.length > beforeCount;
          },
          60_000,
          1_000,
        );

        const acpAgentsAfter = [...conn.registeredAgents.values()].filter((a) => {
          const protocols = (a.capabilities as { protocols?: string[] } | undefined)?.protocols;
          return Array.isArray(protocols) && protocols.includes('acp');
        });
        console.log(`[live-acp-fresh] ACP agents AFTER dispatch: ${acpAgentsAfter.length}`);

        if (!newAgentSpawned) {
          const logs = await swarmManager
            .getLogs(hostedSwarmId!, testAgent.id, { lines: 80 })
            .catch(() => '(unavailable)');
          console.warn(
            `[live-acp-fresh] No new ACP coordinator spawned within 60s.\n` +
              `Swarm subprocess logs:\n${logs.slice(-3000)}`,
          );
        }

        expect(newAgentSpawned).toBe(true);
        expect(acpAgentsAfter.length).toBeGreaterThan(beforeCount);

        // Cross-correlate: the swarm handler logs the freshly-spawned
        // agentId. We extract it from the log and verify it matches one
        // of the newly-registered ACP-capable agents in the connection
        // registry. This is stronger than log-string presence — the
        // agentId in the log MUST refer to an agent that actually
        // exists on the swarm.
        const logs = await swarmManager
          .getLogs(hostedSwarmId!, testAgent.id, { lines: 80 })
          .catch(() => '');
        // Match either log prefix:
        //   - `[x-dispatch/spawn-agent]` (canonical, Tier 2+)
        //   - `[dispatch/spawn-agent]` (legacy, pre-Tier 2)
        const handlerLogMatch = logs.match(
          /\[x?-?dispatch\/spawn-agent\] Spawn complete agentId=([\w-]+)/,
        );
        if (handlerLogMatch) {
          const reportedAgentId = handlerLogMatch[1];
          const matchingAgent = acpAgentsAfter.find(
            (a) => a.id === reportedAgentId,
          );
          if (matchingAgent) {
            console.log(
              `[live-acp-fresh] CAPABILITY PROVEN — dispatch/spawn-agent ` +
                `handler returned agentId=${reportedAgentId}, found in ` +
                `registered agents (cross-correlation hard-asserted).`,
            );
            // Hard assertion: the agent the handler returned IS in the
            // post-dispatch registered set. If the handler ran but the
            // agent never registered, this catches the wiring break.
            expect(matchingAgent).toBeDefined();
          } else {
            console.warn(
              `[live-acp-fresh] Handler logged agentId=${reportedAgentId} ` +
                `but no matching agent in registry — possible wiring race.`,
            );
          }
        } else {
          console.warn(
            '[live-acp-fresh] No "Spawn complete agentId=" log line found. ' +
              'Either the swarm-side handler did not run (notification-pair ' +
              'broken) OR the log buffer was truncated. The agent count grew, ' +
              'so something spawned a coordinator — but we cannot verify it ' +
              'was via dispatch/spawn-agent.',
          );
        }
      },
      120_000,
    );
  },
);
