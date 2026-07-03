/**
 * PR 2 critical checkpoint test.
 *
 * Proves end-to-end via DAL — without REST, MAP, UI, or any of the
 * operator surface — that:
 *
 *   1. A schedule row inserted with next_fires_at in the past
 *   2. Gets picked up by the library scheduler's tick loop
 *   3. The OpenHive fire handler converts the fire to a `queued` dispatch
 *      row with initiator_id = `schedule:<id>`
 *   4. ScheduleStore.markFired advances next_fires_at correctly
 *
 * If this test passes, the wiring is correct. Everything in PR 3+ (REST,
 * MAP, UI) is operator surface; the core mechanic is proven here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as schedules from '../../db/dal/schedules.js';
import * as dispatches from '../../db/dal/dispatches.js';
import * as experiments from '../../db/dal/experiments.js';
import { setupScheduler } from '../../scheduler/setup.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('scheduler-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'scheduler-e2e.db');

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
  db.exec('DELETE FROM experiment_runs');
  db.exec('DELETE FROM experiments');
});

describe('scheduler end-to-end (DAL checkpoint)', () => {
  it('schedule due → fire → dispatch row appears → next_fires_at advances', async () => {
    // 1. Seed a schedule with next_fires_at in the past.
    const sched = schedules.createSchedule({
      cron: '0 * * * *', // every hour at :00
      payload: {
        spec_ref: { resource_id: 'res_e2e', spec_id: 'spec_e2e' },
        target_swarm_ids: ['swarm_e2e'],
      },
      next_fires_at: new Date(Date.now() - 60_000).toISOString(), // 1min ago
      hive_id: 'default-general',
      initiator_type: 'user',
      initiator_id: 'agent_test',
    });

    // 2. Bootstrap the scheduler with a fast tick interval.
    // fetchSpec returns "exists" so the fire handler proceeds.
    // No kill-switch.
    const scheduler = setupScheduler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
      tickIntervalMs: 100, // fast tick for the test
    });

    try {
      scheduler.start();

      // 3. Wait for the fire to produce a dispatch.
      const initiatorId = `schedule:${sched.id}`;
      await waitFor(
        () =>
          dispatches.listDispatches({ initiator_id: initiatorId }).data.length >= 1,
        { timeout: 5_000, message: 'expected a dispatch row to appear within 5s' },
      );

      const rows = dispatches.listDispatches({ initiator_id: initiatorId }).data;
      expect(rows).toHaveLength(1);
      const d = rows[0];

      // 4. Verify the dispatch shape.
      expect(d.status).toBe('queued');
      expect(d.initiator_type).toBe('agent');
      expect(d.initiator_id).toBe(initiatorId);
      expect(d.spec_resource_id).toBe('res_e2e');
      expect(d.spec_id).toBe('spec_e2e');
      expect(d.target_swarm_id).toBe('swarm_e2e');

      // 5. Verify the schedule advanced.
      const after = schedules.findScheduleById(sched.id)!;
      expect(after.last_fired_at).not.toBeNull();
      expect(after.next_fires_at).not.toBe(sched.next_fires_at); // moved forward
    } finally {
      await scheduler.stop();
    }
  });

  it('fan-out: one schedule with N target swarms produces N dispatch rows in one fire', async () => {
    const sched = schedules.createSchedule({
      cron: '0 * * * *',
      payload: {
        spec_ref: { resource_id: 'res_fan', spec_id: 'spec_fan' },
        target_swarm_ids: ['s1', 's2', 's3'],
      },
      next_fires_at: new Date(Date.now() - 60_000).toISOString(),
      hive_id: 'default-general',
      initiator_type: 'user',
      initiator_id: 'agent_test',
    });

    const scheduler = setupScheduler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
      tickIntervalMs: 100,
    });

    try {
      scheduler.start();
      const initiatorId = `schedule:${sched.id}`;
      await waitFor(
        () =>
          dispatches.listDispatches({ initiator_id: initiatorId }).data.length === 3,
        { timeout: 5_000, message: 'expected 3 fan-out dispatches' },
      );

      const rows = dispatches.listDispatches({ initiator_id: initiatorId }).data;
      const targets = new Set(rows.map((r) => r.target_swarm_id));
      expect(targets).toEqual(new Set(['s1', 's2', 's3']));
    } finally {
      await scheduler.stop();
    }
  });

  it('paused schedule does not fire', async () => {
    const sched = schedules.createSchedule({
      cron: '0 * * * *',
      payload: {
        spec_ref: { resource_id: 'res_paused', spec_id: 'spec_paused' },
        target_swarm_ids: ['swarm_paused'],
      },
      next_fires_at: new Date(Date.now() - 60_000).toISOString(),
      paused: true,
      hive_id: 'default-general',
      initiator_type: 'user',
      initiator_id: 'agent_test',
    });

    const scheduler = setupScheduler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
      tickIntervalMs: 100,
    });

    try {
      scheduler.start();
      // Wait a beat to be sure the tick had a chance to run.
      await sleep(500);
      const rows = dispatches.listDispatches({ initiator_id: `schedule:${sched.id}` }).data;
      expect(rows).toEqual([]);
    } finally {
      await scheduler.stop();
    }
  });

  it('kill switch suppresses dispatch creation but scheduler keeps advancing', async () => {
    const sched = schedules.createSchedule({
      cron: '0 * * * *',
      payload: {
        spec_ref: { resource_id: 'res_kill', spec_id: 'spec_kill' },
        target_swarm_ids: ['swarm_kill'],
      },
      next_fires_at: new Date(Date.now() - 60_000).toISOString(),
      hive_id: 'default-general',
      initiator_type: 'user',
      initiator_id: 'agent_test',
    });

    const scheduler = setupScheduler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => true, // kill switch ENGAGED
      tickIntervalMs: 100,
    });

    try {
      scheduler.start();
      // Wait for the scheduler to advance next_fires_at.
      const originalNext = sched.next_fires_at!;
      await waitFor(
        () => {
          const after = schedules.findScheduleById(sched.id)!;
          return after.next_fires_at !== null && after.next_fires_at !== originalNext;
        },
        { timeout: 5_000, message: 'expected next_fires_at to advance even when paused' },
      );

      const dispatchRows = dispatches.listDispatches({
        initiator_id: `schedule:${sched.id}`,
      }).data;
      expect(dispatchRows).toEqual([]);
    } finally {
      await scheduler.stop();
    }
  });

  it('skipIfRunning suppresses an experiment fire while a schedule run is active', async () => {
    const exp = experiments.createExperiment({
      name: 'scheduled overlap guard',
      objective_metric: 'eval.score',
      objective_direction: 'increase',
      config: { deployment: { deploymentPath: '/cfg/dep.yaml', runPath: '/cfg/run.yaml' } },
      status: 'active',
    });
    const sched = schedules.createSchedule({
      cron: '0 * * * *',
      payload: { kind: 'experiment', experiment_ref: exp.id },
      policy: { skipIfRunning: true },
      next_fires_at: new Date(Date.now() - 60_000).toISOString(),
      hive_id: 'default-general',
      initiator_type: 'user',
      initiator_id: 'agent_test',
    });
    experiments.createRun({
      experiment_id: exp.id,
      status: 'running',
      initiator_type: 'schedule',
      initiator_id: `schedule:${sched.id}`,
    });
    const runScheduledExperiment = vi.fn(() => ({ runId: 'exrun_new' }));

    const scheduler = setupScheduler({
      fetchSpec: async () => ({ ok: true }),
      isAutonomousDispatchPaused: () => false,
      runScheduledExperiment,
      tickIntervalMs: 100,
    });

    try {
      scheduler.start();
      const originalNext = sched.next_fires_at!;
      await waitFor(
        () => {
          const after = schedules.findScheduleById(sched.id)!;
          return after.next_fires_at !== null && after.next_fires_at !== originalNext;
        },
        { timeout: 5_000, message: 'expected next_fires_at to advance while skipping active run' },
      );

      expect(runScheduledExperiment).not.toHaveBeenCalled();
      expect(experiments.listRunsForExperiment(exp.id).total).toBe(1);
    } finally {
      await scheduler.stop();
    }
  });
});

// ============================================================================
// Helpers
// ============================================================================

async function waitFor(
  predicate: () => boolean,
  opts: { timeout: number; message: string; intervalMs?: number },
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < opts.timeout) {
    if (predicate()) return;
    await sleep(opts.intervalMs ?? 50);
  }
  throw new Error(`waitFor timed out: ${opts.message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
