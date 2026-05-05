/**
 * Dispatch source adapter integration: queryReady → getTask (enriched) → prompt.
 *
 * Verifies the wiring in `createOpenHiveDispatchSource` produces a fully
 * enriched DispatchTask whose prompt-builder output contains the materialized
 * loadout content. This is the integration the orchestrator drives in
 * production: the adapter's `getTask` calls enrichContent under the hood,
 * combining spec fetch + loadout materialization.
 *
 * Sits between:
 *   - `loadout-author-to-dispatch.test.ts` (calls enrichWithLoadout directly)
 *   - the gated full-stack test (real subprocess, no observable prompt)
 *
 * Closes the integration gap: validates that real dispatch rows in the DB,
 * walking through the source adapter, produce prompts with materialized
 * content. No subprocess. No orchestrator polling.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import {
  createOpenHiveDispatchSource,
  type SpecContentFetcher,
} from '../../dispatch/openhive-source.js';
import { openHivePromptBuilder } from '../../dispatch/prompt.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

const TEST_ROOT = testRoot('dispatch-source-prompt');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'source-prompt.db');

const ADDENDUM_MARKER = '## ORCH_INTEG_MARKER';

function reviewerLoadout(addendum: string = ADDENDUM_MARKER): LoadoutContent {
  return {
    name: 'reviewer',
    capabilities: ['file.read'],
    permissions: { allow: ['Read(**)'] },
    prompt_addendum: addendum,
  };
}

function teamWithReviewer(): TeamTemplateContent {
  return {
    manifest: {
      name: 'src-prompt-demo',
      version: 1,
      roles: ['reviewer'],
      topology: { root: { role: 'reviewer' } },
    },
    roles: { reviewer: { loadout: reviewerLoadout() } },
    loadouts: {},
    prompts: {},
  };
}

// Minimal spec fetcher; the source adapter calls this for spec content.
// Importantly, it returns spec.metadata which carries the loadout binding.
function makeSpecFetcher(loadoutBinding: Record<string, unknown>): SpecContentFetcher {
  return {
    async fetch(_resourceId, specId) {
      return {
        title: `Spec ${specId}`,
        content: 'Spec body content',
        tasks: [],
        metadata: loadoutBinding,
      };
    },
  };
}

describe('dispatch source adapter integration', () => {
  let agentId: string;
  let claimantId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'orch-integ-agent' });
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
  });

  it('queryReady → getTask returns an enriched DispatchTask whose prompt embeds the addendum (team_role_ref)', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'src-prompt-demo',
      content: teamWithReviewer(),
      ownerAgentId: agentId,
    });

    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_synthetic_spec',
      spec_id: 'c-orch-1',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const source = createOpenHiveDispatchSource(
      makeSpecFetcher({
        team_role_ref: { teamTemplateId: tmpl.id, role: 'reviewer' },
      }),
      claimantId,
    );

    // queryReady now returns enriched tasks (the wrapper added in the bug fix
    // calls enrich() on every row so the first-run prompt builder sees the
    // full materialized payload).
    const ready = await source.queryReady({ limit: 10 });
    expect(ready.find((t) => t.id === dispatch.id)).toBeTruthy();

    // getTask runs enrichContent: spec fetch + loadout materialization.
    const enriched = await source.getTask(dispatch.id);
    expect(enriched.metadata?.materializedLoadout).toBeTruthy();

    // The prompt builder produces the final prompt the orchestrator's
    // runtime would send to the agent.
    const prompt = openHivePromptBuilder(enriched, {
      attempt: 1,
      turnCount: 0,
      role: 'reviewer',
    }) as string;

    expect(prompt).toContain(ADDENDUM_MARKER);
    expect(prompt).toContain('Role: reviewer');
  });

  it('queryReady → getTask works for loadout_ref (standalone) path', async () => {
    const ldt = loadoutsDAL.createLoadout({
      name: 'reviewer',
      content: reviewerLoadout(),
      ownerAgentId: agentId,
    });

    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_synthetic_spec',
      spec_id: 'c-orch-2',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const source = createOpenHiveDispatchSource(
      makeSpecFetcher({ loadout_ref: ldt.id }),
      claimantId,
    );

    const enriched = await source.getTask(dispatch.id);
    const prompt = openHivePromptBuilder(enriched, {
      attempt: 1,
      turnCount: 0,
      role: 'reviewer',
    }) as string;

    expect(prompt).toContain(ADDENDUM_MARKER);
  });

  it('updating loadout content reflects in next getTask call (cache invalidation through the full chain)', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'src-prompt-cache',
      content: teamWithReviewer(),
      ownerAgentId: agentId,
    });

    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_synthetic_spec',
      spec_id: 'c-orch-3',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const source = createOpenHiveDispatchSource(
      makeSpecFetcher({
        team_role_ref: { teamTemplateId: tmpl.id, role: 'reviewer' },
      }),
      claimantId,
    );

    const before = await source.getTask(dispatch.id);
    const beforePrompt = openHivePromptBuilder(before, {
      attempt: 1,
      turnCount: 0,
      role: 'reviewer',
    }) as string;
    expect(beforePrompt).toContain(ADDENDUM_MARKER);

    // Edit the loadout content via DAL (simulates the user editing in the UI).
    const updated = teamWithReviewer();
    updated.roles!.reviewer = {
      loadout: reviewerLoadout('## NEW MARKER VERSION 2'),
    };
    teamTemplatesDAL.updateTeamTemplate(tmpl.id, { content: updated });

    const after = await source.getTask(dispatch.id);
    const afterPrompt = openHivePromptBuilder(after, {
      attempt: 1,
      turnCount: 0,
      role: 'reviewer',
    }) as string;
    expect(afterPrompt).toContain('## NEW MARKER VERSION 2');
    expect(afterPrompt).not.toContain(ADDENDUM_MARKER);
  });

  // ---------------------------------------------------------------------------
  // Regression tests: queryReady wrapper must enrich every returned task.
  //
  // swarm-dispatch's createSqlSource calls enrichContent only on getTask(),
  // not on queryReady(). The bug fix wraps source.queryReady to call enrich()
  // on each row so the first-run prompt builder sees the full materialized
  // payload. The tests below catch a regression where the wrapper is removed
  // or bypassed — they call queryReady directly and assert enrichment is
  // present without going through getTask first.
  // ---------------------------------------------------------------------------

  it('queryReady enriches returned tasks via team_role_ref (regression: wrapper must call enrich)', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'src-prompt-qr-team',
      content: teamWithReviewer(),
      ownerAgentId: agentId,
    });

    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_synthetic_spec',
      spec_id: 'c-qr-regression-1',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const source = createOpenHiveDispatchSource(
      makeSpecFetcher({
        team_role_ref: { teamTemplateId: tmpl.id, role: 'reviewer' },
      }),
      claimantId,
    );

    const tasks = await source.queryReady({ limit: 10 });
    const t = tasks.find((task) => task.id === dispatch.id);
    const ml = t?.metadata?.materializedLoadout as import('../../openteams/types.js').MaterializedLoadout | undefined;
    expect(ml).toBeTruthy();
    expect(ml?.promptAddendum).toContain(ADDENDUM_MARKER);
  });

  it('queryReady enriches returned tasks via loadout_ref (regression: wrapper must call enrich)', async () => {
    const ldt = loadoutsDAL.createLoadout({
      name: 'reviewer-qr',
      content: reviewerLoadout(),
      ownerAgentId: agentId,
    });

    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_synthetic_spec',
      spec_id: 'c-qr-regression-2',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const source = createOpenHiveDispatchSource(
      makeSpecFetcher({ loadout_ref: ldt.id }),
      claimantId,
    );

    const tasks = await source.queryReady({ limit: 10 });
    const t = tasks.find((task) => task.id === dispatch.id);
    const ml = t?.metadata?.materializedLoadout as import('../../openteams/types.js').MaterializedLoadout | undefined;
    expect(ml).toBeTruthy();
    expect(ml?.promptAddendum).toContain(ADDENDUM_MARKER);
  });

  it('dispatch without loadout binding produces an unenriched prompt (no marker, no error)', async () => {
    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_synthetic_spec',
      spec_id: 'c-orch-4',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const source = createOpenHiveDispatchSource(
      makeSpecFetcher({}), // empty spec metadata = no binding
      claimantId,
    );

    const enriched = await source.getTask(dispatch.id);
    expect(enriched.metadata?.materializedLoadout).toBeUndefined();

    const prompt = openHivePromptBuilder(enriched, {
      attempt: 1,
      turnCount: 0,
      role: 'reviewer',
    }) as string;
    expect(prompt).not.toContain(ADDENDUM_MARKER);
    expect(prompt).toContain('Spec body content');
  });
});
