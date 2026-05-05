/**
 * V49 dispatch row persistence — verifies that the loadout-resolution and
 * attempt-delivery write paths actually write to real dispatch rows.
 *
 * Distinct from `loadout-author-to-dispatch.test.ts`: that test exercises
 * the prompt-builder pipeline against synthetic DispatchTask ids that
 * don't correspond to dispatches table rows, so the V49 writes silently
 * no-op there (best-effort try/catch). This test creates real dispatch
 * rows and asserts the columns are populated correctly.
 *
 * Covered:
 *   - enrichWithLoadout success → loadout_ref + loadout_status='materialized'
 *   - enrichWithLoadout failure → loadout_ref + loadout_status='failed' + loadout_error
 *   - team_role_ref binding → synthesized "team:<id>/role:<r>" stored in loadout_ref
 *   - recordAttemptDelivery merge into attempts_history (idempotent + partial updates)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DispatchTask } from 'swarm-dispatch';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { enrichWithLoadout } from '../../dispatch/openhive-source.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

const TEST_ROOT = testRoot('dispatch-loadout-persistence');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'persistence.db');

function loadoutContent(): LoadoutContent {
  return {
    name: 'reviewer-bundle',
    description: 'Reviewer loadout',
    capabilities: ['file.read'],
    permissions: { allow: ['Read(**)'], deny: ['Bash(rm -rf:*)'] },
    prompt_addendum: '## REVIEWER',
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
    roles: { reviewer: { loadout: loadoutContent() } },
    loadouts: {},
    prompts: {},
  };
}

function makeTaskFromDispatch(
  dispatchId: string,
  initiatorId: string,
  specMetadata: Record<string, unknown>,
): DispatchTask {
  return {
    id: dispatchId,
    title: 'spec',
    content: '# spec\n\nbody',
    status: 'open',
    created_at: new Date().toISOString(),
    metadata: {
      spec_resource_id: 'res_x',
      spec_id: 'c-aaa',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      initiator_id: initiatorId,
      spec_metadata: specMetadata,
    },
  };
}

describe('V49 dispatch row persistence', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'persist-agent' });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    _resetCacheForTest();
    const db = getDatabase();
    db.prepare('DELETE FROM syncable_resources').run();
    db.prepare('DELETE FROM dispatches').run();
  });

  function createDispatchRow(): string {
    const row = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c-aaa',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      initiator_id: agentId,
    });
    return row.id;
  }

  // ──────────────────────────────────────────────────────────────────────
  // recordLoadoutResolution — happy path (loadout_ref binding)
  // ──────────────────────────────────────────────────────────────────────

  it('persists loadout_ref + status="materialized" on successful resolution', async () => {
    const ldt = loadoutsDAL.createLoadout({
      name: 'reviewer',
      content: loadoutContent(),
      ownerAgentId: agentId,
    });
    const dispatchId = createDispatchRow();
    const task = makeTaskFromDispatch(dispatchId, agentId, { loadout_ref: ldt.id });

    await enrichWithLoadout(task);

    const row = dispatchesDAL.findDispatchById(dispatchId);
    expect(row?.loadout_ref).toBe(ldt.id);
    expect(row?.loadout_status).toBe('materialized');
    expect(row?.loadout_error).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────
  // recordLoadoutResolution — happy path (team_role_ref binding)
  // synthesizes a "team:<id>/role:<r>" string for storage
  // ──────────────────────────────────────────────────────────────────────

  it('persists team:<id>/role:<r> synthetic ref for team_role_ref bindings', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'demo',
      content: teamWithReviewer(),
      ownerAgentId: agentId,
    });
    const dispatchId = createDispatchRow();
    const task = makeTaskFromDispatch(dispatchId, agentId, {
      team_role_ref: { teamTemplateId: tmpl.id, role: 'reviewer' },
    });

    await enrichWithLoadout(task);

    const row = dispatchesDAL.findDispatchById(dispatchId);
    expect(row?.loadout_ref).toBe(`team:${tmpl.id}/role:reviewer`);
    expect(row?.loadout_status).toBe('materialized');
    expect(row?.loadout_error).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────
  // recordLoadoutResolution — failure path
  // ──────────────────────────────────────────────────────────────────────

  it('persists status="failed" + error message when loadout_ref does not resolve', async () => {
    const dispatchId = createDispatchRow();
    const task = makeTaskFromDispatch(dispatchId, agentId, {
      loadout_ref: 'res_does_not_exist',
    });

    // Pass a no-op broadcast so the missing realtime layer doesn't muddy
    // the assertion on the failure persistence.
    await enrichWithLoadout(task, () => {});

    const row = dispatchesDAL.findDispatchById(dispatchId);
    expect(row?.loadout_ref).toBe('res_does_not_exist');
    expect(row?.loadout_status).toBe('failed');
    expect(row?.loadout_error).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────
  // No binding → columns stay null (no write)
  // ──────────────────────────────────────────────────────────────────────

  it('leaves loadout columns null when the spec has no binding', async () => {
    const dispatchId = createDispatchRow();
    const task = makeTaskFromDispatch(dispatchId, agentId, {});

    await enrichWithLoadout(task);

    const row = dispatchesDAL.findDispatchById(dispatchId);
    expect(row?.loadout_ref).toBeNull();
    expect(row?.loadout_status).toBeNull();
    expect(row?.loadout_error).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────
  // recordAttemptDelivery — partial updates merge into attempts_history
  // ──────────────────────────────────────────────────────────────────────

  it('recordAttemptDelivery upserts attempts_history with transport+agent_id+via', () => {
    const dispatchId = createDispatchRow();

    // First write: simulate the runtime adapter's marker.
    dispatchesDAL.recordAttemptDelivery(dispatchId, 1, {
      transport: 'acp',
      agent_id: 'agent_coord_xyz',
    });

    let row = dispatchesDAL.findDispatchById(dispatchId);
    expect(row?.attempts_history).toHaveLength(1);
    expect(row?.attempts_history[0].attempt).toBe(1);
    expect(row?.attempts_history[0].transport).toBe('acp');
    expect(row?.attempts_history[0].agent_id).toBe('agent_coord_xyz');
    expect(row?.attempts_history[0].via).toBeUndefined();

    // Second write: the orchestrator's `dispatched` event fills in `via`
    // (and re-affirms agent_id from the event). Should merge into the
    // same row, not create a new one.
    dispatchesDAL.recordAttemptDelivery(dispatchId, 1, {
      via: 'spawn',
      agent_id: 'agent_coord_xyz',
    });

    row = dispatchesDAL.findDispatchById(dispatchId);
    expect(row?.attempts_history).toHaveLength(1);
    expect(row?.attempts_history[0].transport).toBe('acp');
    expect(row?.attempts_history[0].agent_id).toBe('agent_coord_xyz');
    expect(row?.attempts_history[0].via).toBe('spawn');
  });

  // ──────────────────────────────────────────────────────────────────────
  // recordAttemptDelivery — creates a stub when no prior row exists
  // (defensive path for delivery racing ahead of `dispatched` event)
  // ──────────────────────────────────────────────────────────────────────

  it('recordAttemptDelivery creates a stub attempt row when none exists', () => {
    const dispatchId = createDispatchRow();

    dispatchesDAL.recordAttemptDelivery(dispatchId, 1, {
      transport: 'mail',
      agent_id: 'agent_sidecar',
    });

    const row = dispatchesDAL.findDispatchById(dispatchId);
    expect(row?.attempts_history).toHaveLength(1);
    expect(row?.attempts_history[0].attempt).toBe(1);
    expect(row?.attempts_history[0].status).toBe('running');
    expect(row?.attempts_history[0].transport).toBe('mail');
    expect(row?.attempts_history[0].agent_id).toBe('agent_sidecar');
    expect(row?.attempts_history[0].started_at).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Multiple attempts persist independently — retry timeline integrity
  // ──────────────────────────────────────────────────────────────────────

  it('preserves per-attempt transport across multiple attempts', () => {
    const dispatchId = createDispatchRow();

    // Attempt 1: routed via mail (reuse)
    dispatchesDAL.recordAttemptDelivery(dispatchId, 1, {
      transport: 'mail',
      agent_id: 'agent_a',
      via: 'route',
    });
    // Attempt 2: failed and retried via ACP fresh
    dispatchesDAL.recordAttemptDelivery(dispatchId, 2, {
      transport: 'acp',
      agent_id: 'agent_b',
      via: 'spawn',
    });

    const row = dispatchesDAL.findDispatchById(dispatchId);
    expect(row?.attempts_history).toHaveLength(2);
    expect(row?.attempts_history[0]).toMatchObject({
      attempt: 1,
      transport: 'mail',
      via: 'route',
      agent_id: 'agent_a',
    });
    expect(row?.attempts_history[1]).toMatchObject({
      attempt: 2,
      transport: 'acp',
      via: 'spawn',
      agent_id: 'agent_b',
    });
  });
});
