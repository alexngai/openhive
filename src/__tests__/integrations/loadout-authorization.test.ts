/**
 * Loadout Authorization Tests
 *
 * Verifies that materializeRoleLoadout and materializeLoadoutById enforce ACL
 * when a viewerAgentId is supplied, and that the dispatch path passes the
 * initiator_id as viewer so cross-tenant content leaks are blocked.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DispatchTask } from 'swarm-dispatch';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import {
  materializeRoleLoadout,
  materializeLoadoutById,
  MaterializationForbiddenError,
} from '../../openteams/resolver.js';
import { enrichWithLoadout } from '../../dispatch/openhive-source.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

const TEST_ROOT = testRoot('loadout-authorization');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'loadout-auth.db');

const ADDENDUM = '## ACL-TEST-ADDENDUM';

function loadoutContent(): LoadoutContent {
  return {
    name: 'acl-test-loadout',
    description: 'ACL test loadout',
    capabilities: ['file.read'],
    permissions: { allow: ['Read(**)'], deny: [] },
    prompt_addendum: ADDENDUM,
  };
}

function teamWithRole(): TeamTemplateContent {
  return {
    manifest: {
      name: 'acl-demo',
      version: 1,
      roles: ['worker'],
      topology: { root: { role: 'worker' } },
    },
    roles: { worker: { loadout: loadoutContent() } },
    loadouts: {},
    prompts: {},
  };
}

function makeTask(specMetadata: Record<string, unknown>, initiatorId: string): DispatchTask {
  return {
    id: 'disp_acl_test',
    title: 'ACL test dispatch',
    content: '# ACL test dispatch',
    status: 'open',
    created_at: new Date().toISOString(),
    metadata: {
      spec_resource_id: 'res_spec',
      spec_id: 'spec-001',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      initiator_id: initiatorId,
      spec_metadata: specMetadata,
    },
  };
}

describe('loadout authorization', () => {
  let agentA: string;
  let agentB: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent: a } = await agentsDAL.createAgent({ name: 'acl-owner' });
    const { agent: b } = await agentsDAL.createAgent({ name: 'acl-other' });
    agentA = a.id;
    agentB = b.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    _resetCacheForTest();
    getDatabase().prepare('DELETE FROM syncable_resources').run();
    getDatabase().prepare('DELETE FROM resource_subscriptions').run();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 1. Owner can materialize their own private team_template
  // ──────────────────────────────────────────────────────────────────────

  it('owner can materialize their own private team_template', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'acl-demo',
      content: teamWithRole(),
      ownerAgentId: agentA,
      visibility: 'private',
    });

    const result = await materializeRoleLoadout(tmpl.id, 'worker', agentA);
    expect(result.promptAddendum).toBe(ADDENDUM);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. Other agent cannot materialize a private team_template
  // ──────────────────────────────────────────────────────────────────────

  it('other agent cannot materialize a private team_template', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'acl-demo',
      content: teamWithRole(),
      ownerAgentId: agentA,
      visibility: 'private',
    });

    await expect(
      materializeRoleLoadout(tmpl.id, 'worker', agentB),
    ).rejects.toBeInstanceOf(MaterializationForbiddenError);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. Public template materializes for any viewer
  // ──────────────────────────────────────────────────────────────────────

  it('public template materializes for any viewer', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'acl-demo',
      content: teamWithRole(),
      ownerAgentId: agentA,
      visibility: 'public',
    });

    const result = await materializeRoleLoadout(tmpl.id, 'worker', agentB);
    expect(result.promptAddendum).toBe(ADDENDUM);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Shared template — subscriber succeeds; non-subscriber fails
  // ──────────────────────────────────────────────────────────────────────

  it('shared template: subscriber succeeds, non-subscriber fails', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'acl-demo',
      content: teamWithRole(),
      ownerAgentId: agentA,
      visibility: 'shared',
    });

    // agentB not subscribed — should fail
    await expect(
      materializeRoleLoadout(tmpl.id, 'worker', agentB),
    ).rejects.toBeInstanceOf(MaterializationForbiddenError);

    // Subscribe agentB and retry — should succeed
    resourcesDAL.subscribeToResource(agentB, tmpl.id, 'read');
    const result = await materializeRoleLoadout(tmpl.id, 'worker', agentB);
    expect(result.promptAddendum).toBe(ADDENDUM);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Dispatch path enforces gate: agentB dispatch against agentA's private
  //    team_template → materializedLoadout absent, loadout_error set
  // ──────────────────────────────────────────────────────────────────────

  it('dispatch path blocks cross-tenant team_template access via team_role_ref', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'acl-demo',
      content: teamWithRole(),
      ownerAgentId: agentA,
      visibility: 'private',
    });

    const broadcasts: Array<{ dispatchId: string; errorMessage: string }> = [];
    const task = makeTask(
      { team_role_ref: { teamTemplateId: tmpl.id, role: 'worker' } },
      agentB, // agentB is the initiator — should be denied
    );
    const enriched = await enrichWithLoadout(task, (id, msg) => {
      broadcasts.push({ dispatchId: id, errorMessage: msg });
    });

    expect(enriched.metadata?.materializedLoadout).toBeUndefined();
    expect(enriched.metadata?.loadout_error).toBeDefined();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. WS broadcast uses generic "unauthorized" message (no resource details)
  // ──────────────────────────────────────────────────────────────────────

  it('dispatch.materialization_failed broadcast carries generic "unauthorized" message', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'acl-demo',
      content: teamWithRole(),
      ownerAgentId: agentA,
      visibility: 'private',
    });

    const broadcasts: Array<{ dispatchId: string; errorMessage: string }> = [];
    const task = makeTask(
      { team_role_ref: { teamTemplateId: tmpl.id, role: 'worker' } },
      agentB,
    );
    await enrichWithLoadout(task, (id, msg) => {
      broadcasts.push({ dispatchId: id, errorMessage: msg });
    });

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].errorMessage).toBe('unauthorized');
    // Must not leak the resource id or owner details
    expect(broadcasts[0].errorMessage).not.toContain(tmpl.id);
    expect(broadcasts[0].errorMessage).not.toContain(agentA);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 7. Same coverage for loadout_ref path with materializeLoadoutById
  // ──────────────────────────────────────────────────────────────────────

  it('owner can materialize their own private loadout', async () => {
    const ldt = loadoutsDAL.createLoadout({
      name: 'acl-test-loadout',
      content: loadoutContent(),
      ownerAgentId: agentA,
      visibility: 'private',
    });

    const result = await materializeLoadoutById(ldt.id, agentA);
    expect(result.promptAddendum).toBe(ADDENDUM);
  });

  it('other agent cannot materialize a private loadout', async () => {
    const ldt = loadoutsDAL.createLoadout({
      name: 'acl-test-loadout',
      content: loadoutContent(),
      ownerAgentId: agentA,
      visibility: 'private',
    });

    await expect(
      materializeLoadoutById(ldt.id, agentB),
    ).rejects.toBeInstanceOf(MaterializationForbiddenError);
  });

  it('dispatch path blocks cross-tenant loadout access via loadout_ref', async () => {
    const ldt = loadoutsDAL.createLoadout({
      name: 'acl-test-loadout',
      content: loadoutContent(),
      ownerAgentId: agentA,
      visibility: 'private',
    });

    const broadcasts: Array<{ dispatchId: string; errorMessage: string }> = [];
    const task = makeTask({ loadout_ref: ldt.id }, agentB);
    const enriched = await enrichWithLoadout(task, (id, msg) => {
      broadcasts.push({ dispatchId: id, errorMessage: msg });
    });

    expect(enriched.metadata?.materializedLoadout).toBeUndefined();
    expect(enriched.metadata?.loadout_error).toBeDefined();

    // WS broadcast uses generic message
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].errorMessage).toBe('unauthorized');
    expect(broadcasts[0].errorMessage).not.toContain(ldt.id);
    expect(broadcasts[0].errorMessage).not.toContain(agentA);
  });

  it('dispatch with owner as initiator succeeds for private loadout_ref', async () => {
    const ldt = loadoutsDAL.createLoadout({
      name: 'acl-test-loadout',
      content: loadoutContent(),
      ownerAgentId: agentA,
      visibility: 'private',
    });

    const task = makeTask({ loadout_ref: ldt.id }, agentA); // agentA is owner
    const enriched = await enrichWithLoadout(task);

    expect(enriched.metadata?.materializedLoadout).toBeDefined();
    expect(enriched.metadata?.loadout_error).toBeUndefined();
  });
});
