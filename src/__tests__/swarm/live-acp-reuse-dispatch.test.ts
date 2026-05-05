/**
 * Live Agent E2E: ACP + lifecycle='reuse' Dispatch Flow
 *
 * Sister to the ACP+fresh tests. Where those exercise spawn-fresh-per-
 * dispatch (loadout permissions enforced because the spawn config is
 * fresh), this test exercises the REUSE path:
 *
 *   1. The swarm boots with `MACRO_BOOTSTRAP_COORDINATOR=true` so an
 *      ACP-capable coordinator registers immediately. This is the agent
 *      that will be REUSED.
 *
 *   2. The dispatch metadata carries `acp_lifecycle: 'reuse'`, which
 *      makes `openhive-runtime.resolveTarget` go through the existing
 *      `findAcpAgentInfo` path — NOT through the notification-pair RPC.
 *
 *   3. The orchestrator attaches ACP to the existing bootstrap
 *      coordinator and drives the dispatch's prompt against its
 *      already-running session.
 *
 * Capability semantics (P4.2 — full overlay enforcement on the reuse path):
 *
 *   ✅ Addendum reaches the agent (SENTINEL in reply) — the prompt body
 *      is built fresh per dispatch.
 *   ✅ Skill catalog reaches the agent (SKILL_MARKER) — same prompt
 *      builder embeds skills.rendered.
 *   ✅ MCP tools work (AGENT_COUNT>0) — the existing coordinator's MCP
 *      trinity (agent-inbox, opentasks, macro-agent) was wired at its
 *      original spawn (boot-time), independent of dispatch.
 *   ✅ Loadout permissions ARE enforced (P4.2). Before driving the
 *      ACP prompt, the OpenHive runtime sends an
 *      `x-dispatch/permissions.set` notification to the swarm carrying
 *      the loadout's deny rules. Macro-agent's sidecar invokes
 *      `setPermissionOverlay` on the named agent. The prompt iterator
 *      in `agent-manager-v2.ts` intercepts the agent's
 *      `permission_request` ACP session updates and answers with
 *      'reject' for any matching the overlay. After the dispatch
 *      completes, `closeStream` sends `permissions.clear`.
 *
 * The test asserts all 4 markers including PERM_DENIED=true.
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
import { createOpenHiveMailTransport } from '../../dispatch/mail-transport.js';
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

const TEST_ROOT = testRoot('live-acp-reuse-dispatch');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-acp-reuse.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19940;
const PORT_RANGE_MAX = 19955;
const SERVER_PORT = 19957;

const SC_PREFIX = '/api/swarmcraft';
const SC_WS_PATH = '/ws/swarmcraft';

const SYNTHETIC_SPEC_RESOURCE_ID = 'res_live_acp_reuse_spec';
const SYNTHETIC_SPEC_ID = 'spec_live_acp_reuse_001';

const SENTINEL = 'WIDGET_SENTINEL_42';

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
      name: 'Live ACP Reuse Dispatch E2E',
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
      iamSecret: 'test-iam-secret-acp-reuse',
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

/**
 * Loadout — same three-task probe as the deep ACP+fresh test, but with
 * the permission probe REMOVED. The reuse path doesn't enforce loadout
 * permissions (Claude session was created with the bootstrap config, not
 * this loadout's), so the deny rule wouldn't apply and asserting it
 * would be a false test.
 *
 * The deny rule itself is included in the loadout to verify that
 * shipping it through the wire does NOT crash the reuse path.
 */
function buildLoadoutContent(skillBankRef?: string): LoadoutContent {
  const base: LoadoutContent = {
    name: 'live-acp-reuse-loadout',
    description: 'Loadout for live ACP+reuse E2E',
    capabilities: [],
    permissions: {
      allow: [],
      // Live-asserted (P4.2): the dispatch's deny rule is applied to the
      // reused agent's session via the runtime overlay registry. The
      // OpenHive runtime sends an `x-dispatch/permissions.set`
      // notification to the swarm before driving the prompt; the swarm-
      // side prompt iterator (in macro-agent) intercepts the agent's
      // permission_request session updates and denies any matching the
      // overlay. Cleared via `permissions.clear` on closeStream.
      deny: ['Read(/tmp/perm-deny-test-target.txt)'],
    },
    mcp_servers: ['agent-inbox'],
    prompt_addendum: [
      `You have four required tasks. Complete all four, then end your turn by calling the \`done\` tool from the macro-agent MCP server.`,
      ``,
      `Task 1 — Skill consumption: Read your <available_skills> section. If you find a skill named "Marker Skill", extract the marker token from its description (a token like SKILL_MARKER_*).`,
      ``,
      `Task 2 — MCP invocation: Call the \`list_agents\` tool from the agent-inbox MCP server. Note the count of agents returned.`,
      ``,
      `Task 3 — Permission probe: Try to read the file "/tmp/perm-deny-test-target.txt" using the Read tool. The dispatch loadout has a deny rule for this exact path. If the call is denied (you'll see "Permission to use Read ... has been denied" or similar), set PERM_DENIED=true. If the call somehow succeeds and you see the file contents, set PERM_DENIED=false. Either outcome is fine — just report what happens accurately.`,
      ``,
      `Task 4 — Reply via done: Call \`done\` with status="completed" and a summary that contains, in order:`,
      `  - "${SENTINEL}" at the very start`,
      `  - The marker token from Task 1 (verbatim, e.g. ${SKILL_MARKER})`,
      `  - "AGENT_COUNT=N" (N is the integer count from Task 2)`,
      `  - "PERM_DENIED=true" or "PERM_DENIED=false" from Task 3`,
      ``,
      `Example summary: "${SENTINEL} ${SKILL_MARKER} AGENT_COUNT=2 PERM_DENIED=true"`,
      ``,
      `Also include the same marker line in your final visible reply text so the user can see it.`,
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
      name: 'live-acp-reuse-team',
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
  'Live Agent E2E — ACP + lifecycle=reuse: existing coordinator processes dispatch (overlay-enforced)',
  () => {
    let app: FastifyInstance;
    let config: Config;
    let swarmManager: SwarmManager;
    let testAgent: { id: string; apiKey: string };
    let swarmId: string | undefined;
    let assignedPort: number | undefined;
    let hostedSwarmId: string | undefined;
    let orchestrator: Orchestrator | undefined;
    let skillBankId: string | undefined;
    const originalHome = process.env.OPENHIVE_HOME;
    const originalBootstrap = process.env.MACRO_BOOTSTRAP_COORDINATOR;

    /**
     * Captured ACP event JSON blobs. Same hook as the deep ACP+fresh
     * test — wraps `wsHub.broadcast` to push every `acp.*` event from
     * the `acp` topic into a local array. Markers are grep'd across the
     * joined blob.
     */
    const capturedAcpText: string[] = [];

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
        name: 'live-acp-reuse-owner',
        description: 'Owner for live ACP+reuse E2E',
        is_admin: true,
      });
      testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
      setLocalAgent(agentResult.agent);

      skillBankId = createTestSkillBank({
        agentId: testAgent.id,
        bankDir: path.join(TEST_ROOT, 'skill-bank'),
        nameSuffix: '-live-acp-reuse',
      });

      hivesDAL.createHive({
        name: 'live-acp-reuse-hive',
        description: 'Hive for live ACP+reuse E2E',
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

      // ACP capture hook — same as the deep ACP+fresh test
      const origBroadcast = sc.wsHub.broadcast.bind(sc.wsHub);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sc.wsHub.broadcast = (message: any, topic?: string) => {
        origBroadcast(message, topic);
        if (
          topic === 'acp' &&
          message?.type &&
          typeof message.type === 'string' &&
          message.type.startsWith('acp.')
        ) {
          try {
            capturedAcpText.push(JSON.stringify(message));
          } catch {
            /* skip */
          }
        }
      };

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
        name: 'live-acp-reuse-owner',
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
      console.log(`[live-acp-reuse] OpenHive listening on port ${SERVER_PORT}`);

      console.log(
        '[live-acp-reuse] Spawning real macro-agent swarm with bootstrap coordinator...',
      );
      const hosted = await swarmManager.spawn(testAgent.id, {
        name: 'live-acp-reuse-swarm',
        adapter: 'macro-agent',
        hive: 'live-acp-reuse-hive',
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
      console.log(`[live-acp-reuse] Swarm spawned: ${hosted.id}, port=${assignedPort}`);

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
        console.warn(`[live-acp-reuse] Sidecar did not connect in 60s. Logs:\n${logs}`);
        return;
      }

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
        console.log('[live-acp-reuse] Bootstrap coordinator registered (will be reused)');
      }

      await sleep(1_000);
    }, 180_000);

    afterAll(async () => {
      if (orchestrator) {
        try { await orchestrator.stop(); } catch { /* best effort */ }
      }
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
      'existing coordinator handles dispatch with prompt-body capability proofs (overlay-enforced)',
      async () => {
        expect(swarmId).toBeDefined();

        // Author loadout + team
        const ldtRes = await app.inject({
          method: 'POST',
          url: '/api/v1/loadouts',
          headers: { authorization: `Bearer ${testAgent.apiKey}` },
          payload: {
            name: 'live-acp-reuse-loadout',
            content: buildLoadoutContent(skillBankId),
          },
        });
        expect([201, 409]).toContain(ldtRes.statusCode);

        const tmplCreate = await app.inject({
          method: 'POST',
          url: '/api/v1/teams',
          headers: { authorization: `Bearer ${testAgent.apiKey}` },
          payload: {
            name: 'live-acp-reuse-team',
            content: buildTeamContent(skillBankId),
          },
        });
        expect([201, 409]).toContain(tmplCreate.statusCode);

        const tmpl = teamTemplatesDAL.getTeamTemplateByName(
          'live-acp-reuse-team',
          testAgent.id,
        );
        expect(tmpl).toBeTruthy();

        // Snapshot agent count BEFORE — the reuse path must NOT spawn a new
        // ACP-capable agent. The bootstrap coord is the only one.
        const conn = getInbound(swarmId!)!;
        const acpAgentsBefore = [...conn.registeredAgents.values()].filter((a) => {
          const protocols = (a.capabilities as { protocols?: string[] } | undefined)
            ?.protocols;
          return Array.isArray(protocols) && protocols.includes('acp');
        });
        const beforeCount = acpAgentsBefore.length;
        console.log(`[live-acp-reuse] ACP agents BEFORE dispatch: ${beforeCount}`);
        expect(beforeCount).toBeGreaterThanOrEqual(1);

        const specFetcher: SpecContentFetcher = {
          async fetch(_resourceId: string, _specId: string) {
            return {
              title: 'Live ACP Reuse E2E Task',
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
          // Explicit reuse — also matches the cluster-default of 'reuse',
          // but stating it on the row exercises the per-dispatch override
          // path so future regressions are caught immediately.
          acp_lifecycle: 'reuse',
        });
        console.log(`[live-acp-reuse] Dispatch row inserted (id=${insertedDispatch.id})`);

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
          // spawn-only forces the orchestrator through the runtime adapter,
          // which then reads the side-channel hint and takes the
          // findAcpAgentInfo (reuse) branch.
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
        console.log('[live-acp-reuse] Orchestrator started (spawn-only)');

        // Wait for the existing coord to process the dispatch and produce
        // a reply containing the three markers.
        const waitMs = 120_000;
        console.log(
          `[live-acp-reuse] Waiting up to ${waitMs / 1000}s for existing coordinator's reply...`,
        );
        const allMarkersSeen = await waitFor(
          () => {
            const all = capturedAcpText.join('\n');
            return (
              all.includes(SENTINEL) &&
              all.includes(SKILL_MARKER) &&
              /AGENT_COUNT\s*=\s*\d+/.test(all) &&
              /PERM_DENIED\s*=\s*(true|false)/.test(all)
            );
          },
          waitMs,
          1_000,
        );

        const allText = capturedAcpText.join('\n');
        console.log(
          `[live-acp-reuse] Captured ACP fragments: ${capturedAcpText.length}\n` +
            `[live-acp-reuse] Excerpt: ${allText.slice(0, 600)}`,
        );

        // After the dispatch — the bootstrap coord count must be unchanged.
        // No new ACP-capable agent should have been spawned by the reuse
        // path. (The deep ACP+fresh test asserts the inverse: count grows.)
        const acpAgentsAfter = [...conn.registeredAgents.values()].filter((a) => {
          const protocols = (a.capabilities as { protocols?: string[] } | undefined)
            ?.protocols;
          return Array.isArray(protocols) && protocols.includes('acp');
        });
        const afterCount = acpAgentsAfter.length;
        console.log(`[live-acp-reuse] ACP agents AFTER dispatch: ${afterCount}`);

        if (!allMarkersSeen) {
          const logs = await swarmManager
            .getLogs(hostedSwarmId!, testAgent.id, { lines: 100 })
            .catch(() => '(unavailable)');
          console.warn(
            `[live-acp-reuse] Markers not all seen.\nText:\n${allText}\n\nLogs:\n${logs.slice(-3000)}`,
          );
        }

        // ── Capability proofs (4 markers — P4.2: full overlay enforcement on ACP+reuse) ──
        const sentinelSeen = allText.includes(SENTINEL);
        const skillUsed = allText.includes(SKILL_MARKER);
        const agentCountMatch = allText.match(/AGENT_COUNT\s*=\s*(\d+)/);
        const mcpFollowThrough = agentCountMatch !== null;
        const reportedCount = mcpFollowThrough ? parseInt(agentCountMatch![1], 10) : null;
        const mcpActuallyInvoked = reportedCount !== null && reportedCount > 0;
        const permDeniedMatch = allText.match(/PERM_DENIED\s*=\s*(true|false)/);
        const permDeniedReported = permDeniedMatch !== null;
        const permEnforced = permDeniedMatch?.[1] === 'true';

        if (allMarkersSeen) {
          console.log(
            `[live-acp-reuse] CAPABILITY PROVEN — addendum: ${sentinelSeen}; ` +
              `skill: ${skillUsed}; mcp: AGENT_COUNT=${reportedCount}; ` +
              `perm: PERM_DENIED=${permDeniedMatch?.[1]} ` +
              `(overlay enforced via x-dispatch/permissions.set + ACP permission_request interception).`,
          );
        }

        // Dump macro-agent logs when PERM_DENIED=false. Helps diagnose
        // whether permissions.set landed + the prompt iterator fired +
        // what tool input the agent passed to Read.
        if (permDeniedMatch && permDeniedMatch[1] === 'false') {
          const logs = await swarmManager
            .getLogs(hostedSwarmId!, testAgent.id, { lines: 300 })
            .catch(() => '(unavailable)');
          console.warn(
            `[live-acp-reuse] PERM_DENIED reported false. Macro-agent logs:\n` +
              logs.slice(-8000),
          );
        }

        // Hard assertions: prompt-body fields reach the agent + overlay
        // enforcement worked (P4.2).
        expect(sentinelSeen).toBe(true);
        expect(skillUsed).toBe(true);
        expect(mcpFollowThrough).toBe(true);
        expect(mcpActuallyInvoked).toBe(true);
        expect(permDeniedReported).toBe(true);
        expect(permEnforced).toBe(true);

        // Hard assertion: NO new ACP coordinator spawned. The reuse path
        // explicitly used the existing bootstrap coord. The existing
        // coord MAY have terminated as designed (the agent's done() in
        // push mode returns shouldTerminate=true; for parentless agents
        // that means the session exits). What we forbid is a FRESH spawn
        // — that would mean the lifecycle hint plumbing routed to
        // fresh-spawn instead of reuse, breaking the test's premise.
        expect(afterCount).toBeLessThanOrEqual(beforeCount);
      },
      180_000,
    );
  },
);
