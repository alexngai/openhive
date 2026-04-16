/**
 * DAL tests for dispatches table — exercises the schema migration and CRUD/
 * status transitions on a real SQLite instance.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as dispatches from '../../db/dal/dispatches.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('dispatches-dal');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'dispatches-dal.db');

describe('dispatches DAL', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    // Wipe between tests so list-count assertions are deterministic.
    getDatabase().prepare('DELETE FROM dispatches').run();
  });

  describe('createDispatch', () => {
    it('creates with default queued status and parses session_ids/outcome', () => {
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_a',
        spec_id: 'c-aaa',
        target_swarm_id: 'swarm_x',
        initiator_type: 'user',
        initiator_id: 'agent_user',
      });
      expect(d.id).toMatch(/^disp_/);
      expect(d.status).toBe('queued');
      expect(d.session_ids).toEqual([]);
      expect(d.outcome).toBeNull();
      expect(d.created_at).toBeTruthy();
      expect(d.updated_at).toBeTruthy();
    });

    it('captures spec_captured_at and prompt_override when provided', () => {
      const captured = '2026-04-15T20:00:00Z';
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_a',
        spec_id: 'c-aaa',
        spec_captured_at: captured,
        target_swarm_id: 'swarm_x',
        initiator_type: 'agent',
        initiator_id: 'planner-1',
        prompt_override: 'do it carefully',
      });
      expect(d.spec_captured_at).toBe(captured);
      expect(d.prompt_override).toBe('do it carefully');
      expect(d.initiator_type).toBe('agent');
    });

    it('rejects invalid status via CHECK constraint', () => {
      expect(() =>
        dispatches.createDispatch({
          spec_resource_id: 'res_a',
          spec_id: 'c-aaa',
          target_swarm_id: 'swarm_x',
          initiator_type: 'user',
          initiator_id: 'u',
          status: 'bogus' as never,
        }),
      ).toThrow();
    });

    it('rejects invalid initiator_type via CHECK constraint', () => {
      expect(() =>
        dispatches.createDispatch({
          spec_resource_id: 'res_a',
          spec_id: 'c-aaa',
          target_swarm_id: 'swarm_x',
          initiator_type: 'martian' as never,
          initiator_id: 'u',
        }),
      ).toThrow();
    });
  });

  describe('findDispatchById', () => {
    it('returns null for unknown id', () => {
      expect(dispatches.findDispatchById('disp_nope')).toBeNull();
    });

    it('round-trips outcome JSON', () => {
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_a',
        spec_id: 'c-aaa',
        target_swarm_id: 'swarm_x',
        initiator_type: 'user',
        initiator_id: 'u',
      });
      dispatches.updateDispatchStatus(d.id, 'complete', {
        summary: 'done',
        artifacts: [{ kind: 'pr', ref: 'gh:foo/bar#42' }],
      });
      const loaded = dispatches.findDispatchById(d.id);
      expect(loaded?.outcome?.summary).toBe('done');
      expect(loaded?.outcome?.artifacts).toEqual([{ kind: 'pr', ref: 'gh:foo/bar#42' }]);
    });
  });

  describe('listDispatches', () => {
    function seed(): void {
      dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: 'alice',
      });
      dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-2', target_swarm_id: 'swarm_y',
        initiator_type: 'user', initiator_id: 'alice',
      });
      const d3 = dispatches.createDispatch({
        spec_resource_id: 'res_b', spec_id: 'c-3', target_swarm_id: 'swarm_x',
        initiator_type: 'agent', initiator_id: 'planner',
      });
      dispatches.updateDispatchStatus(d3.id, 'running');
      const d4 = dispatches.createDispatch({
        spec_resource_id: 'res_b', spec_id: 'c-4', target_swarm_id: 'swarm_y',
        initiator_type: 'agent', initiator_id: 'planner',
      });
      dispatches.updateDispatchStatus(d4.id, 'complete', { summary: 'ok' });
    }

    it('returns all rows in created_at desc by default', () => {
      seed();
      const result = dispatches.listDispatches();
      expect(result.total).toBe(4);
      expect(result.data).toHaveLength(4);
      // most recent first
      const created = result.data.map((d) => d.created_at);
      const sorted = [...created].sort().reverse();
      expect(created).toEqual(sorted);
    });

    it('filters by single status', () => {
      seed();
      const result = dispatches.listDispatches({ status: 'queued' });
      expect(result.total).toBe(2);
      result.data.forEach((d) => expect(d.status).toBe('queued'));
    });

    it('filters by status array', () => {
      seed();
      const result = dispatches.listDispatches({ status: ['running', 'complete'] });
      expect(result.total).toBe(2);
    });

    it('filters by target_swarm_id', () => {
      seed();
      const result = dispatches.listDispatches({ target_swarm_id: 'swarm_x' });
      expect(result.total).toBe(2);
    });

    it('filters by spec_resource_id + spec_id', () => {
      seed();
      const result = dispatches.listDispatches({
        spec_resource_id: 'res_a',
        spec_id: 'c-1',
      });
      expect(result.total).toBe(1);
      expect(result.data[0]?.spec_id).toBe('c-1');
    });

    it('filters by initiator_id and initiator_type', () => {
      seed();
      const byPlanner = dispatches.listDispatches({ initiator_id: 'planner' });
      expect(byPlanner.total).toBe(2);
      const allAgents = dispatches.listDispatches({ initiator_type: 'agent' });
      expect(allAgents.total).toBe(2);
    });

    it('paginates via limit/offset', () => {
      seed();
      const page1 = dispatches.listDispatches({ limit: 2, offset: 0 });
      expect(page1.data).toHaveLength(2);
      expect(page1.total).toBe(4);
      const page2 = dispatches.listDispatches({ limit: 2, offset: 2 });
      expect(page2.data).toHaveLength(2);
      expect(page2.data[0]?.id).not.toBe(page1.data[0]?.id);
    });
  });

  describe('updateDispatchStatus', () => {
    it('transitions queued → running and bumps updated_at', async () => {
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: 'u',
      });
      const originalUpdatedAt = d.updated_at;
      // wait long enough for ISO seconds to tick
      await new Promise((r) => setTimeout(r, 1100));
      const next = dispatches.updateDispatchStatus(d.id, 'running');
      expect(next?.status).toBe('running');
      expect(next?.updated_at).not.toBe(originalUpdatedAt);
    });

    it('clears outcome when explicitly passed null', () => {
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: 'u',
      });
      dispatches.updateDispatchStatus(d.id, 'complete', { summary: 'first' });
      const cleared = dispatches.updateDispatchStatus(d.id, 'running', null);
      expect(cleared?.outcome).toBeNull();
    });
  });

  describe('setDispatchSessionIds', () => {
    it('persists the array', () => {
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: 'u',
      });
      dispatches.setDispatchSessionIds(d.id, ['session_a', 'session_b']);
      const loaded = dispatches.findDispatchById(d.id);
      expect(loaded?.session_ids).toEqual(['session_a', 'session_b']);
    });
  });

  describe('cancelDispatch', () => {
    it('marks status cancelled', () => {
      const d = dispatches.createDispatch({
        spec_resource_id: 'res_a', spec_id: 'c-1', target_swarm_id: 'swarm_x',
        initiator_type: 'user', initiator_id: 'u',
      });
      const cancelled = dispatches.cancelDispatch(d.id);
      expect(cancelled?.status).toBe('cancelled');
    });
  });
});
