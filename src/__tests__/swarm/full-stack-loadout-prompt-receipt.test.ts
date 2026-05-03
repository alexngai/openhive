/**
 * Full Stack E2E: dispatch orchestrator delivers materialized loadout content
 * to the runtime layer (ACP prompt receipt verification).
 *
 * Boots the same OpenHive infrastructure (Fastify + real OpenSwarm + macro-agent subprocess)
 * as full-stack-e2e.test.ts, but wires the dispatch orchestrator with a stub AcpStreamManager
 * that records every prompt() call. A queued dispatch row bound to a loadout
 * containing a distinctive marker string is inserted; the test waits for
 * the orchestrator to poll, claim, enrich (enrichWithLoadout), build the
 * prompt, and deliver it to the stub runtime. The stub captures the text.
 * The test asserts the marker string is present in the captured prompt.
 *
 * ─── What this proves ───────────────────────────────────────────────────────
 * The full orchestrator pipeline runs end-to-end in the booted environment:
 *
 *   dispatch row (queued)
 *     → source polls + claims (DAL fence token)
 *     → enrichWithSpec (stub fetcher injects loadout binding)
 *     → enrichWithLoadout (materializeRoleLoadout against live DB)
 *     → prompt builder (openHivePromptBuilder embeds promptAddendum)
 *     → runtime.sendPrompt (stub AcpStreamManager records the text)
 *     → captured prompt contains ADDENDUM_MARKER
 *
 * ─── What this does NOT prove ───────────────────────────────────────────────
 * Prompt receipt by macro-agent's actual ACP handler. That would require
 * a full SwarmCraft plugin + inbound ACP WS stream, which is not wired in
 * the test-scoped Fastify setup. The stub intercepts at the runtime
 * boundary (the same interface OpenHive's production code calls). The
 * macro-agent subprocess IS spawned and stays healthy throughout, confirming
 * the booted environment is consistent with production, but the ACP
 * delivery leg is stubbed. Adding real delivery observation would require
 * either: (a) wiring the full SwarmCraft plugin and subscribing to
 * acp.session.update WS events, or (b) a MAP extension on macro-agent that
 * echoes received prompts — neither exists today.
 *
 * ─── Constraints ────────────────────────────────────────────────────────────
 * REQUIRES: FULL_STACK_E2E=true
 * REQUIRES: OpenSwarm built (references/openswarm/dist/server.mjs or npm pkg)
 * REQUIRES: macro-agent built (references/macro-agent/dist/)
 *
 * Run:
 *   FULL_STACK_E2E=true npx vitest run \
 *     src/__tests__/swarm/full-stack-loadout-prompt-receipt.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import * as path from 'path';
import * as fs from 'fs';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';

import * as dispatchesDAL from '../../db/dal/dispatches.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { teamsRoutes } from '../../api/routes/teams.js';
import { loadoutsRoutes } from '../../api/routes/loadouts.js';
import { SwarmManager } from '../../swarm/manager.js';
import { ConfigSchema, type Config } from '../../config.js';
import { initTokenService } from '../../map/token-service.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import {
  materializeRoleLoadout,
} from '../../openteams/resolver.js';
import { setupOrchestrator } from '../../dispatch/setup.js';
import type { AcpStreamManager } from '../../dispatch/openhive-runtime.js';
import type { SpecContentFetcher } from '../../dispatch/openhive-source.js';
import {
  registerInbound,
  unregisterInbound,
  type MapInboundConnection,
  type RegisteredAgent,
} from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';
import type { Orchestrator } from 'swarm-dispatch';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';

// ============================================================================
// Gate
// ============================================================================

const IS_FULL_STACK = process.env.FULL_STACK_E2E === 'true';
const describeFn = IS_FULL_STACK ? describe : describe.skip;

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('full-stack-loadout-prompt-receipt');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'fullstack-prompt-receipt.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-data');

const PORT_RANGE_MIN = 19640;
const PORT_RANGE_MAX = 19650;
const SERVER_PORT = 19739;

const OPENSWARM_BIN = path.resolve(
  __dirname,
  '../../../node_modules/openswarm/bin/openswarm.mjs',
);

/**
 * A distinctive marker that must appear in the materialized loadout's
 * prompt_addendum and, after orchestrator enrichment, in the captured
 * ACP prompt text.
 */
const PROMPT_RECEIPT_MARKER = '## PROMPT_RECEIPT_E2E_MARKER_9f3a2c';

// Fake swarm / agent ids used to seed the connection registry so the
// orchestrator's runtime resolveTarget() can find an ACP-capable agent.
const FAKE_SWARM_ID = 'fake-swarm-prompt-receipt-001';
const FAKE_AGENT_PEER_MAP_ID = 'fake-peer-map-agent-001';
const FAKE_AGENT_HUB_ID = 'fake-hub-agent-001';

// ============================================================================
// Helpers
// ============================================================================

function createTestConfig(): Config {
  return ConfigSchema.parse({
    port: SERVER_PORT,
    host: '127.0.0.1',
    database: TEST_DB_PATH,
    instance: {
      name: 'Full Stack Prompt Receipt E2E',
      description: 'Full stack prompt receipt test',
    },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    mapHub: { iamSecret: 'test-iam-secret-fs-prompt-receipt' },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      openswarm_command: `node ${OPENSWARM_BIN} serve`,
      data_dir: TEST_DATA_DIR,
      port_range: [PORT_RANGE_MIN, PORT_RANGE_MAX],
      max_swarms: 2,
      health_check_interval: 600000,
      max_health_failures: 3,
      auto_restart: false,
    },
  });
}

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 300,
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

function loadoutContent(): LoadoutContent {
  return {
    name: 'prompt-receipt-loadout',
    description: 'Loadout for prompt receipt E2E',
    capabilities: ['file.read'],
    permissions: { allow: ['Read(**)'] },
    prompt_addendum: PROMPT_RECEIPT_MARKER,
    mcp_servers: [],
  };
}

function teamWithRole(): TeamTemplateContent {
  return {
    manifest: {
      name: 'prompt-receipt-team',
      version: 1,
      roles: ['executor'],
      topology: { root: { role: 'executor' } },
    },
    roles: { executor: { loadout: loadoutContent() } },
    loadouts: {},
    prompts: {},
  };
}

/**
 * Create a minimal mock WebSocket that satisfies the MapInboundConnection
 * type. The orchestrator's runtime resolveTarget() calls into
 * findAcpAgentInfo(), which only reads from the connection registry —
 * it never writes to the WS. This stub is therefore write-only-ignored.
 */
function createMockWs(): WebSocket {
  const ee = new EventEmitter() as unknown as WebSocket;
  (ee as unknown as Record<string, unknown>).readyState = 1; // OPEN
  (ee as unknown as Record<string, unknown>).send = () => {};
  (ee as unknown as Record<string, unknown>).close = () => {};
  (ee as unknown as Record<string, unknown>).terminate = () => {};
  return ee;
}

/**
 * Register a fake swarm connection in the in-memory registry so that
 * findAcpAgentInfo(FAKE_SWARM_ID) returns a valid ACP-capable agent target.
 *
 * The agent declares `protocols: ['acp']` so findAcpAgentInfo() picks it up.
 * `peerMapId` in metadata is what the ACP stream would be opened against.
 */
function registerFakeSwarm(): void {
  const agent: RegisteredAgent = {
    id: FAKE_AGENT_HUB_ID,
    name: 'fake-coordinator',
    role: 'coordinator',
    state: 'idle',
    scopes: [],
    capabilities: {
      protocols: ['acp'],
      acp: { version: '2024-10-07' },
    },
    metadata: {
      peerMapId: FAKE_AGENT_PEER_MAP_ID,
    },
  };

  const conn: MapInboundConnection = {
    ws: createMockWs(),
    agentId: FAKE_AGENT_HUB_ID,
    swarmId: FAKE_SWARM_ID,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: new Map([[FAKE_AGENT_HUB_ID, agent]]),
  };

  registerInbound(FAKE_SWARM_ID, conn);
}

/**
 * Stub AcpStreamManager that records every prompt() call.
 * The orchestrator's createStreamRuntime calls these methods sequentially:
 *   createStream → initialize → newSession → sendPrompt (calls prompt())
 *
 * We capture the prompt text in sendPrompt so tests can assert on it.
 */
interface RecordingAcpStreamManager extends AcpStreamManager {
  capturedPrompts: Array<{ streamId: string; sessionId: string; text: string }>;
}

function createRecordingAcpStreamManager(): RecordingAcpStreamManager {
  const capturedPrompts: Array<{
    streamId: string;
    sessionId: string;
    text: string;
  }> = [];

  let nextStreamId = 0;
  let nextSessionId = 0;

  return {
    capturedPrompts,

    async createStream(_serverId: string, _agentId: string) {
      return { streamId: `stub-stream-${++nextStreamId}` };
    },

    async closeStream(_id: string) {
      // no-op
    },

    async initialize(_streamId: string) {
      return {};
    },

    async newSession(_streamId: string, _input: { cwd: string; mcpServers: unknown[] }) {
      return { sessionId: `stub-session-${++nextSessionId}` };
    },

    async prompt(
      streamId: string,
      input: { sessionId: string; prompt: Array<{ type: string; text?: string }> },
    ) {
      const text = input.prompt
        .filter((b): b is { type: string; text: string } => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      capturedPrompts.push({ streamId, sessionId: input.sessionId, text });
      // Return end_turn so the orchestrator considers this dispatch complete.
      return { stopReason: 'end_turn' };
    },
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describeFn(
  'Full Stack Prompt Receipt E2E: materialized loadout addendum reaches dispatch runtime',
  () => {
    let app: FastifyInstance;
    let swarmManager: SwarmManager;
    let config: Config;
    let agentApiKey: string;
    let agentId: string;
    let spawnedSwarmId: string;
    let assignedPort: number;
    let orchestrator: Orchestrator;
    let recordingMgr: RecordingAcpStreamManager;

    beforeAll(async () => {
      if (!fs.existsSync(OPENSWARM_BIN)) {
        throw new Error(
          `OpenSwarm binary not found at ${OPENSWARM_BIN}. ` +
            `Build it first: cd references/openswarm && npm run build:server`,
        );
      }

      config = createTestConfig();
      initDatabase(TEST_DB_PATH);
      _resetCacheForTest();

      // Token service required for hosted-swarm spawn (mints onboard token).
      initTokenService(config.mapHub.iamSecret, path.dirname(TEST_DB_PATH));

      const agentResult = await agentsDAL.createAgent({
        name: 'prompt-receipt-agent',
        description: 'Agent for prompt receipt E2E',
      });
      agentApiKey = agentResult.apiKey;
      agentId = agentResult.agent.id;

      const agentsByKey = new Map<string, { id: string; name: string }>();
      agentsByKey.set(agentResult.apiKey, {
        id: agentResult.agent.id,
        name: 'prompt-receipt-agent',
      });

      swarmManager = new SwarmManager(
        config.swarmHosting as never,
        `http://127.0.0.1:${SERVER_PORT}`,
      );

      app = Fastify({ logger: false });
      app.decorateRequest('agent');
      app.addHook(
        'preHandler',
        async (
          request: {
            headers: { authorization?: string };
            agent?: unknown;
          },
        ) => {
          const auth = request.headers.authorization;
          if (auth && auth.startsWith('Bearer ')) {
            const token = auth.slice(7);
            const agent = agentsByKey.get(token);
            if (agent) request.agent = agent;
          }
        },
      );

      (app as unknown as { swarmManager: SwarmManager }).swarmManager =
        swarmManager;
      await app.register(websocket);

      await app.register(
        async (api) => {
          await api.register(swarmHostingRoutes, { config } as never);
          await api.register(teamsRoutes, { config });
          await api.register(loadoutsRoutes, { config });
        },
        { prefix: '/api/v1' },
      );

      await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
      console.log(
        `[prompt-receipt] OpenHive listening on port ${SERVER_PORT}`,
      );
    }, 30000);

    afterAll(async () => {
      // Stop orchestrator if running
      if (orchestrator) {
        try {
          await orchestrator.stop();
        } catch {
          /* best effort */
        }
      }

      // Clean up fake swarm from registry
      try {
        unregisterInbound(FAKE_SWARM_ID);
      } catch {
        /* best effort */
      }

      if (spawnedSwarmId && swarmManager) {
        try {
          await swarmManager.stop(spawnedSwarmId, '');
        } catch {
          /* best effort */
        }
      }
      if (app) await app.close();
      closeDatabase();
      cleanTestRoot(TEST_ROOT);
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Step 1: author loadout + team template
    // ──────────────────────────────────────────────────────────────────────────

    it('authors loadout and team_template via REST', async () => {
      const ldtRes = await app.inject({
        method: 'POST',
        url: '/api/v1/loadouts',
        headers: { authorization: `Bearer ${agentApiKey}` },
        payload: {
          name: 'prompt-receipt-loadout',
          content: loadoutContent(),
        },
      });
      expect(ldtRes.statusCode).toBe(201);

      const tmplRes = await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { authorization: `Bearer ${agentApiKey}` },
        payload: {
          name: 'prompt-receipt-team',
          content: teamWithRole(),
        },
      });
      expect(tmplRes.statusCode).toBe(201);
    }, 10000);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 2: spawn macro-agent subprocess (proves real-process environment)
    // ──────────────────────────────────────────────────────────────────────────

    it('spawns a hosted swarm with macro-agent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/hosted/spawn',
        headers: { authorization: `Bearer ${agentApiKey}` },
        payload: { name: 'prompt-receipt-swarm', adapter: 'macro-agent' },
      });

      if (res.statusCode !== 201) {
        console.error(`[spawn-debug] status=${res.statusCode} body=${res.body}`);
      }
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { id: string; assigned_port: number };
      spawnedSwarmId = body.id;
      assignedPort = body.assigned_port;
    }, 15000);

    it('macro-agent process becomes healthy', async () => {
      const healthy = await waitFor(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${assignedPort + 1}/health`);
          return res.ok;
        } catch {
          return false;
        }
      }, 45000);
      expect(healthy).toBe(true);

      const logs = await swarmManager.getLogs(spawnedSwarmId, agentId, {
        lines: 10,
      });
      console.log(
        `[prompt-receipt] subprocess log sample (${logs.length} chars)`,
      );
      expect(logs.length).toBeGreaterThan(0);
    }, 60000);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 3: verify materialization works in this booted environment
    // ──────────────────────────────────────────────────────────────────────────

    it('materializes the role loadout and confirms marker is present', async () => {
      const tmpl = teamTemplatesDAL.getTeamTemplateByName(
        'prompt-receipt-team',
        agentId,
      );
      expect(tmpl).toBeTruthy();

      const materialized = await materializeRoleLoadout(tmpl!.id, 'executor');
      expect(materialized.promptAddendum).toContain(PROMPT_RECEIPT_MARKER);
    }, 15000);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 4: orchestrator delivers materialized marker to the ACP runtime
    //
    // This is the core assertion. We:
    //   (a) register a fake inbound swarm with an ACP-capable agent so the
    //       runtime's resolveTarget() succeeds
    //   (b) seed a dispatch row bound to the team_role_ref for our loadout
    //   (c) start the orchestrator with a fast poll interval and the
    //       recording stub as the AcpStreamManager
    //   (d) wait for capturedPrompts to contain the marker
    // ──────────────────────────────────────────────────────────────────────────

    it(
      'dispatch orchestrator delivers materialized addendum marker to runtime sendPrompt',
      async () => {
        // (a) Register fake swarm so resolveTarget can find an ACP agent
        registerFakeSwarm();

        // (b) Seed the team template id for the spec fetcher
        const tmpl = teamTemplatesDAL.getTeamTemplateByName(
          'prompt-receipt-team',
          agentId,
        );
        expect(tmpl).toBeTruthy();

        const SPEC_RESOURCE_ID = 'res_prompt_receipt_spec';
        const SPEC_ID = 'spec_prompt_receipt_001';

        // The spec fetcher returns metadata with a team_role_ref so that
        // enrichWithLoadout() will materialize the loadout for the 'executor' role.
        const specFetcher: SpecContentFetcher = {
          async fetch(_resourceId: string, _specId: string) {
            return {
              title: 'Prompt Receipt E2E Spec',
              content: 'Implement the test task.',
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

        // Create the recording stub ACP stream manager
        recordingMgr = createRecordingAcpStreamManager();

        // (b) Insert a queued dispatch row targeting the fake swarm
        dispatchesDAL.createDispatch({
          spec_resource_id: SPEC_RESOURCE_ID,
          spec_id: SPEC_ID,
          target_swarm_id: FAKE_SWARM_ID,
          initiator_type: 'user',
          initiator_id: agentId,
          status: 'queued',
        });

        // (c) Start the orchestrator with a fast poll so the test doesn't take
        //     the full 15s default interval to detect the queued row.
        orchestrator = setupOrchestrator({
          specFetcher,
          runtimeDeps: {
            getAcpStreamManager: () => recordingMgr,
          },
          dispatchConfig: {
            pollIntervalMs: 500, // fast poll for test
            globalConcurrency: 5,
            retry: { maxRetries: 0, baseDelayMs: 1000, maxDelayMs: 5000 },
            reconcileIntervalMs: 30000,
            scorer: 'noop',
          },
        });

        await orchestrator.start();

        // (d) Wait for the stub's capturedPrompts to receive a prompt
        //     containing the marker. Budget 20s — the orchestrator polls at
        //     500ms so typically resolves in < 2s.
        const received = await waitFor(
          () =>
            recordingMgr.capturedPrompts.some((p) =>
              p.text.includes(PROMPT_RECEIPT_MARKER),
            ),
          20000,
          200,
        );

        if (!received) {
          console.error(
            '[prompt-receipt] Captured prompts at timeout:',
            JSON.stringify(recordingMgr.capturedPrompts, null, 2),
          );
        }

        expect(received).toBe(true);

        // Verify the full marker is present verbatim in at least one prompt
        const matchingPrompt = recordingMgr.capturedPrompts.find((p) =>
          p.text.includes(PROMPT_RECEIPT_MARKER),
        );
        expect(matchingPrompt).toBeDefined();
        expect(matchingPrompt!.text).toContain(PROMPT_RECEIPT_MARKER);

        console.log(
          `[prompt-receipt] Marker confirmed in captured prompt (streamId=${matchingPrompt!.streamId})`,
        );
        console.log(
          `[prompt-receipt] Prompt excerpt: ${matchingPrompt!.text.slice(0, 300)}...`,
        );
      },
      30000,
    );

    // ──────────────────────────────────────────────────────────────────────────
    // Step 5: confirm macro-agent subprocess is still alive
    // ──────────────────────────────────────────────────────────────────────────

    it('macro-agent process stays healthy after orchestrator dispatch', async () => {
      const healthy = await waitFor(async () => {
        try {
          const res = await fetch(
            `http://127.0.0.1:${assignedPort + 1}/health`,
          );
          return res.ok;
        } catch {
          return false;
        }
      }, 5000);
      expect(healthy).toBe(true);
    }, 10000);

    it('stops the swarm cleanly', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/map/hosted/${spawnedSwarmId}/stop`,
        headers: { authorization: `Bearer ${agentApiKey}` },
      });
      expect(res.statusCode).toBe(200);
      spawnedSwarmId = '';
    }, 15000);
  },
);
