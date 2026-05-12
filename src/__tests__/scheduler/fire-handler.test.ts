/**
 * Fire handler unit tests.
 *
 * Verifies:
 *   - Kill switch respect (no dispatches when paused)
 *   - Deleted spec → schedule auto-pauses with reason
 *   - Multi-swarm fan-out emits N dispatch rows
 *   - initiator_id="schedule:<id>" set correctly
 *   - Malformed payload → schedule auto-pauses
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as schedules from '../../db/dal/schedules.js';
import * as dispatches from '../../db/dal/dispatches.js';
import { createOpenHiveFireHandler } from '../../scheduler/fire-handler.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { DEFAULT_SCHEDULE_POLICY, type Schedule } from 'swarm-dispatch';

const TEST_ROOT = testRoot('scheduler-fire-handler');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'fire-handler.db');

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

function seedSchedule(targetSwarmIds: string[] = ['swarm_a']): schedules.OpenHiveSchedule {
  return schedules.createSchedule({
    cron: '0 * * * *',
    payload: {
      spec_ref: { resource_id: 'res_1', spec_id: 'spec_1' },
      target_swarm_ids: targetSwarmIds,
    },
    next_fires_at: '2026-05-01T12:00:00.000Z',
    hive_id: 'default-general',
    initiator_type: 'user',
    initiator_id: 'agent_test',
  });
}

function scheduleAsLibrary(s: schedules.OpenHiveSchedule): Schedule {
  // The library FireHandler takes a base Schedule (no OpenHive cols).
  // strip host-only fields so we can pass a faithful library-shape object.
  // (Library code only reads fields it knows about anyway, but be explicit.)
  return {
    id: s.id,
    cron: s.cron,
    timezone: s.timezone,
    payload: s.payload,
    policy: s.policy,
    paused: s.paused,
    next_fires_at: s.next_fires_at,
    last_fired_at: s.last_fired_at,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

describe('fire handler — kill switch', () => {
  it('does not create dispatches when autonomous dispatch is paused', async () => {
    const s = seedSchedule();
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => true,
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));
    expect(
      dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data,
    ).toHaveLength(0);
  });

  it('creates dispatches when not paused', async () => {
    const s = seedSchedule();
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));
    expect(
      dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data,
    ).toHaveLength(1);
  });
});

describe('fire handler — deleted spec auto-pause', () => {
  it('pauses the schedule with reason when spec is missing', async () => {
    const s = seedSchedule();
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => null, // spec not found
      isAutonomousDispatchPaused: () => false,
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));
    const after = schedules.findScheduleById(s.id)!;
    expect(after.paused).toBe(true);
    expect(after.pause_reason).toBe('spec not found');
    expect(
      dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data,
    ).toHaveLength(0);
  });
});

describe('fire handler — multi-swarm fan-out', () => {
  it('emits one dispatch per target_swarm_id with shared initiator_id', async () => {
    const s = seedSchedule(['swarm_a', 'swarm_b', 'swarm_c']);
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));

    const rows = dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.target_swarm_id))).toEqual(
      new Set(['swarm_a', 'swarm_b', 'swarm_c']),
    );
    for (const r of rows) {
      expect(r.initiator_type).toBe('agent');
      expect(r.initiator_id).toBe(`schedule:${s.id}`);
      expect(r.spec_resource_id).toBe('res_1');
      expect(r.spec_id).toBe('spec_1');
      expect(r.status).toBe('queued');
    }
  });

  it('continues after per-target failure rather than throwing', async () => {
    const s = seedSchedule(['swarm_a', 'swarm_b']);
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
    });

    // Spy on createDispatch to fail on swarm_a but succeed on swarm_b.
    let calls = 0;
    const original = dispatches.createDispatch;
    const spy = vi.spyOn(dispatches, 'createDispatch').mockImplementation((input) => {
      calls++;
      if (calls === 1) throw new Error('forced failure');
      return original(input);
    });

    // Should NOT throw — the handler swallows per-target errors so that
    // markFired still advances next_fires_at for the schedule.
    await expect(
      handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z')),
    ).resolves.toBeUndefined();

    spy.mockRestore();

    const rows = dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].target_swarm_id).toBe('swarm_b');
  });
});

describe('fire handler — malformed payload', () => {
  it('pauses with reason on missing target_swarm_ids', async () => {
    // Direct DB insert with malformed payload (bypassing CreateScheduleInput
    // validation). Tests the defense-in-depth guard.
    const db = getDatabase();
    const id = 'sch_bad';
    db.prepare(
      `INSERT INTO schedules (
         id, cron, payload, policy, paused, next_fires_at,
         hive_id, initiator_type, initiator_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, ?, '', 'user', 'a1', ?, ?)`,
    ).run(
      id,
      '0 * * * *',
      JSON.stringify({ spec_ref: { resource_id: 'r', spec_id: 's' } }), // missing target_swarm_ids
      JSON.stringify(DEFAULT_SCHEDULE_POLICY),
      '2026-05-01T12:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    );
    const s = schedules.findScheduleById(id)!;

    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));

    const after = schedules.findScheduleById(id)!;
    expect(after.paused).toBe(true);
    expect(after.pause_reason).toBe('malformed payload');
  });
});
