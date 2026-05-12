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
} from '../db/dal/schedules.js';
import {
  createOpenHiveFireHandler,
  type FireHandlerDeps,
} from './fire-handler.js';

export interface SetupSchedulerOptions {
  fetchSpec: FireHandlerDeps['fetchSpec'];
  isAutonomousDispatchPaused: FireHandlerDeps['isAutonomousDispatchPaused'];
  tickIntervalMs?: number;
  maxConcurrentFires?: number;
}

export function setupScheduler(opts: SetupSchedulerOptions): Scheduler {
  const store = createScheduleStore();
  const fireHandler = createOpenHiveFireHandler({
    fetchSpec: opts.fetchSpec,
    isAutonomousDispatchPaused: opts.isAutonomousDispatchPaused,
  });

  const scheduler = createScheduler({
    store,
    isFireRunning: async (s) => hasUnfinishedDispatchForSchedule(s.id),
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
