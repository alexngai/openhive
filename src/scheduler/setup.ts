/**
 * Scheduler bootstrap for OpenHive.
 *
 * Composes swarm-dispatch's `createScheduler` with OpenHive's
 * `ScheduleStore` (from the DAL), the fire handler, and the
 * `isFireRunning` probe. Used by `src/server.ts` next to the dispatch
 * orchestrator.
 */

import { createScheduler, type Scheduler } from 'swarm-dispatch';
import {
  createScheduleStore,
  hasUnfinishedDispatchForSchedule,
  hasUnfinishedExperimentRunForSchedule,
} from '../db/dal/schedules.js';
import {
  createOpenHiveFireHandler,
  type FireHandlerDeps,
} from './fire-handler.js';
import { runScheduledExperiment as launcherRunScheduledExperiment } from '../experiments/launcher.js';
import { getPayloadKind, isValidPayload } from './payload-types.js';

/**
 * Default `fetchSpec` resolver for OpenHive's scheduler.
 *
 * Does an existence-only check against `syncable_resources` — NO auth check,
 * NO opentasks daemon resolution. The fire handler should auto-pause only
 * when the spec's resource has been deleted, NOT when it's transiently
 * unreachable (auth-denied, daemon down, remote-graph unavailable, etc.).
 * This matches the orchestrator's own permissive `enrichWithSpec` — it skips
 * prompt enrichment but still dispatches.
 *
 * Bug history: an earlier version wired `fetchSpec` to
 * `fetchSpecForDispatch(ref, 'system')`, which ran an auth check via
 * `canAccessResource('system', resource)`. There's no `'system'` agent in
 * the DB → check fails → fire handler treated `null` as "spec deleted" →
 * auto-paused every schedule against a non-public resource. Caught by the
 * manual smoke test on a live hub; never reached production because the
 * automated end-to-end test used a stub `fetchSpec`.
 *
 * Injected via deps so tests can plug in `vi.fn()` (unit-test the contract)
 * or a real DAL function (integration-test the wiring).
 */
export function createOpenHiveSpecResolver(deps: {
  findResourceById: (id: string) => unknown | null;
}): FireHandlerDeps['fetchSpec'] {
  return async (ref) => {
    const resource = deps.findResourceById(ref.resource_id);
    return resource ? { ok: true } : null;
  };
}

export interface SetupSchedulerOptions {
  fetchSpec: FireHandlerDeps['fetchSpec'];
  isAutonomousDispatchPaused: FireHandlerDeps['isAutonomousDispatchPaused'];
  /** Optional — enables `fallback_spawn` decisions. */
  getSwarmStatus?: FireHandlerDeps['getSwarmStatus'];
  /** Optional — enables `fallback_spawn` execution. */
  spawnFallbackSwarm?: FireHandlerDeps['spawnFallbackSwarm'];
  /** Optional override for the scheduled-experiment runner (defaults to the launcher). */
  runScheduledExperiment?: FireHandlerDeps['runScheduledExperiment'];
  tickIntervalMs?: number;
  maxConcurrentFires?: number;
}

export function setupScheduler(opts: SetupSchedulerOptions): Scheduler {
  const store = createScheduleStore();
  // The launcher dials the hub base URL the server set post-listen (the actual
  // bound port), so no hubUrl override is threaded here.
  const runScheduledExperiment: FireHandlerDeps['runScheduledExperiment'] =
    opts.runScheduledExperiment ??
    ((payload, scheduleId) => launcherRunScheduledExperiment(payload, scheduleId));
  const fireHandler = createOpenHiveFireHandler({
    fetchSpec: opts.fetchSpec,
    isAutonomousDispatchPaused: opts.isAutonomousDispatchPaused,
    getSwarmStatus: opts.getSwarmStatus,
    spawnFallbackSwarm: opts.spawnFallbackSwarm,
    runScheduledExperiment,
  });

  const scheduler = createScheduler({
    store,
    isFireRunning: async (s) => {
      if (isValidPayload(s.payload) && getPayloadKind(s.payload) === 'experiment') {
        return hasUnfinishedExperimentRunForSchedule(s.id);
      }
      return hasUnfinishedDispatchForSchedule(s.id);
    },
    tickIntervalMs: opts.tickIntervalMs ?? 60_000,
    maxConcurrentFires: opts.maxConcurrentFires ?? 10,
  });

  scheduler.on('fire', fireHandler);
  scheduler.on('fire:error', (err, s) => {
    console.warn(
      `[scheduler] fire handler threw for schedule=${s.id}: ${(err as Error).message}`,
    );
  });

  return scheduler;
}
