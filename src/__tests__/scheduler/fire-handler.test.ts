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
import {
  _resetSpawnTracker,
  _bindingCount,
  takeSpawnedFallback,
} from '../../scheduler/spawn-tracker.js';
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

// ─────────────────────────────────────────────────────────────────────
// dispatch_prompt — ad-hoc prompt fires without a spec
// ─────────────────────────────────────────────────────────────────────
describe('fire handler — dispatch_prompt (ad-hoc payload)', () => {
  function seedAdHocSchedule(targetSwarmIds: string[] = ['swarm_a']) {
    return schedules.createSchedule({
      cron: '0 * * * *',
      payload: {
        kind: 'dispatch_prompt',
        prompt: 'Check open GitHub issues and triage them.',
        target_swarm_ids: targetSwarmIds,
      },
      next_fires_at: '2026-05-01T12:00:00.000Z',
      hive_id: 'default-general',
      initiator_type: 'user',
      initiator_id: 'agent_test',
    });
  }

  it('does NOT call fetchSpec (no spec dependency for ad-hoc prompts)', async () => {
    const s = seedAdHocSchedule();
    let fetchSpecCalled = false;
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => {
        fetchSpecCalled = true;
        return null;
      },
      isAutonomousDispatchPaused: () => false,
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));
    expect(fetchSpecCalled).toBe(false);
    // Should NOT auto-pause — there's no spec to be missing.
    expect(schedules.findScheduleById(s.id)!.paused).toBe(false);
  });

  it('creates dispatches with synthetic spec_ref (ad_hoc / sch:<id>) and prompt as prompt_override', async () => {
    const s = seedAdHocSchedule(['swarm_a', 'swarm_b']);
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }), // shouldn't be consulted
      isAutonomousDispatchPaused: () => false,
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));

    const rows = dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.spec_resource_id).toBe('ad_hoc');
      expect(r.spec_id).toBe(`sch:${s.id}`);
      expect(r.prompt_override).toBe('Check open GitHub issues and triage them.');
      expect(r.initiator_type).toBe('agent');
      expect(r.initiator_id).toBe(`schedule:${s.id}`);
      expect(r.status).toBe('queued');
    }
    expect(new Set(rows.map((r) => r.target_swarm_id))).toEqual(
      new Set(['swarm_a', 'swarm_b']),
    );
  });

  it('still respects the autonomous-dispatch kill switch', async () => {
    const s = seedAdHocSchedule();
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => true,
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));
    expect(
      dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data,
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// fallback_spawn — auto-spawn fallback when targets are offline
// ─────────────────────────────────────────────────────────────────────
describe('fire handler — fallback_spawn', () => {
  beforeEach(() => {
    _resetSpawnTracker();
  });

  function seedScheduleWithFallback(
    targets: string[],
    fallback: { adapter: 'openswarm' | 'claude-code' | 'codex'; cleanup_on_terminal?: boolean } = {
      adapter: 'openswarm',
    },
  ) {
    return schedules.createSchedule({
      cron: '0 * * * *',
      payload: {
        kind: 'dispatch_prompt',
        prompt: 'Do the thing.',
        target_swarm_ids: targets,
        fallback_spawn: fallback,
      },
      next_fires_at: '2026-05-01T12:00:00.000Z',
      hive_id: 'default-general',
      initiator_type: 'user',
      initiator_id: 'agent_test',
    });
  }

  it('skips fallback when at least one target is online', async () => {
    const s = seedScheduleWithFallback(['swarm_off', 'swarm_on']);
    let spawnCalled = false;
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
      getSwarmStatus: (id) => (id === 'swarm_on' ? 'online' : 'offline'),
      spawnFallbackSwarm: async () => {
        spawnCalled = true;
        return { swarmId: 'spawned', hostedSwarmId: 'h-spawned' };
      },
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));
    expect(spawnCalled).toBe(false);
    const rows = dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data;
    // Fan-out to both configured targets, no spawned swarm.
    expect(new Set(rows.map((r) => r.target_swarm_id))).toEqual(
      new Set(['swarm_off', 'swarm_on']),
    );
  });

  it('spawns + retargets when ALL configured targets are offline', async () => {
    const s = seedScheduleWithFallback(['swarm_a', 'swarm_b']);
    let spawnCalled = false;
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
      getSwarmStatus: () => 'offline',
      spawnFallbackSwarm: async ({ adapter, name }) => {
        spawnCalled = true;
        expect(adapter).toBe('openswarm');
        expect(name).toContain(`sched-spawn-${s.id}`);
        return { swarmId: 'spawned_swarm_xyz', hostedSwarmId: 'h-spawned-xyz' };
      },
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));
    expect(spawnCalled).toBe(true);

    const rows = dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data;
    // Fallback collapses fan-out to one — single dispatch to the spawned swarm.
    expect(rows).toHaveLength(1);
    expect(rows[0].target_swarm_id).toBe('spawned_swarm_xyz');

    // Spawn tracker should have a binding for the spawned dispatch.
    expect(_bindingCount()).toBe(1);
  });

  it('falls back to configured targets when spawn fails (best effort)', async () => {
    const s = seedScheduleWithFallback(['swarm_off']);
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
      getSwarmStatus: () => 'offline',
      spawnFallbackSwarm: async () => {
        throw new Error('spawn quota exceeded');
      },
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));
    const rows = dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data;
    expect(rows).toHaveLength(1);
    // Reverts to the configured (offline) target — orchestrator's retry/stall
    // logic will eventually mark it failed.
    expect(rows[0].target_swarm_id).toBe('swarm_off');
  });

  it('cleanup_on_terminal=false produces a binding that opts out of cleanup', async () => {
    const s = seedScheduleWithFallback(['swarm_off'], {
      adapter: 'openswarm',
      cleanup_on_terminal: false,
    });
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
      getSwarmStatus: () => 'offline',
      spawnFallbackSwarm: async () => ({
        swarmId: 'spawned_keep',
        hostedSwarmId: 'h-keep',
      }),
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));

    const rows = dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data;
    expect(rows).toHaveLength(1);

    const binding = takeSpawnedFallback(rows[0].id);
    expect(binding).toBeDefined();
    expect(binding!.cleanupOnTerminal).toBe(false);
    expect(binding!.hostedSwarmId).toBe('h-keep');
  });

  it('does NOT spawn when fallback_spawn is not configured (even if all offline)', async () => {
    const s = schedules.createSchedule({
      cron: '0 * * * *',
      payload: {
        kind: 'dispatch_prompt',
        prompt: 'no fallback configured',
        target_swarm_ids: ['offline_only'],
        // no fallback_spawn
      },
      next_fires_at: '2026-05-01T12:00:00.000Z',
      hive_id: 'default-general',
      initiator_type: 'user',
      initiator_id: 'agent_test',
    });
    let spawnCalled = false;
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
      getSwarmStatus: () => 'offline',
      spawnFallbackSwarm: async () => {
        spawnCalled = true;
        return { swarmId: 'never', hostedSwarmId: 'never-h' };
      },
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));
    expect(spawnCalled).toBe(false);
    expect(
      dispatches.listDispatches({ initiator_id: `schedule:${s.id}` }).data[0]
        .target_swarm_id,
    ).toBe('offline_only');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Backward compatibility — legacy payload (no `kind` field)
// ─────────────────────────────────────────────────────────────────────
describe('fire handler — backward compat with pre-discriminator payloads', () => {
  it('treats payload without `kind` as dispatch_spec', async () => {
    // Direct DB insert to construct a legacy-shape row (no `kind` field).
    const db = getDatabase();
    const id = 'sch_legacy';
    db.prepare(
      `INSERT INTO schedules (
         id, cron, payload, policy, paused, next_fires_at,
         hive_id, initiator_type, initiator_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, ?, '', 'user', 'a1', ?, ?)`,
    ).run(
      id,
      '0 * * * *',
      JSON.stringify({
        // intentionally no `kind` field — legacy shape
        spec_ref: { resource_id: 'res_legacy', spec_id: 'spec_legacy' },
        target_swarm_ids: ['swarm_legacy'],
      }),
      JSON.stringify(DEFAULT_SCHEDULE_POLICY),
      '2026-05-01T12:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    );
    const s = schedules.findScheduleById(id)!;

    let fetchSpecCalled = false;
    const handler = createOpenHiveFireHandler({
      fetchSpec: async () => {
        fetchSpecCalled = true;
        return { ok: true };
      },
      isAutonomousDispatchPaused: () => false,
    });
    await handler(scheduleAsLibrary(s), new Date('2026-05-01T12:00:00.000Z'));

    expect(fetchSpecCalled).toBe(true); // legacy = dispatch_spec, so fetchSpec IS consulted
    const rows = dispatches.listDispatches({ initiator_id: `schedule:${id}` }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].spec_resource_id).toBe('res_legacy');
    expect(rows[0].spec_id).toBe('spec_legacy');
  });
});
