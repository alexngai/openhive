/**
 * Live Agent E2E: ACP + lifecycle='fresh' Dispatch Flow — DEEP variant
 *
 * Sister to `live-acp-fresh-dispatch.test.ts`. Where that test asserts
 * the new wire mechanism + spawn happens (proves the chain hub →
 * notification-pair RPC → swarm-side handler → agentManager.spawn fires
 * a fresh ACP-capable coordinator), this DEEPER test goes one level
 * further: it subscribes to `acp.session.update` events and captures
 * the freshly-spawned coordinator's text output, asserting the four
 * capability markers in the agent's reply — symmetric with the mail
 * test's level-2 assertions.
 *
 * Capability markers (same shape as the mail test):
 *   - WIDGET_SENTINEL_42 — addendum reached the agent
 *   - SKILL_MARKER_WIDGET_99 — agent read the skill catalog and followed
 *     the embedded self-instruction
 *   - AGENT_COUNT=N (N > 0) — agent invoked agent-inbox.list_agents
 *   - PERM_DENIED=true — loadout's deny rule blocked the bash call
 *
 * REQUIRES: LIVE_AGENT_E2E=true
 *
 * Note: the spawn-agent handler creates the coordinator with role
 * "coordinator" (registers protocols=['acp']) but `task: undefined`
 * other than the placeholder. The real prompt arrives via ACP
 * `session/prompt` from the orchestrator AFTER spawn — the
 * `openHivePromptBuilder` builds it with the loadout's structured
 * fields (skills.rendered, addendum, MCP advisory hint).
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

const TEST_ROOT = testRoot('live-acp-fresh-end-to-end');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'live-acp-fresh-e2e.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19990;
const PORT_RANGE_MAX = 19999;
const SERVER_PORT = 19988;

const SC_PREFIX = '/api/swarmcraft';
const SC_WS_PATH = '/ws/swarmcraft';

const SYNTHETIC_SPEC_RESOURCE_ID = 'res_live_acp_fresh_e2e_spec';
const SYNTHETIC_SPEC_ID = 'spec_live_acp_fresh_e2e_001';

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
      name: 'Live ACP Fresh Dispatch E2E (deep)',
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
      iamSecret: 'test-iam-secret-acp-fresh-e2e',
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
 * Loadout: same four-task probe shape as the mail test, scoped to a
 * coordinator. The coordinator's Claude session executes the four tasks
 * directly on the ACP route (it IS the worker on this route — there's
 * no intermediate child-spawning).
 */
function buildLoadoutContent(skillBankRef?: string): LoadoutContent {
  const base: LoadoutContent = {
    name: 'live-acp-fresh-e2e-loadout',
    description: 'Loadout for live ACP+fresh deep E2E',
    capabilities: [],
    permissions: {
      allow: [],
      deny: ['Bash(echo perm-deny-test:*)'],
    },
    mcp_servers: ['agent-inbox'],
    prompt_addendum: [
      `You have four required tasks. Complete all four, then end your turn by calling the \`done\` tool from the macro-agent MCP server.`,
      ``,
      `Task 1 — Skill consumption: Read your <available_skills> section. If you find a skill named "Marker Skill", extract the marker token from its description (a token like SKILL_MARKER_*).`,
      ``,
      `Task 2 — MCP invocation: Call the \`list_agents\` tool from the agent-inbox MCP server. Note the count of agents returned.`,
      ``,
      `Task 3 — Permission probe: Try to run "echo perm-deny-test should-be-blocked" using the Bash tool. If denied, set PERM_DENIED=true; otherwise PERM_DENIED=false.`,
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
      name: 'live-acp-fresh-e2e-team',
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
  'Live Agent E2E (deep) — ACP + lifecycle=fresh: agent processes dispatch and replies with capability markers',
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
     * Captured ACP session_update text fragments. The bridge in
     * `src/server.ts:440-466` forwards SwarmCraft's `acp.session.update`
     * events from the `acp` topic to OpenHive's `global` channel. In this
     * test we wrap `wsHub.broadcast` directly to capture into a local
     * array before broadcast — same hook point, different sink.
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
        name: 'live-acp-fresh-e2e-owner',
        description: 'Owner for live ACP+fresh deep E2E',
        is_admin: true,
      });
      testAgent = { id: agentResult.agent.id, apiKey: agentResult.apiKey };
      setLocalAgent(agentResult.agent);

      skillBankId = createTestSkillBank({
        agentId: testAgent.id,
        bankDir: path.join(TEST_ROOT, 'skill-bank'),
        nameSuffix: '-live-acp-fresh-e2e',
      });

      hivesDAL.createHive({
        name: 'live-acp-fresh-e2e-hive',
        description: 'Hive for live ACP+fresh deep E2E',
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

      // ── ACP capture hook ──────────────────────────────────────────────
      // Wrap wsHub.broadcast to capture every ACP event's full payload as
      // a JSON string. We then grep markers across the joined blob — the
      // agent's reply text, tool-call args, and tool-result content all
      // become searchable regardless of event-shape variation.
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
            // Stringify the entire event so any text the agent wrote —
            // chunks, tool-call args, tool-result content — is in scope
            // for the marker regex. JSON-string serialization is good
            // enough for the test's grep-like assertions.
            capturedAcpText.push(JSON.stringify(message));
          } catch {
            /* malformed event — skip */
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
        name: 'live-acp-fresh-e2e-owner',
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
      console.log(`[live-acp-fresh-e2e] OpenHive listening on port ${SERVER_PORT}`);

      console.log('[live-acp-fresh-e2e] Spawning real macro-agent swarm with bootstrap coordinator...');
      const hosted = await swarmManager.spawn(testAgent.id, {
        name: 'live-acp-fresh-e2e-swarm',
        adapter: 'macro-agent',
        hive: 'live-acp-fresh-e2e-hive',
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
      console.log(`[live-acp-fresh-e2e] Swarm spawned: ${hosted.id}, port=${assignedPort}`);

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
        console.warn(`[live-acp-fresh-e2e] Sidecar did not connect in 60s. Logs:\n${logs}`);
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
        console.log('[live-acp-fresh-e2e] Bootstrap coordinator registered');
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
      'freshly-spawned coordinator processes the dispatch prompt and replies with all four capability markers',
      async () => {
        expect(swarmId).toBeDefined();

        // Author loadout + team_template (must precede lookup)
        const ldtRes = await app.inject({
          method: 'POST',
          url: '/api/v1/loadouts',
          headers: { authorization: `Bearer ${testAgent.apiKey}` },
          payload: {
            name: 'live-acp-fresh-e2e-loadout',
            content: buildLoadoutContent(skillBankId),
          },
        });
        expect([201, 409]).toContain(ldtRes.statusCode);

        const tmplCreate = await app.inject({
          method: 'POST',
          url: '/api/v1/teams',
          headers: { authorization: `Bearer ${testAgent.apiKey}` },
          payload: {
            name: 'live-acp-fresh-e2e-team',
            content: buildTeamContent(skillBankId),
          },
        });
        expect([201, 409]).toContain(tmplCreate.statusCode);

        const finalTmpl = teamTemplatesDAL.getTeamTemplateByName(
          'live-acp-fresh-e2e-team',
          testAgent.id,
        );
        expect(finalTmpl).toBeTruthy();

        const specFetcher: SpecContentFetcher = {
          async fetch(_resourceId: string, _specId: string) {
            return {
              title: 'Live ACP Fresh Deep E2E Task',
              content: 'Execute the four tasks per the role addendum.',
              tasks: [],
              metadata: {
                team_role_ref: {
                  teamTemplateId: finalTmpl!.id,
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
          acp_lifecycle: 'fresh',
        });
        console.log(`[live-acp-fresh-e2e] Dispatch row inserted (id=${insertedDispatch.id})`);

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
        console.log('[live-acp-fresh-e2e] Orchestrator started (spawn-only)');

        // Wait for the agent's reply text to contain all four markers,
        // OR timeout. The coordinator runs through the four tasks and
        // emits text content via ACP session_update events captured by
        // the wsHub.broadcast hook above.
        const level2WaitMs = 120_000;
        console.log(
          `[live-acp-fresh-e2e] Waiting up to ${level2WaitMs / 1000}s for agent reply with capability markers...`,
        );
        const allMarkersSeen = await waitFor(
          () => {
            const all = capturedAcpText.join('\n');
            return (
              all.includes(SENTINEL) &&
              all.includes(SKILL_MARKER) &&
              /AGENT_COUNT\s*=\s*\d+/.test(all) &&
              /PERM_DENIED\s*=\s*(true|false)/i.test(all)
            );
          },
          level2WaitMs,
          1_000,
        );

        const allText = capturedAcpText.join('\n');
        console.log(
          `[live-acp-fresh-e2e] Captured ACP text fragments: ${capturedAcpText.length}\n` +
            `[live-acp-fresh-e2e] Combined excerpt: ${allText.slice(0, 1000)}`,
        );

        // Capability proofs (mirrors the mail test's assertions)
        const skillUsed = allText.includes(SKILL_MARKER);
        const sentinelSeen = allText.includes(SENTINEL);
        const agentCountMatch = allText.match(/AGENT_COUNT\s*=\s*(\d+)/);
        const mcpFollowThrough = agentCountMatch !== null;
        const reportedCount = mcpFollowThrough ? parseInt(agentCountMatch![1], 10) : null;
        const mcpActuallyInvoked = reportedCount !== null && reportedCount > 0;
        const permFollowThrough = /PERM_DENIED\s*=\s*(true|false)/i.test(allText);
        const permEnforced = /PERM_DENIED\s*=\s*true/i.test(allText);

        if (!allMarkersSeen) {
          const logs = await swarmManager
            .getLogs(hostedSwarmId!, testAgent.id, { lines: 100 })
            .catch(() => '(unavailable)');
          console.warn(
            `[live-acp-fresh-e2e] Not all markers seen within budget.\n` +
              `Captured ACP text:\n${allText}\n\n` +
              `Swarm logs (last 100 lines):\n${logs.slice(-4000)}`,
          );
        } else {
          console.log(
            `[live-acp-fresh-e2e] CAPABILITY PROVEN — addendum: ${sentinelSeen}; ` +
              `skill: ${skillUsed}; mcp: AGENT_COUNT=${reportedCount}; perm: PERM_DENIED=true`,
          );
        }

        expect(sentinelSeen).toBe(true);
        expect(skillUsed).toBe(true);
        expect(mcpFollowThrough).toBe(true);
        expect(mcpActuallyInvoked).toBe(true);
        expect(permFollowThrough).toBe(true);
        expect(permEnforced).toBe(true);
      },
      180_000,
    );
  },
);

// Note: an earlier version of this test had a `collectTextFromUpdate`
// helper that walked session_update payloads for text content. After
// observing the actual event shapes, we switched to JSON-stringifying
// the entire event for grep-like marker searches — simpler and tolerant
// of any payload variation. The walker is preserved in git history.
