/**
 * Dispatch mail-routing integration: materialized loadout content survives
 * the mail-port deliver() path.
 *
 * Covers the production path that has zero existing tests:
 *
 *   queued dispatch (team_role_ref) → source.queryReady → enrichWithLoadout
 *   → openHivePromptBuilder → createMailPort.deliver()
 *   → transport.sendToAgent({ type: 'x-dispatch/work', body: { prompt, … } })
 *   → assert prompt body contains promptAddendum marker
 *
 * Approach: "direct adapter drive" (not the full orchestrator).
 *
 * We drive the source adapter, prompt builder, and mail port directly without
 * wiring the orchestrator's polling loop. This is the pattern recommended by
 * the task brief when the full orchestrator would add unnecessary complexity.
 * All three layers (enrichment, prompt building, mail wrapping) are real
 * production code — only the underlying transport.sendToAgent is a stub.
 *
 * What this proves:
 *   - enrichWithLoadout materializes the promptAddendum from the DB.
 *   - openHivePromptBuilder embeds the addendum in the prompt string.
 *   - createMailPort.deliver() wraps the prompt into an x-dispatch/work
 *     envelope and calls transport.sendToAgent with the full body intact.
 *   - The body is not truncated, escaped, or mutated by the mail-port layer.
 *
 * What this does NOT prove:
 *   - The real MailTransport (agent-inbox path, MAP-scope path). The transport
 *     stub records sends without involving agent-inbox.
 *   - Orchestrator poll / claim / retry logic. That is covered by
 *     dispatch-source-prompt.test.ts and event-bridge.test.ts.
 *
 * No subprocess. No orchestrator polling. No network.
 *
 * Run:
 *   npx vitest run src/__tests__/integrations/dispatch-mail-routing.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import {
  createOpenHiveDispatchSource,
  type SpecContentFetcher,
} from '../../dispatch/openhive-source.js';
import { createOpenHiveMailPort, type MailTransport } from '../../dispatch/openhive-mail-port.js';
import { openHivePromptBuilder } from '../../dispatch/prompt.js';
import {
  registerInbound,
  unregisterInbound,
  type MapInboundConnection,
  type RegisteredAgent,
} from '../../map/connection-registry.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('dispatch-mail-routing');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'mail-routing.db');

/** Distinctive marker that must survive the full enrichment → prompt → mail chain. */
const ADDENDUM_MARKER = '## MAIL_ROUTING_INTEG_MARKER_7b9e1d';

/** Swarm / agent IDs registered as mail-capable (no ACP protocols). */
const MAIL_SWARM_ID = 'mail-test-swarm-001';
const MAIL_AGENT_ID = 'mail-test-agent-001';

// ============================================================================
// Fixture helpers
// ============================================================================

function mailCapableLoadout(addendum: string = ADDENDUM_MARKER): LoadoutContent {
  return {
    name: 'mail-role',
    capabilities: ['file.read'],
    permissions: { allow: ['Read(**)'] },
    prompt_addendum: addendum,
  };
}

function teamWithMailRole(): TeamTemplateContent {
  return {
    manifest: {
      name: 'mail-routing-demo',
      version: 1,
      roles: ['worker'],
      topology: { root: { role: 'worker' } },
    },
    roles: { worker: { name: 'worker', loadout: mailCapableLoadout() } },
    loadouts: {},
    prompts: {},
  };
}

function makeSpecFetcher(loadoutBinding: Record<string, unknown>): SpecContentFetcher {
  return {
    async fetch(_resourceId, specId) {
      return {
        title: `Mail Spec ${specId}`,
        content: 'Implement the mail-routed work item.',
        tasks: [],
        metadata: loadoutBinding,
      };
    },
  };
}

/**
 * Recorded call to transport.sendToAgent.
 */
interface RecordedSend {
  swarmId: string;
  agentId: string;
  message: { type: string; body: Record<string, unknown> };
}

/**
 * Stub MailTransport that records every sendToAgent call and returns
 * delivered:true so the mail port does not abort.
 */
function createRecordingTransport(): MailTransport & { recorded: RecordedSend[] } {
  const recorded: RecordedSend[] = [];
  return {
    recorded,
    async sendToAgent(swarmId, agentId, message) {
      recorded.push({ swarmId, agentId, message });
      return { delivered: true };
    },
    onMessage(_handler) {
      return () => {};
    },
  };
}

/**
 * Register a minimal mail-capable (no ACP) inbound connection so that
 * createOpenHiveMailPort.isReachable() returns true.
 * The agent declares mail.canJoin; it intentionally has no 'protocols: acp'
 * so routing.canRouteToSwarm() would choose 'mail', not 'acp'.
 */
function createMockWs(): WebSocket {
  const ee = new EventEmitter() as unknown as WebSocket;
  (ee as unknown as Record<string, unknown>).readyState = 1; // OPEN
  (ee as unknown as Record<string, unknown>).send = () => {};
  (ee as unknown as Record<string, unknown>).close = () => {};
  (ee as unknown as Record<string, unknown>).terminate = () => {};
  return ee;
}

function registerMailSwarm(): void {
  const agent: RegisteredAgent = {
    id: MAIL_AGENT_ID,
    name: 'mail-worker',
    role: 'worker',
    state: 'idle',
    scopes: [],
    capabilities: {
      // mail-capable only — no ACP protocols
      mail: { canJoin: true },
      messaging: { canReceive: true },
    },
  };

  const conn: MapInboundConnection = {
    ws: createMockWs(),
    agentId: MAIL_AGENT_ID,
    swarmId: MAIL_SWARM_ID,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: new Map([[MAIL_AGENT_ID, agent]]),
  };

  registerInbound(MAIL_SWARM_ID, conn);
}

// ============================================================================
// Tests
// ============================================================================

describe('dispatch mail-routing integration', () => {
  let agentId: string;
  let claimantId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'mail-routing-test-agent' });
    agentId = agent.id;
    claimantId = `orchestrator-${agent.id}`;
    registerMailSwarm();
  });

  afterAll(() => {
    try {
      unregisterInbound(MAIL_SWARM_ID);
    } catch {
      /* best effort */
    }
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    _resetCacheForTest();
    const db = getDatabase();
    db.prepare('DELETE FROM dispatches').run();
    db.prepare('DELETE FROM syncable_resources').run();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Core assertion: materialized addendum reaches the mail-port send body
  // ─────────────────────────────────────────────────────────────────────────

  it(
    'mail port deliver() body contains the materialized promptAddendum from a team_role_ref loadout',
    async () => {
      // Author the team template with the distinctive marker in the loadout.
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'mail-routing-demo',
        content: teamWithMailRole(),
        ownerAgentId: agentId,
      });

      // Insert a queued dispatch targeting the mail-capable swarm.
      const dispatch = dispatchesDAL.createDispatch({
        spec_resource_id: 'res_mail_spec',
        spec_id: 'mail-001',
        target_swarm_id: MAIL_SWARM_ID,
        initiator_type: 'user',
        initiator_id: agentId,
      });

      // Source enriches via spec fetch + loadout materialization.
      const source = createOpenHiveDispatchSource(
        makeSpecFetcher({
          team_role_ref: { teamTemplateId: tmpl.id, role: 'worker' },
        }),
        claimantId,
      );

      // queryReady → enrich (wraps enrichContent) → enriched task.
      const ready = await source.queryReady({ limit: 10 });
      const found = ready.find((t) => t.id === dispatch.id);
      expect(found).toBeTruthy();

      const enriched = found!;

      // Confirm materialization happened before involving the mail port.
      expect(enriched.metadata?.materializedLoadout).toBeTruthy();
      expect(enriched.metadata?.loadout_error).toBeUndefined();

      // Build the prompt the orchestrator would send.
      const prompt = openHivePromptBuilder(enriched, {
        attempt: 1,
        turnCount: 0,
        role: 'worker',
      }) as string;

      // The addendum must be present in the built prompt.
      expect(prompt).toContain(ADDENDUM_MARKER);

      // Now drive the mail port with the same stub transport.
      const transport = createRecordingTransport();
      const mailPort = createOpenHiveMailPort(transport);

      // deliver() is the method the orchestrator's executeOnce() calls
      // when routing via mail (messagePort.deliver(executor.to, { prompt, taskId, role })).
      const receipt = await mailPort.deliver(
        { system: MAIL_SWARM_ID, agentId: MAIL_AGENT_ID },
        { prompt, taskId: dispatch.id, role: 'worker' },
      );

      // Delivery must succeed.
      expect(receipt.delivered).toBe(true);

      // The transport must have recorded exactly one send call.
      expect(transport.recorded).toHaveLength(1);

      const recorded = transport.recorded[0];

      // Envelope type must be the x-dispatch/work convention.
      expect(recorded.message.type).toBe('x-dispatch/work');

      // The body must carry the prompt.
      const body = recorded.message.body as { prompt?: string; taskId?: string; role?: string };
      expect(typeof body.prompt).toBe('string');

      // The addendum marker must be present verbatim in the delivered body.
      expect(body.prompt).toContain(ADDENDUM_MARKER);

      // Task and role are correctly threaded through.
      expect(body.taskId).toBe(dispatch.id);
      expect(body.role).toBe('worker');

      // The body must not be empty or suspiciously short (truncation guard).
      expect((body.prompt as string).length).toBeGreaterThan(ADDENDUM_MARKER.length);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Regression: body is NOT truncated when the prompt is large
  // ─────────────────────────────────────────────────────────────────────────

  it('mail port preserves full prompt body including a large spec + addendum without truncation', async () => {
    // Craft a loadout with a multi-section addendum that would reveal truncation.
    const longAddendum = [
      ADDENDUM_MARKER,
      '## Section A',
      'a'.repeat(2000),
      '## Section B',
      'b'.repeat(2000),
      '## Section C — tail sentinel',
      'TAIL_SENTINEL_XYZ',
    ].join('\n');

    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'mail-large-loadout',
      content: {
        manifest: {
          name: 'mail-large-loadout',
          version: 1,
          roles: ['worker'],
          topology: { root: { role: 'worker' } },
        },
        roles: {
          worker: {
            name: 'worker',
            loadout: {
              name: 'large-worker',
              capabilities: ['file.read'],
              permissions: { allow: ['Read(**)'] },
              prompt_addendum: longAddendum,
            },
          },
        },
        loadouts: {},
        prompts: {},
      } satisfies TeamTemplateContent,
      ownerAgentId: agentId,
    });

    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_mail_large_spec',
      spec_id: 'mail-large-002',
      target_swarm_id: MAIL_SWARM_ID,
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const source = createOpenHiveDispatchSource(
      makeSpecFetcher({
        team_role_ref: { teamTemplateId: tmpl.id, role: 'worker' },
      }),
      claimantId,
    );

    const ready = await source.queryReady({ limit: 10 });
    const enriched = ready.find((t) => t.id === dispatch.id)!;
    expect(enriched).toBeTruthy();

    const prompt = openHivePromptBuilder(enriched, {
      attempt: 1,
      turnCount: 0,
      role: 'worker',
    }) as string;

    // Both ends of the addendum must survive prompt building.
    expect(prompt).toContain(ADDENDUM_MARKER);
    expect(prompt).toContain('TAIL_SENTINEL_XYZ');

    const transport = createRecordingTransport();
    const mailPort = createOpenHiveMailPort(transport);

    const receipt = await mailPort.deliver(
      { system: MAIL_SWARM_ID, agentId: MAIL_AGENT_ID },
      { prompt, taskId: dispatch.id, role: 'worker' },
    );

    expect(receipt.delivered).toBe(true);
    expect(transport.recorded).toHaveLength(1);

    const body = transport.recorded[0].message.body as { prompt?: string };
    expect(body.prompt).toContain(ADDENDUM_MARKER);
    // Tail sentinel proves the body was not truncated mid-addendum.
    expect(body.prompt).toContain('TAIL_SENTINEL_XYZ');
    // Full length preserved: prompt body length must equal the prompt string.
    expect(body.prompt).toBe(prompt);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Regression: loadout_error does NOT appear when the template exists
  // ─────────────────────────────────────────────────────────────────────────

  it('no loadout_error on task metadata when team_role_ref resolves successfully', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'mail-routing-error-check',
      content: teamWithMailRole(),
      ownerAgentId: agentId,
    });

    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_mail_spec_err',
      spec_id: 'mail-003',
      target_swarm_id: MAIL_SWARM_ID,
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const source = createOpenHiveDispatchSource(
      makeSpecFetcher({
        team_role_ref: { teamTemplateId: tmpl.id, role: 'worker' },
      }),
      claimantId,
    );

    const ready = await source.queryReady({ limit: 10 });
    const enriched = ready.find((t) => t.id === dispatch.id)!;
    expect(enriched).toBeTruthy();
    expect(enriched.metadata?.loadout_error).toBeUndefined();
    expect(enriched.metadata?.materializedLoadout).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Route decision: swarm without ACP routes to mail
  // ─────────────────────────────────────────────────────────────────────────

  it('canRouteToSwarm returns mail for a mail-only swarm (no ACP agent registered)', async () => {
    // Import routing inline to avoid circular-import issues at module level.
    const { canRouteToSwarm, _resetDispatchRouting } = await import(
      '../../dispatch/routing.js'
    );

    // ACP probe is false by default (reset to baseline).
    _resetDispatchRouting();

    const decision = canRouteToSwarm(MAIL_SWARM_ID);
    expect(decision.route).toBe('mail');
  });
});
