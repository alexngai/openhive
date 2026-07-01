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
  getPayloadKind,
  isValidPayload,
  type DispatchSpecPayload,
  type DispatchPromptPayload,
  type ExperimentRunPayload,
  type FallbackSpawn,
  type OpenHiveSchedulePayload,
  type SpecRef,
} from './payload-types.js';
import { trackSpawnedFallback } from './spawn-tracker.js';

export interface FireHandlerDeps {
  /**
   * Looks up the spec referenced by a schedule's payload. Returns `null`
   * if the spec has been deleted (handler auto-pauses the schedule).
   */
  fetchSpec(ref: SpecRef): Promise<{ ok: true } | null>;
  /** Returns the global pause flag; when true, fires are silently dropped. */
  isAutonomousDispatchPaused(): boolean;
  /**
   * Reports the current online/offline status of a target swarm. Used by
   * the fallback-spawn check before deciding whether to spawn. Returns
   * `'unknown'` for unrecognized ids — treated the same as `'offline'`
   * for the all-offline decision.
   */
  getSwarmStatus?(swarmId: string): 'online' | 'offline' | 'unknown';
  /**
   * Spawn a fresh hosted swarm for fallback. Returns the registered
   * (MAP) swarm id, ready to dispatch to, plus the hosted-swarm id for
   * cleanup tracking. Implementation owns waiting for the spawn to be
   * online (or rejecting if the wait times out).
   */
  spawnFallbackSwarm?(opts: {
    adapter: FallbackSpawn['adapter'];
    name: string;
  }): Promise<{ swarmId: string; hostedSwarmId: string }>;
  /**
   * Fire a scheduled experiment run (autonomation control plane): resolve the
   * experiment, create a `queued` run, and launch the runner worker. Returns
   * the new run id, or null if the experiment is missing/inactive.
   */
  runScheduledExperiment?(
    payload: ExperimentRunPayload,
    scheduleId: string,
  ): { runId: string } | null;
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
    const kind = getPayloadKind(payload);

    // Experiment runs branch out before the dispatch fan-out — no spec, no
    // target swarms. Resolve + create a run + launch the worker.
    if (kind === 'experiment') {
      let runId: string | null = null;
      if (deps.runScheduledExperiment) {
        try {
          runId = deps.runScheduledExperiment(payload as ExperimentRunPayload, schedule.id)?.runId ?? null;
        } catch (err) {
          console.warn(
            `[scheduler] experiment fire failed for schedule=${schedule.id}: ${(err as Error).message}`,
          );
        }
      }
      broadcastToChannel('map:schedules', {
        type: 'schedule.fired',
        data: { schedule_id: schedule.id, kind, run_id: runId },
      });
      return;
    }

    const dispatchPayload = payload as DispatchSpecPayload | DispatchPromptPayload;

    // Per-kind setup: resolve spec ref + prompt-override.
    //   dispatch_spec   → existence-check the real spec, use its ref
    //   dispatch_prompt → synthesize a placeholder ref so the dispatch
    //                     row's NOT NULL columns are satisfied; pass the
    //                     prompt as prompt_override (the orchestrator's
    //                     enrichWithSpec is permissive when the spec
    //                     doesn't exist and falls through to prompt_override).
    let dispatchSpecResourceId: string;
    let dispatchSpecId: string;
    let promptOverride: string | null;

    if (kind === 'dispatch_spec') {
      const specPayload = payload as Extract<OpenHiveSchedulePayload, { spec_ref: unknown }>;
      const spec = await deps.fetchSpec(specPayload.spec_ref);
      if (!spec) {
        pauseSchedule(schedule.id, 'spec not found');
        broadcastToChannel('map:schedules', {
          type: 'schedule.paused',
          data: { schedule_id: schedule.id, reason: 'spec not found' },
        });
        return;
      }
      dispatchSpecResourceId = specPayload.spec_ref.resource_id;
      dispatchSpecId = specPayload.spec_ref.spec_id;
      promptOverride = specPayload.prompt_override ?? null;
    } else {
      // dispatch_prompt — no spec dependency. Synthesize a stable
      // identifier per schedule so dispatch rows are still grouped
      // sensibly when queried by spec_resource_id.
      const promptPayload = payload as Extract<OpenHiveSchedulePayload, { prompt: string }>;
      dispatchSpecResourceId = 'ad_hoc';
      dispatchSpecId = `sch:${schedule.id}`;
      promptOverride = promptPayload.prompt;
    }

    // Resolve target swarms — apply fallback_spawn when ALL configured
    // targets are offline. The fallback collapses fan-out to a single
    // spawned swarm (one dispatch this fire). On spawn failure, fall
    // through to the configured targets and let the orchestrator's
    // retry/stall logic handle offline-routing errors.
    const { targets, spawnedFallback } = await resolveTargets(
      dispatchPayload.target_swarm_ids,
      dispatchPayload.fallback_spawn,
      deps,
      schedule.id,
    );

    // Multi-swarm fan-out. Each fire produces N dispatch rows correlated by
    // initiator_id (no fire_id column yet — that lands when the metadata
    // column does in a later PR).
    const initiator_id = `schedule:${schedule.id}`;
    const created: string[] = [];
    for (const swarm_id of targets) {
      try {
        const dispatch = createDispatch({
          spec_resource_id: dispatchSpecResourceId,
          spec_id: dispatchSpecId,
          target_swarm_id: swarm_id,
          initiator_type: 'agent',
          initiator_id,
          prompt_override: promptOverride,
          acp_lifecycle: dispatchPayload.lifecycle?.acp,
          mail_lifecycle: dispatchPayload.lifecycle?.mail,
        });
        created.push(dispatch.id);
        // Bind the spawned-fallback swarm to this dispatch so the dispatch
        // event bridge can stop it on terminal. Only the FIRST dispatch
        // gets the binding (the fallback collapses fan-out to one, but
        // defensively if the loop ever ran twice we don't double-bind).
        if (spawnedFallback && created.length === 1) {
          trackSpawnedFallback(
            dispatch.id,
            spawnedFallback.hostedSwarmId,
            spawnedFallback.cleanupOnTerminal,
          );
        }
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
        kind,
        dispatch_count: created.length,
        target_count: dispatchPayload.target_swarm_ids.length,
        fallback_spawn_used: spawnedFallback != null,
      },
    });
  };
}

/**
 * Decide which swarms to actually dispatch to. Returns the original
 * `target_swarm_ids` unless ALL are offline AND `fallback_spawn` is
 * configured — in which case we spawn a fresh hosted swarm and return
 * its id (collapsing the fan-out to 1).
 */
async function resolveTargets(
  configuredTargets: string[],
  fallback: FallbackSpawn | undefined,
  deps: FireHandlerDeps,
  scheduleId: string,
): Promise<{
  targets: string[];
  spawnedFallback?: { hostedSwarmId: string; cleanupOnTerminal: boolean };
}> {
  if (!fallback || !deps.spawnFallbackSwarm || !deps.getSwarmStatus) {
    return { targets: configuredTargets };
  }

  const statuses = configuredTargets.map((id) => deps.getSwarmStatus!(id));
  const allOffline = statuses.every((s) => s !== 'online');
  if (!allOffline) {
    // At least one target is online — dispatch normally to the configured
    // set, no spawn. (We intentionally don't filter offline ones; the
    // orchestrator's retry logic handles transient offline targets.)
    return { targets: configuredTargets };
  }

  // All offline → spawn fallback. On spawn failure, fall through to the
  // configured targets so the orchestrator can still try (and surface its
  // own failure mode via stall/retry).
  try {
    const result = await deps.spawnFallbackSwarm({
      adapter: fallback.adapter,
      name: `sched-spawn-${scheduleId}`,
    });
    return {
      targets: [result.swarmId],
      spawnedFallback: {
        hostedSwarmId: result.hostedSwarmId,
        cleanupOnTerminal: fallback.cleanup_on_terminal !== false,
      },
    };
  } catch (err) {
    console.warn(
      `[scheduler] fallback spawn failed for schedule=${scheduleId}: ${(err as Error).message}`,
    );
    return { targets: configuredTargets };
  }
}
