/**
 * Regression test for the scheduler's `fetchSpec` wiring.
 *
 * The bug this guards against (caught by manual smoke test on the live env,
 * 2026-05-12):
 *
 *   The fire handler asks `fetchSpec(ref)` whether a schedule's spec is
 *   still valid. If `null` is returned, the handler auto-pauses the
 *   schedule with `pause_reason: "spec not found"`.
 *
 *   The original wiring routed `fetchSpec` through `fetchSpecForDispatch`,
 *   which runs `canAccessResource(agentId, resource)`. Hub-internal code
 *   has no real agent identity, so it passed `'system'`. There is no
 *   `'system'` agent in the DB → the auth check failed → every schedule
 *   against a non-public resource auto-paused on its very first tick.
 *
 *   The fix (see `createOpenHiveSpecResolver` in src/scheduler/setup.ts):
 *   replace the auth-gated full fetch with an existence-only DAL lookup
 *   (`findResourceById`). The fire handler should auto-pause only on
 *   "resource deleted", not "I can't access it" or "daemon is offline" —
 *   the orchestrator's own `enrichWithSpec` is already permissive about
 *   transient unavailability.
 *
 * This file tests two layers:
 *   1. The resolver factory in isolation (vi.fn() for the DAL).
 *   2. An end-to-end run with the REAL DAL — schedules a fire against a
 *      real seeded private resource and asserts the schedule does NOT
 *      auto-pause. This is the layer that would have caught the bug.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as schedules from '../../db/dal/schedules.js';
import * as dispatches from '../../db/dal/dispatches.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { setupScheduler, createOpenHiveSpecResolver } from '../../scheduler/setup.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('scheduler-spec-resolver');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'spec-resolver.db');

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
  db.exec('DELETE FROM syncable_resources');
  // Leave agents in place; per-test isolation isn't required for owner FK.
});

// ============================================================================
// Layer 1 — resolver factory contract (unit)
// ============================================================================

describe('createOpenHiveSpecResolver', () => {
  it('returns { ok: true } when findResourceById returns a resource', async () => {
    const findResourceById = vi.fn((id: string) =>
      id === 'res_present' ? { id: 'res_present', name: 'fake' } : null,
    );
    const fetchSpec = createOpenHiveSpecResolver({ findResourceById });
    const result = await fetchSpec({ resource_id: 'res_present', spec_id: 'spec_a' });
    expect(result).toEqual({ ok: true });
    expect(findResourceById).toHaveBeenCalledWith('res_present');
  });

  it('returns null when findResourceById returns null', async () => {
    const findResourceById = vi.fn(() => null);
    const fetchSpec = createOpenHiveSpecResolver({ findResourceById });
    const result = await fetchSpec({ resource_id: 'res_missing', spec_id: 'spec_a' });
    expect(result).toBeNull();
  });

  it('does NOT pass agentId / does NOT consult auth', async () => {
    // Contract: the resolver MUST NOT take or use any agent identity.
    // If a future refactor adds an agentId param + auth check, this test
    // breaks because the spy is called with the resource_id only.
    const findResourceById = vi.fn(() => ({ id: 'r' }));
    const fetchSpec = createOpenHiveSpecResolver({ findResourceById });
    await fetchSpec({ resource_id: 'r', spec_id: 's' });
    expect(findResourceById).toHaveBeenCalledTimes(1);
    expect(findResourceById).toHaveBeenCalledWith('r');
  });
});

// ============================================================================
// Layer 2 — end-to-end with the REAL DAL (regression)
//
// Insert a real private resource owned by some agent. Schedule a fire
// against it. Use the REAL resolver (DAL-backed). Assert:
//   - Schedule fires
//   - Schedule does NOT auto-pause
//   - Dispatch row appears with the right initiator_id
//
// The OLD buggy wiring would auto-pause on the first tick because the
// schedule's caller has no access to the private resource.
// ============================================================================

describe('scheduler end-to-end with the real default spec resolver', () => {
  it('does not auto-pause on a real private resource the caller has no special access to', async () => {
    const ownerAgent = await ensureAgent('owner-of-resource');

    // Private resource — visibility=private, owned by ownerAgent. A caller
    // that isn't ownerAgent (and isn't subscribed) would FAIL the
    // canAccessResource check, which is what the OLD wiring did.
    const resource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'regression-task-graph',
      git_remote_url: 'fake://regression',
      visibility: 'private',
      owner_agent_id: ownerAgent.id,
      metadata: { opentasks: true },
    });

    const sched = schedules.createSchedule({
      cron: '0 * * * *',
      payload: {
        spec_ref: { resource_id: resource.id, spec_id: 'fake-spec' },
        target_swarm_ids: ['swarm_test'],
      },
      next_fires_at: new Date(Date.now() - 60_000).toISOString(),
      hive_id: '',
      initiator_type: 'user',
      initiator_id: 'admin', // not ownerAgent — would fail OLD auth check
    });

    const scheduler = setupScheduler({
      // Production wiring (the thing the bug regressed in server.ts)
      fetchSpec: createOpenHiveSpecResolver({
        findResourceById: resourcesDAL.findResourceById,
      }),
      isAutonomousDispatchPaused: () => false,
      tickIntervalMs: 100,
    });

    try {
      scheduler.start();
      const initiatorId = `schedule:${sched.id}`;
      await waitFor(
        () => dispatches.listDispatches({ initiator_id: initiatorId }).data.length >= 1,
        { timeout: 5_000, message: 'expected dispatch row from scheduled fire' },
      );

      const after = schedules.findScheduleById(sched.id)!;
      expect(after.paused).toBe(false);
      expect(after.pause_reason).toBeNull();
      expect(after.last_fired_at).not.toBeNull();
    } finally {
      await scheduler.stop();
    }
  });

  it('DOES auto-pause when the resource is actually deleted', async () => {
    const ownerAgent = await ensureAgent('owner-of-resource');
    const resource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'doomed-task-graph',
      git_remote_url: 'fake://doomed',
      visibility: 'private',
      owner_agent_id: ownerAgent.id,
      metadata: { opentasks: true },
    });

    const sched = schedules.createSchedule({
      cron: '0 * * * *',
      payload: {
        spec_ref: { resource_id: resource.id, spec_id: 'fake-spec' },
        target_swarm_ids: ['swarm_test'],
      },
      next_fires_at: new Date(Date.now() - 60_000).toISOString(),
      hive_id: '',
      initiator_type: 'user',
      initiator_id: 'admin',
    });

    // Delete the resource AFTER schedule creation — fire handler should
    // observe missing resource and auto-pause.
    resourcesDAL.deleteResource(resource.id);

    const scheduler = setupScheduler({
      fetchSpec: createOpenHiveSpecResolver({
        findResourceById: resourcesDAL.findResourceById,
      }),
      isAutonomousDispatchPaused: () => false,
      tickIntervalMs: 100,
    });

    try {
      scheduler.start();
      await waitFor(
        () => schedules.findScheduleById(sched.id)?.paused === true,
        { timeout: 5_000, message: 'expected schedule to auto-pause on deleted resource' },
      );

      const after = schedules.findScheduleById(sched.id)!;
      expect(after.paused).toBe(true);
      expect(after.pause_reason).toBe('spec not found');

      // No dispatch row should exist.
      const rows = dispatches.listDispatches({ initiator_id: `schedule:${sched.id}` });
      expect(rows.total).toBe(0);
    } finally {
      await scheduler.stop();
    }
  });
});

// ============================================================================
// Helpers
// ============================================================================

async function ensureAgent(name: string) {
  const existing = agentsDAL.findAgentByName(name);
  if (existing) return existing;
  const { agent } = await agentsDAL.createAgent({
    name,
    description: 'test owner agent',
  });
  return agent;
}

async function waitFor(
  predicate: () => boolean | undefined,
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
