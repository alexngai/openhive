/**
 * Multi-attempt / retry / continuation dispatch prompts with materialized loadout.
 *
 * Drives queued dispatches through `createOpenHiveDispatchSource` (the same
 * path the orchestrator takes in production) and verifies `openHivePromptBuilder`
 * produces the correct output for all four turn/attempt combinations when a
 * loadout is bound.
 *
 * Cases covered:
 *   1. First-run (attempt=1, turn=0)  — control: addendum present.
 *   2. Retry first-turn (attempt=2, turn=0) — retry banner + addendum present.
 *   3. Continuation (attempt=1, turn=1) — continuation message, no loadout sections.
 *   4. Retry on continuation (attempt=2, turn=1) — still a continuation prompt;
 *      the builder short-circuits on turnCount > 0 before reaching retry handling,
 *      so the retry banner does NOT appear.
 *   5. Skill bridge: compileSkillsForLoadout is exercised via a mocked
 *      getServingLayerByResourceId — rendered skills appear at the top of the
 *      first-run prompt and materializedLoadout.skills is populated.
 *
 * Mirrors setup from `dispatch-source-prompt.test.ts`. No subprocess, no
 * orchestrator polling — just source adapter enrichment + prompt builder.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import {
  createOpenHiveDispatchSource,
  type SpecContentFetcher,
} from '../../dispatch/openhive-source.js';
import { openHivePromptBuilder } from '../../dispatch/prompt.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';
import type { MaterializedLoadout } from '../../openteams/types.js';
// Import the serving module so we can spy on its export in the skill-bridge test.
import * as servingModule from '../../skill-tree/serving.js';

const RENDERED_SKILLS_MARKER = '<skills>\n  <skill name="bridge-test-skill" />\n</skills>';
const FAKE_SKILL_BANK_REF = 'res_fake_skillbank';

const TEST_ROOT = testRoot('dispatch-multi-turn');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'multi-turn.db');

const ADDENDUM_MARKER = '## MULTI_TURN_ADDENDUM';

function reviewerLoadout(): LoadoutContent {
  return {
    name: 'reviewer',
    capabilities: ['file.read'],
    permissions: { allow: ['Read(**)'] },
    prompt_addendum: ADDENDUM_MARKER,
  };
}

function teamWithReviewer(): TeamTemplateContent {
  return {
    manifest: {
      name: 'multi-turn-demo',
      version: 1,
      roles: ['reviewer'],
      topology: { root: { role: 'reviewer' } },
    },
    roles: {
      reviewer: {
        loadout: reviewerLoadout(),
      },
    },
    loadouts: {},
    prompts: {},
  };
}

function makeSpecFetcher(teamTemplateId: string): SpecContentFetcher {
  return {
    async fetch(_resourceId, specId) {
      return {
        title: `Spec ${specId}`,
        content: 'Spec body content for multi-turn test',
        tasks: [],
        metadata: {
          team_role_ref: { teamTemplateId, role: 'reviewer' },
        },
      };
    },
  };
}

/**
 * Build a spec fetcher whose team loadout includes an openhive.skillBankRef
 * extension so compileSkillsForLoadout is invoked during materialization.
 * The mocked getServingLayerByResourceId intercepts the call.
 */
function makeSpecFetcherWithSkillBank(teamTemplateId: string): SpecContentFetcher {
  return {
    async fetch(_resourceId, specId) {
      return {
        title: `Spec ${specId}`,
        content: 'Spec body with skill bank',
        tasks: [],
        metadata: {
          team_role_ref: { teamTemplateId, role: 'reviewer' },
        },
      };
    },
  };
}

describe('dispatch multi-turn / retry / continuation prompts with materialized loadout', () => {
  let agentId: string;
  let claimantId: string;
  let teamTemplateId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'multi-turn-agent' });
    agentId = agent.id;
    claimantId = `orchestrator-${agent.id}`;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    _resetCacheForTest();
    const db = getDatabase();
    db.prepare('DELETE FROM dispatches').run();
    db.prepare('DELETE FROM syncable_resources').run();

    // Team template lives in syncable_resources so it must be recreated after
    // each wipe. Matches the pattern in dispatch-source-prompt.test.ts where
    // each test creates its own team template inside the test body.
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'multi-turn-demo',
      content: teamWithReviewer(),
      ownerAgentId: agentId,
    });
    teamTemplateId = tmpl.id;
  });

  /**
   * Helper: create a dispatch row and run it through the source adapter's
   * getTask (which materializes the loadout). Returns the enriched task
   * ready for prompt building. Skills are not injected here — tests that
   * need skill content use the skill-bridge test or provide their own loadout.
   */
  async function enrichedTask(specId: string) {
    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_multi_turn_spec',
      spec_id: specId,
      target_swarm_id: 'swarm_multi_turn',
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const source = createOpenHiveDispatchSource(
      makeSpecFetcher(teamTemplateId),
      claimantId,
    );

    return source.getTask(dispatch.id);
  }

  // -------------------------------------------------------------------------
  // Case 1: first-run (attempt=1, turn=0) — control
  // -------------------------------------------------------------------------
  it('case 1 — first-run: addendum appears in prompt below the spec body', async () => {
    const task = await enrichedTask('mt-spec-1');

    const prompt = openHivePromptBuilder(task, {
      attempt: 1,
      turnCount: 0,
      role: 'reviewer',
    }) as string;

    // Spec body is present.
    const bodyIdx = prompt.indexOf('Spec body content');
    expect(bodyIdx).toBeGreaterThanOrEqual(0);

    // Addendum appears below the body.
    const addendumIdx = prompt.indexOf(ADDENDUM_MARKER);
    expect(addendumIdx).toBeGreaterThan(bodyIdx);

    // Role line appears at the end.
    const roleIdx = prompt.indexOf('Role: reviewer');
    expect(roleIdx).toBeGreaterThan(addendumIdx);

    // No retry banner.
    expect(prompt).not.toContain('Retry attempt');

    // No continuation text.
    expect(prompt).not.toContain('Continue work on dispatch');
  });

  // -------------------------------------------------------------------------
  // Case 2: retry first-turn (attempt=2, turn=0) — retry banner + addendum
  // -------------------------------------------------------------------------
  it('case 2 — retry first-turn: retry banner appears above body; addendum still present', async () => {
    const task = await enrichedTask('mt-spec-2');

    const prompt = openHivePromptBuilder(task, {
      attempt: 2,
      turnCount: 0,
      previousError: 'something failed on attempt 1',
      role: 'reviewer',
    }) as string;

    // Retry banner is present.
    expect(prompt).toContain('Retry attempt 2');
    expect(prompt).toContain('something failed on attempt 1');

    // Banner appears before the body.
    const bannerIdx = prompt.indexOf('Retry attempt 2');
    const bodyIdx = prompt.indexOf('Spec body content');
    expect(bannerIdx).toBeLessThan(bodyIdx);

    // Addendum is still present (turnCount=0 means full-context attempt).
    expect(prompt).toContain(ADDENDUM_MARKER);
    const addendumIdx = prompt.indexOf(ADDENDUM_MARKER);
    expect(addendumIdx).toBeGreaterThan(bodyIdx);

    // No continuation text.
    expect(prompt).not.toContain('Continue work on dispatch');
  });

  // -------------------------------------------------------------------------
  // Case 3: continuation (attempt=1, turn=1) — no loadout sections
  // -------------------------------------------------------------------------
  it('case 3 — continuation turn: continuation message present; no addendum', async () => {
    const task = await enrichedTask('mt-spec-3');

    const prompt = openHivePromptBuilder(task, {
      attempt: 1,
      turnCount: 1,
      role: 'reviewer',
    }) as string;

    // Continuation message is present.
    expect(prompt).toContain('Continue work on dispatch');
    expect(prompt).toContain('turn 2');

    // Materialized addendum must NOT appear.
    expect(prompt).not.toContain(ADDENDUM_MARKER);

    // No retry banner.
    expect(prompt).not.toContain('Retry attempt');

    // Role line still appears.
    expect(prompt).toContain('Role: reviewer');
  });

  // -------------------------------------------------------------------------
  // Case 4: retry on continuation turn (attempt=2, turn=1)
  //
  // The builder returns early on turnCount > 0 (line 35-41 of prompt.ts),
  // before reaching the retry-banner block (line 43-49). Result: a plain
  // continuation prompt — no retry banner, no loadout sections. This is the
  // documented short-circuit: "turn-aware" wins over "attempt-aware".
  // -------------------------------------------------------------------------
  it('case 4 — retry on continuation: short-circuits to continuation; no retry banner, no loadout', async () => {
    const task = await enrichedTask('mt-spec-4');

    const prompt = openHivePromptBuilder(task, {
      attempt: 2,
      turnCount: 1,
      previousError: 'X',
      role: 'reviewer',
    }) as string;

    // Still a continuation prompt.
    expect(prompt).toContain('Continue work on dispatch');

    // Retry banner does NOT appear — turn-aware branch returns early.
    expect(prompt).not.toContain('Retry attempt');
    expect(prompt).not.toContain('The previous attempt failed');

    // Addendum does NOT appear.
    expect(prompt).not.toContain(ADDENDUM_MARKER);

    // Role line still present.
    expect(prompt).toContain('Role: reviewer');
  });

  // -------------------------------------------------------------------------
  // Case 5: skill bridge — compileSkillsForLoadout is exercised via a
  // vi.spyOn stub on getServingLayerByResourceId. Asserts that the bridge
  // wires the correct shape and the rendered string appears at the top of the
  // first-run prompt per the documented section ordering in prompt.ts.
  //
  // Previously this path was covered by a direct in-place mutation of the
  // materialized loadout's skills.rendered field, which bypassed the bridge
  // entirely. This test actually invokes compileSkillsForLoadout by giving
  // the loadout a skills.profile + openhive.skillBankRef, then verifying the
  // produced materializedLoadout.skills and prompt output.
  //
  // vi.spyOn (not vi.mock) so the stub is scoped to this test and restored
  // via vi.restoreAllMocks() — avoids leaking the mock into other test files
  // that run in the same vitest process.
  // -------------------------------------------------------------------------
  it('case 5 — skill bridge: compileSkillsForLoadout wires rendered skills into materializedLoadout and prompt', async () => {
    const fakeServer = {
      setLoadout: vi.fn().mockResolvedValue(undefined),
      setLoadoutFromProfile: vi.fn().mockResolvedValue(undefined),
      renderSystemPrompt: vi.fn().mockResolvedValue(RENDERED_SKILLS_MARKER),
      estimateTokens: vi.fn().mockReturnValue(100),
      getState: vi.fn().mockReturnValue({
        available: new Map([
          ['bridge-test-skill', { name: 'bridge-test-skill', version: '1.0.0' }],
        ]),
      }),
    };

    const spy = vi.spyOn(servingModule, 'getServingLayerByResourceId').mockResolvedValue({
      bank: {} as never,
      server: fakeServer as never,
      localPath: '/tmp/fake-skill-bank',
    });

    try {
      // Create a team template whose reviewer role loadout declares:
      //   - skills.profile (triggers the profile path in compileSkillsForLoadout)
      //   - openhive.skillBankRef (supplies the skill bank resource id)
      // The spy intercepts getServingLayerByResourceId and returns a fake
      // server whose renderSystemPrompt produces RENDERED_SKILLS_MARKER.
      const skillBankTemplate: TeamTemplateContent = {
        manifest: {
          name: 'skill-bridge-demo',
          version: 1,
          roles: ['reviewer'],
          topology: { root: { role: 'reviewer' } },
        },
        roles: {
          reviewer: {
            loadout: {
              name: 'reviewer',
              capabilities: ['file.read'],
              permissions: { allow: ['Read(**)'] },
              prompt_addendum: ADDENDUM_MARKER,
              skills: { profile: 'default' },
              openhive: { skillBankRef: FAKE_SKILL_BANK_REF },
            },
          },
        },
        loadouts: {},
        prompts: {},
      };

      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'skill-bridge-demo',
        content: skillBankTemplate,
        ownerAgentId: agentId,
      });

      const dispatch = dispatchesDAL.createDispatch({
        spec_resource_id: 'res_skill_bridge_spec',
        spec_id: 'mt-skill-bridge',
        target_swarm_id: 'swarm_skill_bridge',
        initiator_type: 'user',
        initiator_id: agentId,
      });

      const source = createOpenHiveDispatchSource(
        makeSpecFetcherWithSkillBank(tmpl.id),
        claimantId,
      );

      const task = await source.getTask(dispatch.id);
      const ml = task.metadata?.materializedLoadout as MaterializedLoadout | undefined;

      // materializedLoadout.skills must be populated by the bridge.
      expect(ml?.skills).toBeTruthy();
      expect(ml?.skills?.rendered).toContain('bridge-test-skill');
      expect(ml?.skills?.skillBankResourceId).toBe(FAKE_SKILL_BANK_REF);

      // Build the first-run prompt and verify rendered skills appear at the top
      // (before the spec body), per the documented section ordering in prompt.ts.
      const prompt = openHivePromptBuilder(task, {
        attempt: 1,
        turnCount: 0,
        role: 'reviewer',
      }) as string;

      const skillIdx = prompt.indexOf('bridge-test-skill');
      const bodyIdx = prompt.indexOf('Spec body with skill bank');
      expect(skillIdx).toBeGreaterThanOrEqual(0);
      expect(bodyIdx).toBeGreaterThan(skillIdx);

      // Addendum still appears below body.
      const addendumIdx = prompt.indexOf(ADDENDUM_MARKER);
      expect(addendumIdx).toBeGreaterThan(bodyIdx);
    } finally {
      spy.mockRestore();
    }
  });
});
