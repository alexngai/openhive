/**
 * Schedules DAL roundtrips against a real SQLite DB.
 *
 * Verifies:
 *   - CREATE TABLE happens via migration on a fresh DB
 *   - CRUD: createSchedule, findById, listSchedules, update, pause, resume, delete
 *   - ScheduleStore contract: listDue, markFired, advance
 *   - hasUnfinishedDispatchForSchedule probe
 *   - JSON column roundtrip (payload, policy)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as schedules from '../../db/dal/schedules.js';
import * as dispatches from '../../db/dal/dispatches.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('schedules-dal');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'schedules-dal.db');

beforeAll(() => {
  cleanTestRoot(TEST_ROOT);
  initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec('DELETE FROM schedules');
  db.exec('DELETE FROM dispatches');
});

function makeInput(overrides: Partial<schedules.CreateScheduleInput> = {}): schedules.CreateScheduleInput {
  return {
    cron: '0 * * * *',
    payload: {
      spec_ref: { resource_id: 'res_1', spec_id: 'spec_1' },
      target_swarm_ids: ['swarm_a'],
    },
    next_fires_at: '2026-05-01T12:00:00.000Z',
    hive_id: 'default-general',
    initiator_type: 'user',
    initiator_id: 'agent_test',
    ...overrides,
  };
}

describe('schedules DAL — CRUD', () => {
  it('createSchedule + findScheduleById roundtrip', () => {
    const created = schedules.createSchedule(makeInput());
    expect(created.id).toMatch(/^sch_/);
    expect(created.cron).toBe('0 * * * *');
    expect(created.payload).toEqual({
      spec_ref: { resource_id: 'res_1', spec_id: 'spec_1' },
      target_swarm_ids: ['swarm_a'],
    });
    expect(created.policy).toEqual({ catchUp: 'fire-once', skipIfRunning: false });
    expect(created.paused).toBe(false);
    expect(created.initiator_id).toBe('agent_test');
    expect(created.pause_reason).toBeNull();

    const fetched = schedules.findScheduleById(created.id);
    expect(fetched).toEqual(created);
  });

  it('createSchedule applies non-default policy when given', () => {
    const created = schedules.createSchedule(
      makeInput({ policy: { catchUp: 'fire-all', skipIfRunning: true } }),
    );
    expect(created.policy).toEqual({ catchUp: 'fire-all', skipIfRunning: true });
  });

  it('listSchedules filters by hive_id, initiator_id, paused', () => {
    schedules.createSchedule(makeInput({ hive_id: 'h1', initiator_id: 'a1' }));
    schedules.createSchedule(makeInput({ hive_id: 'h2', initiator_id: 'a1' }));
    schedules.createSchedule(makeInput({ hive_id: 'h1', initiator_id: 'a2', paused: true }));

    expect(schedules.listSchedules({ hive_id: 'h1' }).data).toHaveLength(2);
    expect(schedules.listSchedules({ initiator_id: 'a1' }).data).toHaveLength(2);
    expect(schedules.listSchedules({ paused: true }).data).toHaveLength(1);
    expect(schedules.listSchedules({ hive_id: 'h1', paused: false }).data).toHaveLength(1);
  });

  it('countByInitiator', () => {
    schedules.createSchedule(makeInput({ initiator_id: 'a1' }));
    schedules.createSchedule(makeInput({ initiator_id: 'a1' }));
    schedules.createSchedule(makeInput({ initiator_id: 'a2' }));
    expect(schedules.countByInitiator('a1')).toBe(2);
    expect(schedules.countByInitiator('a2')).toBe(1);
    expect(schedules.countByInitiator('nonexistent')).toBe(0);
  });

  it('updateSchedule modifies cron and recomputes nothing else automatically', () => {
    const created = schedules.createSchedule(makeInput());
    const updated = schedules.updateSchedule(created.id, {
      cron: '5 * * * *',
      next_fires_at: '2026-05-01T13:05:00.000Z',
    });
    expect(updated!.cron).toBe('5 * * * *');
    expect(updated!.next_fires_at).toBe('2026-05-01T13:05:00.000Z');
  });

  it('updateSchedule with empty patch returns existing', () => {
    const created = schedules.createSchedule(makeInput());
    const result = schedules.updateSchedule(created.id, {});
    expect(result?.id).toBe(created.id);
  });

  it('updateSchedule on unknown id returns null', () => {
    expect(schedules.updateSchedule('sch_missing', { cron: '*' })).toBeNull();
  });

  it('pauseSchedule and resumeSchedule', () => {
    const created = schedules.createSchedule(makeInput());
    const paused = schedules.pauseSchedule(created.id, 'spec not found');
    expect(paused!.paused).toBe(true);
    expect(paused!.pause_reason).toBe('spec not found');

    const resumed = schedules.resumeSchedule(created.id);
    expect(resumed!.paused).toBe(false);
    expect(resumed!.pause_reason).toBeNull();
  });

  it('deleteSchedule removes the row', () => {
    const created = schedules.createSchedule(makeInput());
    expect(schedules.deleteSchedule(created.id)).toBe(true);
    expect(schedules.findScheduleById(created.id)).toBeNull();
    expect(schedules.deleteSchedule(created.id)).toBe(false); // idempotent
  });
});

describe('schedules DAL — ScheduleStore contract', () => {
  it('listDue returns schedules with next_fires_at <= now and not paused', async () => {
    schedules.createSchedule(
      makeInput({ initiator_id: 'past', next_fires_at: '2026-05-01T11:00:00.000Z' }),
    );
    schedules.createSchedule(
      makeInput({ initiator_id: 'future', next_fires_at: '2026-05-01T13:00:00.000Z' }),
    );
    schedules.createSchedule(
      makeInput({
        initiator_id: 'paused-past',
        next_fires_at: '2026-05-01T11:00:00.000Z',
        paused: true,
      }),
    );

    const store = schedules.createScheduleStore();
    const due = await store.listDue(new Date('2026-05-01T12:00:00.000Z'));
    expect(due).toHaveLength(1);
    expect(due[0].next_fires_at).toBe('2026-05-01T11:00:00.000Z');
    // DAL returns full OpenHiveSchedule rows (with host audit cols) — library
    // tick code only reads library-defined fields, but tests assert on host cols.
    expect((due[0] as schedules.OpenHiveSchedule).initiator_id).toBe('past');
  });

  it('markFired updates last_fired_at and next_fires_at', async () => {
    const created = schedules.createSchedule(makeInput());
    const store = schedules.createScheduleStore();
    await store.markFired(
      created.id,
      new Date('2026-05-01T12:00:01.000Z'),
      new Date('2026-05-01T13:00:00.000Z'),
    );
    const after = schedules.findScheduleById(created.id);
    expect(after!.last_fired_at).toBe('2026-05-01T12:00:01.000Z');
    expect(after!.next_fires_at).toBe('2026-05-01T13:00:00.000Z');
  });

  it('markFired accepts nextFiresAt=null (terminal cron)', async () => {
    const created = schedules.createSchedule(makeInput());
    const store = schedules.createScheduleStore();
    await store.markFired(created.id, new Date('2026-05-01T12:00:00.000Z'), null);
    const after = schedules.findScheduleById(created.id);
    expect(after!.next_fires_at).toBeNull();
  });

  it('advance updates next_fires_at without touching last_fired_at', async () => {
    const created = schedules.createSchedule(makeInput());
    const store = schedules.createScheduleStore();
    await store.advance(created.id, new Date('2026-05-01T13:00:00.000Z'));
    const after = schedules.findScheduleById(created.id);
    expect(after!.next_fires_at).toBe('2026-05-01T13:00:00.000Z');
    expect(after!.last_fired_at).toBeNull();
  });
});

describe('schedules DAL — hasUnfinishedDispatchForSchedule', () => {
  it('returns false when no dispatches exist for the schedule', () => {
    const s = schedules.createSchedule(makeInput());
    expect(schedules.hasUnfinishedDispatchForSchedule(s.id)).toBe(false);
  });

  it('returns true when a queued dispatch exists with the schedule initiator_id', () => {
    const s = schedules.createSchedule(makeInput());
    dispatches.createDispatch({
      spec_resource_id: 'res_1',
      spec_id: 'spec_1',
      target_swarm_id: 'swarm_a',
      initiator_type: 'agent',
      initiator_id: `schedule:${s.id}`,
    });
    expect(schedules.hasUnfinishedDispatchForSchedule(s.id)).toBe(true);
  });

  it('returns false when all dispatches are terminal', () => {
    const s = schedules.createSchedule(makeInput());
    const d = dispatches.createDispatch({
      spec_resource_id: 'res_1',
      spec_id: 'spec_1',
      target_swarm_id: 'swarm_a',
      initiator_type: 'agent',
      initiator_id: `schedule:${s.id}`,
    });
    // Move to terminal status.
    const db = getDatabase();
    db.prepare("UPDATE dispatches SET status = 'complete' WHERE id = ?").run(d.id);
    expect(schedules.hasUnfinishedDispatchForSchedule(s.id)).toBe(false);
  });

  it('only counts dispatches with the matching initiator_id', () => {
    const s = schedules.createSchedule(makeInput());
    // A dispatch for a DIFFERENT schedule
    dispatches.createDispatch({
      spec_resource_id: 'res_1',
      spec_id: 'spec_1',
      target_swarm_id: 'swarm_a',
      initiator_type: 'agent',
      initiator_id: 'schedule:other_schedule',
    });
    expect(schedules.hasUnfinishedDispatchForSchedule(s.id)).toBe(false);
  });
});
