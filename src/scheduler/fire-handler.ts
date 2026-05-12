/**
 * OpenHive fire handler.
 *
 * The seam between swarm-dispatch's scheduler tick and OpenHive's dispatch
 * pipeline. When the scheduler emits a fire, this handler turns it into N
 * `queued` dispatch rows (one per target_swarm_id in the schedule payload).
 * The existing dispatch orchestrator picks them up on its next poll.
 *
 * Responsibilities (host-side, NOT library):
 *   - Validate payload shape (defense in depth; REST/MAP also Zod-validates).
 *   - Verify the referenced spec still exists; auto-pause if not.
 *   - Multi-swarm fan-out: one dispatch row per target.
 *   - Wire `initiator_id = "schedule:<id>"` so dispatches link back.
 *   - Respect the autonomous-dispatch kill switch (config.autonomousDispatchPaused).
 *
 * NOT responsibilities:
 *   - Cron math (the scheduler did it before calling us)
 *   - Retry semantics (we throw and the scheduler leaves the row due)
 *   - Dispatch routing (orchestrator owns that downstream)
 */

import type { ScheduleFireHandler, Schedule } from 'swarm-dispatch';
import { createDispatch } from '../db/dal/dispatches.js';
import { pauseSchedule } from '../db/dal/schedules.js';
import { broadcastToChannel } from '../realtime/index.js';
import {
  isValidPayload,
  type OpenHiveSchedulePayload,
  type SpecRef,
} from './payload-types.js';

export interface FireHandlerDeps {
  /**
   * Looks up the spec referenced by a schedule's payload. Returns `null`
   * if the spec has been deleted (handler auto-pauses the schedule).
   */
  fetchSpec(ref: SpecRef): Promise<{ ok: true } | null>;
  /** Returns the global pause flag; when true, fires are silently dropped. */
  isAutonomousDispatchPaused(): boolean;
}

export function createOpenHiveFireHandler(deps: FireHandlerDeps): ScheduleFireHandler {
  return async (schedule: Schedule) => {
    // Respect the global kill switch. Note: the scheduler still calls
    // markFired afterwards, so cadence stays on track — pause-then-resume
    // doesn't trigger a burst.
    if (deps.isAutonomousDispatchPaused()) {
      return;
    }

    if (!isValidPayload(schedule.payload)) {
      // Malformed payload (shouldn't happen — Zod gates create/update).
      // Auto-pause with reason so the operator can fix it.
      pauseSchedule(schedule.id, 'malformed payload');
      return;
    }

    const payload = schedule.payload as OpenHiveSchedulePayload;

    const spec = await deps.fetchSpec(payload.spec_ref);
    if (!spec) {
      pauseSchedule(schedule.id, 'spec not found');
      broadcastToChannel('map:schedules', {
        type: 'schedule.paused',
        data: { schedule_id: schedule.id, reason: 'spec not found' },
      });
      return;
    }

    // Multi-swarm fan-out. Each fire produces N dispatch rows correlated by
    // initiator_id (no fire_id column yet — that lands when the metadata
    // column does in a later PR).
    const initiator_id = `schedule:${schedule.id}`;
    const created: string[] = [];
    for (const swarm_id of payload.target_swarm_ids) {
      try {
        const dispatch = createDispatch({
          spec_resource_id: payload.spec_ref.resource_id,
          spec_id: payload.spec_ref.spec_id,
          target_swarm_id: swarm_id,
          initiator_type: 'agent',
          initiator_id,
          prompt_override: payload.prompt_override ?? null,
          acp_lifecycle: payload.lifecycle?.acp,
          mail_lifecycle: payload.lifecycle?.mail,
        });
        created.push(dispatch.id);
      } catch (err) {
        // Per-target failure — log + continue. The scheduler will markFired
        // even if some targets failed, because we don't throw out of the
        // handler. Re-trying would re-fire all targets including the ones
        // that succeeded, which is worse than partial fan-out.
        console.warn(
          `[scheduler] dispatch create failed for schedule=${schedule.id} swarm=${swarm_id}: ${(err as Error).message}`,
        );
      }
    }

    broadcastToChannel('map:schedules', {
      type: 'schedule.fired',
      data: {
        schedule_id: schedule.id,
        dispatch_count: created.length,
        target_count: payload.target_swarm_ids.length,
      },
    });
  };
}
