/**
 * End-to-end author-to-dispatch flow (fast, in-memory).
 *
 * Covers the hub-side bridge that ships materialized loadout content into the
 * dispatch prompt. No real subprocess; no MAP server; no HTTP. The full
 * pipeline (DAL → enrichWithLoadout → openHivePromptBuilder) runs against
 * a real SQLite DB with synthetic DispatchTasks.
 *
 * Variants:
 *   - team_role_ref path  (resolver: materializeRoleLoadout)
 *   - loadout_ref path    (resolver: materializeLoadoutById)
 *   - no binding (control: prompt unchanged)
 *   - materialization failure → loadout_error marker, prompt un-enriched
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DispatchTask } from 'swarm-dispatch';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { enrichWithLoadout } from '../../dispatch/openhive-source.js';
import { openHivePromptBuilder } from '../../dispatch/prompt.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

const TEST_ROOT = testRoot('loadout-author-to-dispatch');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'author-to-dispatch.db');

const ADDENDUM_MARKER = '## SECURITY-REVIEW-MARKER';

function loadoutContent(addendum: string = ADDENDUM_MARKER): LoadoutContent {
  return {
    name: 'reviewer-bundle',
    description: 'Reviewer loadout',
    capabilities: ['file.read', 'codebase.search'],
    permissions: { allow: ['Read(**)'], deny: ['Bash(rm -rf:*)'] },
    prompt_addendum: addendum,
  };
}

function teamWithReviewer(): TeamTemplateContent {
  return {
    manifest: {
      name: 'demo',
      version: 1,
      roles: ['reviewer'],
      topology: { root: { role: 'reviewer' } },
    },
    roles: { reviewer: { name: 'reviewer', loadout: loadoutContent() } },
    loadouts: {},
    prompts: {},
  };
}

function makeTask(specMetadata: Record<string, unknown>, initiatorId?: string): DispatchTask {
  return {
    id: 'disp_test',
    title: 'Audit auth flow',
    content: '# Audit auth flow\n\nBody of work.',
    status: 'open',
    created_at: new Date().toISOString(),
    metadata: {
      spec_resource_id: 'res_x',
      spec_id: 'c-aaa',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      // Use the supplied real agent id so enrichWithLoadout ACL check passes.
      // Tests that don't supply one (control / failure cases) leave it undefined
      // so the viewer gate is skipped — same as pre-ACL behaviour for callers
      // that have no initiator identity.
      initiator_id: initiatorId,
      spec_metadata: specMetadata,
    },
  };
}

// PromptBuilder returns string|Promise<string>; openHivePromptBuilder is sync.
function build(
  task: DispatchTask,
  ctx: { attempt: number; turnCount: number; previousError?: string; role: string },
): string {
  return openHivePromptBuilder(task, ctx) as string;
}

describe('author-to-dispatch end-to-end', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'a2d-agent' });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    _resetCacheForTest();
    getDatabase().prepare('DELETE FROM syncable_resources').run();
  });

  // ──────────────────────────────────────────────────────────────────────
  // team_role_ref path
  // ──────────────────────────────────────────────────────────────────────

  it('team_role_ref resolves through materializeRoleLoadout and embeds promptAddendum', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'demo',
      content: teamWithReviewer(),
      ownerAgentId: agentId,
    });

    const task = makeTask({
      team_role_ref: { teamTemplateId: tmpl.id, role: 'reviewer' },
    }, agentId);
    const enriched = await enrichWithLoadout(task);
    const prompt = build(enriched, { attempt: 1, turnCount: 0, role: 'reviewer' });

    expect(prompt).toContain(ADDENDUM_MARKER);
    expect(prompt).toContain('Audit auth flow');
    expect(prompt).toContain('Role: reviewer');

    // Ordering: addendum sits below body, above role line.
    const bodyIdx = prompt.indexOf('Audit auth flow');
    const addendumIdx = prompt.indexOf(ADDENDUM_MARKER);
    const roleIdx = prompt.indexOf('Role: reviewer');
    expect(addendumIdx).toBeGreaterThan(bodyIdx);
    expect(roleIdx).toBeGreaterThan(addendumIdx);
  });

  // ──────────────────────────────────────────────────────────────────────
  // loadout_ref path (standalone)
  // ──────────────────────────────────────────────────────────────────────

  it('loadout_ref resolves through materializeLoadoutById and embeds promptAddendum', async () => {
    const ldt = loadoutsDAL.createLoadout({
      name: 'reviewer',
      content: loadoutContent(),
      ownerAgentId: agentId,
    });

    const task = makeTask({ loadout_ref: ldt.id }, agentId);
    const enriched = await enrichWithLoadout(task);
    const prompt = build(enriched, { attempt: 1, turnCount: 0, role: 'reviewer' });

    expect(prompt).toContain(ADDENDUM_MARKER);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Equivalence: team_role_ref vs loadout_ref produce equivalent prompts
  // when the underlying loadout content is identical.
  // ──────────────────────────────────────────────────────────────────────

  it('team_role_ref and loadout_ref produce equivalent agent-visible prompts', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'demo',
      content: teamWithReviewer(),
      ownerAgentId: agentId,
    });
    const ldt = loadoutsDAL.createLoadout({
      name: 'reviewer',
      content: loadoutContent(),
      ownerAgentId: agentId,
    });

    const teamTask = makeTask({
      team_role_ref: { teamTemplateId: tmpl.id, role: 'reviewer' },
    }, agentId);
    const loadoutTask = makeTask({ loadout_ref: ldt.id }, agentId);

    const teamEnriched = await enrichWithLoadout(teamTask);
    const loadoutEnriched = await enrichWithLoadout(loadoutTask);

    const teamPrompt = build(teamEnriched, {
      attempt: 1,
      turnCount: 0,
      role: 'reviewer',
    });
    const loadoutPrompt = build(loadoutEnriched, {
      attempt: 1,
      turnCount: 0,
      role: 'reviewer',
    });

    // Both prompts contain the same materialized markers.
    expect(teamPrompt).toContain(ADDENDUM_MARKER);
    expect(loadoutPrompt).toContain(ADDENDUM_MARKER);

    // The prompt builder only uses loadout.promptAddendum and
    // loadout.skills?.rendered — neither path injects materializedAt
    // into the rendered text — so the two prompts must be byte-identical
    // when the underlying loadout content is the same.
    expect(teamPrompt).toEqual(loadoutPrompt);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Control: no binding → prompt unchanged
  // ──────────────────────────────────────────────────────────────────────

  it('no binding produces an unchanged prompt (no materialization, no marker)', async () => {
    const task = makeTask({});
    const enriched = await enrichWithLoadout(task);
    const prompt = build(enriched, { attempt: 1, turnCount: 0, role: 'reviewer' });

    expect(prompt).not.toContain(ADDENDUM_MARKER);
    expect(prompt).toContain('Audit auth flow');
    expect(prompt).toContain('Role: reviewer');
    expect(enriched.metadata?.materializedLoadout).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Failure: dispatch proceeds with un-enriched prompt + loadout_error marker
  // + dispatch.materialization_failed WS event
  // ──────────────────────────────────────────────────────────────────────

  it('materialization failure falls through with loadout_error metadata, prompt un-enriched, and emits WS event', async () => {
    // Pointing at a non-existent template id triggers TemplateNotFoundError
    // inside enrichWithLoadout, which records loadout_error, emits the WS
    // event via the injected broadcast fn, and returns the task unchanged.
    const broadcasts: Array<{ dispatchId: string; errorMessage: string }> = [];
    const captureBroadcast = (dispatchId: string, errorMessage: string) => {
      broadcasts.push({ dispatchId, errorMessage });
    };

    const task = makeTask({
      team_role_ref: { teamTemplateId: 'res_does_not_exist', role: 'reviewer' },
    });
    const enriched = await enrichWithLoadout(task, captureBroadcast);
    const prompt = build(enriched, { attempt: 1, turnCount: 0, role: 'reviewer' });

    expect(prompt).not.toContain(ADDENDUM_MARKER);
    expect(prompt).toContain('Audit auth flow');
    expect(enriched.metadata?.loadout_error).toBeTruthy();
    expect(enriched.metadata?.materializedLoadout).toBeUndefined();

    // WS event was emitted with the correct dispatch id and a non-empty error message.
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].dispatchId).toBe(task.id);
    expect(typeof broadcasts[0].errorMessage).toBe('string');
    expect(broadcasts[0].errorMessage.length).toBeGreaterThan(0);
  });
});
