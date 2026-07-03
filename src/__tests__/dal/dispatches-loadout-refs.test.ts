/**
 * Layer 3 DAL tests — `loadout_bundle_id`, `team_bundle_id`, `role`
 * columns on `dispatches`.
 *
 * Covers schema migration V46 + round-trip through `createDispatch` /
 * `findDispatchById`. Existing dispatch DAL tests are unaffected; this
 * file only exercises the new fields.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as dispatches from '../../db/dal/dispatches.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('dispatches-loadout-refs');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'dispatches-loadout-refs.db');

describe('dispatches DAL — loadout refs (V46)', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM dispatches').run();
  });

  it('defaults the new columns to null when omitted', () => {
    const d = dispatches.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c-1',
      target_swarm_id: 'swarm_a',
      initiator_type: 'user',
      initiator_id: 'agent_u',
    });
    expect(d.loadout_bundle_id).toBeNull();
    expect(d.team_bundle_id).toBeNull();
    expect(d.role).toBeNull();
    // V64 resource refs
    expect(d.loadout_resource_id).toBeNull();
    expect(d.team_template_resource_id).toBeNull();
  });

  // P4.1 / V64: the originating resource ids ride alongside the pinned bundle
  // ids so hub-side enrichment can materialize live.
  it('persists openteams resource refs (V64) and round-trips them', () => {
    const d = dispatches.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c-3',
      target_swarm_id: 'swarm_a',
      initiator_type: 'user',
      initiator_id: 'agent_u',
      loadout_bundle_id: 'sha256:pinned',
      team_bundle_id: 'sha256:pinned-team',
      role: 'reviewer',
      loadout_resource_id: 'res_loadout_live',
      team_template_resource_id: 'res_team_live',
    });
    expect(d.loadout_resource_id).toBe('res_loadout_live');
    expect(d.team_template_resource_id).toBe('res_team_live');

    const found = dispatches.findDispatchById(d.id);
    expect(found!.loadout_resource_id).toBe('res_loadout_live');
    expect(found!.team_template_resource_id).toBe('res_team_live');
  });

  it('persists openteams binding fields and round-trips them via findDispatchById', () => {
    const d = dispatches.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c-1',
      target_swarm_id: 'swarm_a',
      initiator_type: 'agent',
      initiator_id: 'planner-1',
      loadout_bundle_id: 'sha256:abc123',
      team_bundle_id: 'sha256:9f3a',
      role: 'executor',
    });
    expect(d.loadout_bundle_id).toBe('sha256:abc123');
    expect(d.team_bundle_id).toBe('sha256:9f3a');
    expect(d.role).toBe('executor');

    const found = dispatches.findDispatchById(d.id);
    expect(found).not.toBeNull();
    expect(found!.loadout_bundle_id).toBe('sha256:abc123');
    expect(found!.team_bundle_id).toBe('sha256:9f3a');
    expect(found!.role).toBe('executor');
  });

  it('accepts loadout-only binding without team / role', () => {
    const d = dispatches.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c-2',
      target_swarm_id: 'swarm_a',
      initiator_type: 'user',
      initiator_id: 'agent_u',
      loadout_bundle_id: 'sha256:loadout-only',
    });
    expect(d.loadout_bundle_id).toBe('sha256:loadout-only');
    expect(d.team_bundle_id).toBeNull();
    expect(d.role).toBeNull();
  });

  // P4.2 / V65: coordinated-team shared thread linkage.
  it('defaults team_conversation_id to null and links a batch (first-writer wins)', () => {
    const a = dispatches.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'team-1',
      target_swarm_id: 'swarm_a',
      initiator_type: 'user',
      initiator_id: 'agent_u',
    });
    const b = dispatches.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'team-1',
      target_swarm_id: 'swarm_b',
      initiator_type: 'user',
      initiator_id: 'agent_u',
    });
    expect(a.team_conversation_id).toBeNull();
    expect(b.team_conversation_id).toBeNull();

    dispatches.setDispatchTeamConversationId(a.id, 'team-conv-1');
    dispatches.setDispatchTeamConversationId(b.id, 'team-conv-1');

    const members = dispatches.listDispatchesByTeamConversation('team-conv-1');
    expect(members.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(members.every((d) => d.team_conversation_id === 'team-conv-1')).toBe(true);

    // First-writer wins — a second stamp must not clobber.
    dispatches.setDispatchTeamConversationId(a.id, 'team-conv-2');
    expect(dispatches.findDispatchById(a.id)!.team_conversation_id).toBe('team-conv-1');
  });
});
