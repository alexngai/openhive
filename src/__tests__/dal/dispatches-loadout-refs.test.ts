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
});
