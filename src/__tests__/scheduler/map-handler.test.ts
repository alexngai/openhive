/**
 * MAP schedule handler — auth matrix and method behavior.
 *
 * Tests the 7 MAP methods against the authorization axes:
 *   - Owner vs non-owner (mutating ops require owner)
 *   - User-created vs agent-created (user-created are read-only to agents)
 *   - Kill switch on create
 *   - Per-agent cap on create
 *   - Hive scoping (advisory in v1 — assert pass-through)
 *   - Invalid params validation (cron, payload shape)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import {
  handleScheduleRequest,
  MAP_SCHEDULE_METHODS,
} from '../../map/schedule-handler.js';
import * as schedulesDAL from '../../db/dal/schedules.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('scheduler-map-handler');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'map-handler.db');

const AGENT_ALICE = 'agent_alice';
const AGENT_BOB = 'agent_bob';
const SWARM_ID = 'swarm_test';
const MAX_PER_AGENT = 3;

function ctx(agentId: string) {
  return {
    swarmId: SWARM_ID,
    agentId,
    maxSchedulesPerAgent: MAX_PER_AGENT,
  };
}

function validCreate(overrides: Record<string, unknown> = {}) {
  return {
    cron: '0 * * * *',
    payload: {
      spec_ref: { resource_id: 'res_test', spec_id: 'spec_test' },
      target_swarm_ids: ['swarm_a'],
    },
    ...overrides,
  };
}

// The kill switch lives in src/map/dispatch-policy.ts. We toggle it per-test
// via vi.doMock; the handler imports it at module load time so we have to
// mock before importing the handler — but since handleScheduleRequest is
// already imported, we instead spy on the module via vi.spyOn at use sites.
let killSwitchEnabled = false;
vi.mock('../../map/dispatch-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../map/dispatch-policy.js')>();
  return {
    ...actual,
    isAutonomousDispatchPaused: () => killSwitchEnabled,
  };
});

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
  killSwitchEnabled = false;
});

// ────────────────────────────────────────────────────────── create ──
describe('map/schedules/create', () => {
  it('creates a schedule owned by the requesting agent', async () => {
    const res = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.CREATE,
      validCreate(),
      ctx(AGENT_ALICE),
    )) as { schedule_id: string; next_fires_at: string };

    expect(res.schedule_id).toMatch(/^sch_/);
    expect(res.next_fires_at).not.toBeNull();
    const row = schedulesDAL.findScheduleById(res.schedule_id)!;
    expect(row.initiator_type).toBe('agent');
    expect(row.initiator_id).toBe(AGENT_ALICE);
  });

  it('blocks when kill switch is on (-32004)', async () => {
    killSwitchEnabled = true;
    await expect(
      handleScheduleRequest(MAP_SCHEDULE_METHODS.CREATE, validCreate(), ctx(AGENT_ALICE)),
    ).rejects.toMatchObject({ code: -32004 });
  });

  it('rejects invalid cron (-32602)', async () => {
    await expect(
      handleScheduleRequest(
        MAP_SCHEDULE_METHODS.CREATE,
        validCreate({ cron: 'garbage' }),
        ctx(AGENT_ALICE),
      ),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('rejects missing target_swarm_ids (-32602)', async () => {
    await expect(
      handleScheduleRequest(
        MAP_SCHEDULE_METHODS.CREATE,
        {
          cron: '0 * * * *',
          payload: { spec_ref: { resource_id: 'r', spec_id: 's' } },
        },
        ctx(AGENT_ALICE),
      ),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('enforces per-agent cap (-32606)', async () => {
    for (let i = 0; i < MAX_PER_AGENT; i++) {
      await handleScheduleRequest(
        MAP_SCHEDULE_METHODS.CREATE,
        validCreate(),
        ctx(AGENT_ALICE),
      );
    }
    await expect(
      handleScheduleRequest(MAP_SCHEDULE_METHODS.CREATE, validCreate(), ctx(AGENT_ALICE)),
    ).rejects.toMatchObject({ code: -32606 });
  });

  it('cap is per-agent — another agent is unaffected', async () => {
    for (let i = 0; i < MAX_PER_AGENT; i++) {
      await handleScheduleRequest(
        MAP_SCHEDULE_METHODS.CREATE,
        validCreate(),
        ctx(AGENT_ALICE),
      );
    }
    // Bob hits cap is independent.
    const ok = await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.CREATE,
      validCreate(),
      ctx(AGENT_BOB),
    );
    expect(ok).toBeDefined();
  });
});

// ──────────────────────────────────────────────────── list / get ──
describe('map/schedules/list', () => {
  beforeEach(async () => {
    await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.CREATE,
      validCreate(),
      ctx(AGENT_ALICE),
    );
    await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.CREATE,
      validCreate(),
      ctx(AGENT_BOB),
    );
  });

  it('defaults to owned_by_me=true (filters to caller)', async () => {
    const res = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.LIST,
      {},
      ctx(AGENT_ALICE),
    )) as { schedules: schedulesDAL.OpenHiveSchedule[]; total: number };
    expect(res.total).toBe(1);
    expect(res.schedules[0].initiator_id).toBe(AGENT_ALICE);
  });

  it('owned_by_me=false returns all', async () => {
    const res = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.LIST,
      { owned_by_me: false },
      ctx(AGENT_ALICE),
    )) as { schedules: schedulesDAL.OpenHiveSchedule[]; total: number };
    expect(res.total).toBe(2);
  });

  it('explicit initiator_id overrides owned_by_me default', async () => {
    const res = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.LIST,
      { initiator_id: AGENT_BOB },
      ctx(AGENT_ALICE),
    )) as { schedules: schedulesDAL.OpenHiveSchedule[]; total: number };
    expect(res.total).toBe(1);
    expect(res.schedules[0].initiator_id).toBe(AGENT_BOB);
  });
});

describe('map/schedules/get', () => {
  it('returns schedule + fires for any caller (read is open)', async () => {
    const create = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.CREATE,
      validCreate(),
      ctx(AGENT_ALICE),
    )) as { schedule_id: string };

    // Bob can read Alice's schedule.
    const res = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.GET,
      { schedule_id: create.schedule_id },
      ctx(AGENT_BOB),
    )) as { schedule: schedulesDAL.OpenHiveSchedule; fires: unknown[]; fire_total: number };
    expect(res.schedule.id).toBe(create.schedule_id);
    expect(res.fires).toEqual([]);
    expect(res.fire_total).toBe(0);
  });

  it('returns -32605 for unknown id', async () => {
    await expect(
      handleScheduleRequest(
        MAP_SCHEDULE_METHODS.GET,
        { schedule_id: 'sch_missing' },
        ctx(AGENT_ALICE),
      ),
    ).rejects.toMatchObject({ code: -32605 });
  });

  it('returns -32602 for missing schedule_id', async () => {
    await expect(
      handleScheduleRequest(MAP_SCHEDULE_METHODS.GET, {}, ctx(AGENT_ALICE)),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

// ──────────────────────────────────────── update / pause / resume / delete ──
describe('owner-only mutation auth', () => {
  let aliceScheduleId: string;
  let userScheduleId: string;

  beforeEach(async () => {
    const r = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.CREATE,
      validCreate(),
      ctx(AGENT_ALICE),
    )) as { schedule_id: string };
    aliceScheduleId = r.schedule_id;

    // Simulate a user-created schedule via REST (initiator_type='user').
    const user = schedulesDAL.createSchedule({
      cron: '0 * * * *',
      payload: {
        spec_ref: { resource_id: 'res_u', spec_id: 'spec_u' },
        target_swarm_ids: ['swarm_a'],
      },
      next_fires_at: new Date(Date.now() + 60_000).toISOString(),
      hive_id: '',
      initiator_type: 'user',
      initiator_id: 'admin',
    });
    userScheduleId = user.id;
  });

  it('update by owner succeeds', async () => {
    const res = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.UPDATE,
      { schedule_id: aliceScheduleId, cron: '*/5 * * * *' },
      ctx(AGENT_ALICE),
    )) as { schedule_id: string };
    expect(res.schedule_id).toBe(aliceScheduleId);
    expect(schedulesDAL.findScheduleById(aliceScheduleId)!.cron).toBe('*/5 * * * *');
  });

  it('update by non-owner is rejected (-32604)', async () => {
    await expect(
      handleScheduleRequest(
        MAP_SCHEDULE_METHODS.UPDATE,
        { schedule_id: aliceScheduleId, cron: '*/5 * * * *' },
        ctx(AGENT_BOB),
      ),
    ).rejects.toMatchObject({ code: -32604 });
  });

  it('update of a user-created schedule by any agent is rejected (-32604)', async () => {
    await expect(
      handleScheduleRequest(
        MAP_SCHEDULE_METHODS.UPDATE,
        { schedule_id: userScheduleId, cron: '*/5 * * * *' },
        ctx(AGENT_ALICE),
      ),
    ).rejects.toMatchObject({ code: -32604 });
  });

  it('pause by owner succeeds with reason', async () => {
    const res = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.PAUSE,
      { schedule_id: aliceScheduleId, reason: 'manual hold' },
      ctx(AGENT_ALICE),
    )) as { schedule_id: string; paused: boolean };
    expect(res.paused).toBe(true);
    const row = schedulesDAL.findScheduleById(aliceScheduleId)!;
    expect(row.paused).toBe(true);
    expect(row.pause_reason).toBe('manual hold');
  });

  it('pause by non-owner is rejected (-32604)', async () => {
    await expect(
      handleScheduleRequest(
        MAP_SCHEDULE_METHODS.PAUSE,
        { schedule_id: aliceScheduleId },
        ctx(AGENT_BOB),
      ),
    ).rejects.toMatchObject({ code: -32604 });
  });

  it('resume by owner clears pause + recomputes next_fires_at', async () => {
    await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.PAUSE,
      { schedule_id: aliceScheduleId },
      ctx(AGENT_ALICE),
    );
    const res = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.RESUME,
      { schedule_id: aliceScheduleId },
      ctx(AGENT_ALICE),
    )) as { paused: boolean; next_fires_at: string | null };
    expect(res.paused).toBe(false);
    expect(res.next_fires_at).not.toBeNull();
    const row = schedulesDAL.findScheduleById(aliceScheduleId)!;
    expect(row.paused).toBe(false);
    expect(row.pause_reason).toBeNull();
  });

  it('delete by owner removes the row', async () => {
    await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.DELETE,
      { schedule_id: aliceScheduleId },
      ctx(AGENT_ALICE),
    );
    expect(schedulesDAL.findScheduleById(aliceScheduleId)).toBeNull();
  });

  it('delete by non-owner is rejected (-32604)', async () => {
    await expect(
      handleScheduleRequest(
        MAP_SCHEDULE_METHODS.DELETE,
        { schedule_id: aliceScheduleId },
        ctx(AGENT_BOB),
      ),
    ).rejects.toMatchObject({ code: -32604 });
  });

  it('mutations on unknown id return -32605, NOT -32604', async () => {
    // Order matters in the handler: we check existence before ownership.
    await expect(
      handleScheduleRequest(
        MAP_SCHEDULE_METHODS.UPDATE,
        { schedule_id: 'sch_missing', cron: '*/5 * * * *' },
        ctx(AGENT_ALICE),
      ),
    ).rejects.toMatchObject({ code: -32605 });
  });
});

// ────────────────────────────────────────────────── update semantics ──
describe('map/schedules/update — semantics', () => {
  it('cron change recomputes next_fires_at from now', async () => {
    const create = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.CREATE,
      validCreate({ cron: '0 * * * *' }),
      ctx(AGENT_ALICE),
    )) as { schedule_id: string; next_fires_at: string };

    await new Promise((r) => setTimeout(r, 10));

    // Use `7 * * * *` (hourly at :07) — never collides with `0 * * * *`
    // (hourly at :00). Earlier `*/5 * * * *` silently coincided in the last
    // ~3 minutes of every hour (e.g. at 22:57, both have next_fires_at =
    // next :00:00), causing wall-clock-time flake.
    const upd = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.UPDATE,
      { schedule_id: create.schedule_id, cron: '7 * * * *' },
      ctx(AGENT_ALICE),
    )) as { next_fires_at: string };
    expect(upd.next_fires_at).not.toBe(create.next_fires_at);
  });

  it('also accepts a nested patch object', async () => {
    const create = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.CREATE,
      validCreate(),
      ctx(AGENT_ALICE),
    )) as { schedule_id: string };

    const res = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.UPDATE,
      { schedule_id: create.schedule_id, patch: { cron: '*/15 * * * *' } },
      ctx(AGENT_ALICE),
    )) as { schedule_id: string };
    expect(schedulesDAL.findScheduleById(res.schedule_id)!.cron).toBe('*/15 * * * *');
  });

  it('rejects invalid cron during update (-32602)', async () => {
    const create = (await handleScheduleRequest(
      MAP_SCHEDULE_METHODS.CREATE,
      validCreate(),
      ctx(AGENT_ALICE),
    )) as { schedule_id: string };

    await expect(
      handleScheduleRequest(
        MAP_SCHEDULE_METHODS.UPDATE,
        { schedule_id: create.schedule_id, cron: 'garbage' },
        ctx(AGENT_ALICE),
      ),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe('unknown method', () => {
  it('returns -32601', async () => {
    await expect(
      handleScheduleRequest('map/schedules/bogus', {}, ctx(AGENT_ALICE)),
    ).rejects.toMatchObject({ code: -32601 });
  });
});
