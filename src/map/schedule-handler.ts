/**
 * MAP Schedule Request Handler
 *
 * Handles `map/schedules/*` MAP protocol methods. Mirrors `dispatch-handler.ts`
 * + `spec-handler.ts` in shape. Agents can manage their own recurring schedules
 * (cron-style fires that produce dispatches).
 *
 * Authorization model (v1):
 *   - Read methods (list, get): open to any registered agent.
 *   - Mutating methods (update, delete, pause, resume): require the requesting
 *     agent to be the schedule's `initiator` — i.e., schedule was created by
 *     this agent via MAP. User-created schedules (REST) are read-only to agents.
 *   - Create: subject to the per-agent cap (config.scheduler.maxSchedulesPerAgent)
 *     AND the global kill switch (`autonomousDispatchPaused`).
 *   - Hive scoping: column exists on the schedules table but enforcement is
 *     advisory in v1, matching how dispatches handle hives. Tightening can
 *     land alongside the broader dispatch hive-enforcement work.
 *
 * `fire-now` deliberately omitted — agents already have `map/specs/dispatch`
 * for immediate execution; a wrapper buys nothing.
 *
 * Error codes:
 *   -32004  autonomous dispatch paused          (create only)
 *   -32602  invalid params                      (bad cron, malformed body)
 *   -32603  spec resolution failed              (cron has no future fires; spec not found is fire-time)
 *   -32604  not authorized                      (non-owner attempting a mutation)
 *   -32605  schedule not found
 *   -32606  per-agent schedule cap reached
 */

import { evaluateCron } from 'swarm-dispatch';
import * as schedulesDAL from '../db/dal/schedules.js';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { broadcastToChannel } from '../realtime/index.js';
import { isAutonomousDispatchPaused } from './dispatch-policy.js';
import {
  CreateScheduleBodySchema,
  UpdateScheduleBodySchema,
  ListSchedulesQuerySchema,
} from '../api/schemas/schedules.js';

// ============================================================================
// Method Constants
// ============================================================================

export const MAP_SCHEDULE_METHODS = {
  CREATE: 'map/schedules/create',
  LIST: 'map/schedules/list',
  GET: 'map/schedules/get',
  UPDATE: 'map/schedules/update',
  DELETE: 'map/schedules/delete',
  PAUSE: 'map/schedules/pause',
  RESUME: 'map/schedules/resume',
} as const;

export const MAP_SCHEDULE_METHOD_SET = new Set<string>(
  Object.values(MAP_SCHEDULE_METHODS),
);

// ============================================================================
// Errors
// ============================================================================

export class MAPScheduleRequestError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = 'MAPScheduleRequestError';
  }
}

// ============================================================================
// Context
// ============================================================================

export interface ScheduleRequestContext {
  swarmId: string;
  agentId: string;
  /**
   * Per-agent cap from `config.scheduler.maxSchedulesPerAgent`. Passed in so
   * tests can override and so the handler stays pure (no config import).
   */
  maxSchedulesPerAgent: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Owner check: schedule was created by this agent via MAP. Returns true
 * for matching initiator. User-created schedules (REST) always return false
 * to agents — they can read but not mutate.
 */
function isOwner(
  schedule: schedulesDAL.OpenHiveSchedule,
  agentId: string,
): boolean {
  return (
    schedule.initiator_type === 'agent' && schedule.initiator_id === agentId
  );
}

function requireString(p: Record<string, unknown>, name: string): string {
  const v = p[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new MAPScheduleRequestError(
      -32602,
      `Invalid params: ${name} must be a non-empty string`,
    );
  }
  return v;
}

// ============================================================================
// Handler
// ============================================================================

export async function handleScheduleRequest(
  method: string,
  params: unknown,
  context: ScheduleRequestContext,
): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    // ───────────────────────────────────────────────────────── create ──
    case MAP_SCHEDULE_METHODS.CREATE: {
      if (isAutonomousDispatchPaused()) {
        throw new MAPScheduleRequestError(
          -32004,
          'Autonomous dispatch is paused by hub admin. User-initiated schedule creation via REST is unaffected.',
        );
      }

      const parsed = CreateScheduleBodySchema.safeParse(p);
      if (!parsed.success) {
        throw new MAPScheduleRequestError(
          -32602,
          `Invalid params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      const body = parsed.data;

      const existing = schedulesDAL.countByInitiator(context.agentId);
      if (existing >= context.maxSchedulesPerAgent) {
        throw new MAPScheduleRequestError(
          -32606,
          `Schedule cap reached (${context.maxSchedulesPerAgent})`,
        );
      }

      const next = evaluateCron(body.cron, {
        now: new Date(),
        timezone: body.timezone,
      });
      if (next === null) {
        throw new MAPScheduleRequestError(
          -32603,
          'Cron expression has no future fires',
        );
      }

      const created = schedulesDAL.createSchedule({
        cron: body.cron,
        timezone: body.timezone,
        payload: body.payload,
        policy: body.policy,
        paused: body.paused,
        next_fires_at: next.toISOString(),
        hive_id: body.hive_id,
        initiator_type: 'agent',
        initiator_id: context.agentId,
      });

      broadcastToChannel('map:schedules', {
        type: 'schedule.created',
        data: { schedule_id: created.id },
      });

      return { schedule_id: created.id, next_fires_at: created.next_fires_at };
    }

    // ─────────────────────────────────────────────────────────── list ──
    case MAP_SCHEDULE_METHODS.LIST: {
      const parsed = ListSchedulesQuerySchema.safeParse(
        // The list query schema expects strings (query-string source).
        // Coerce booleans / numbers to strings to match.
        normalizeListParams(p),
      );
      if (!parsed.success) {
        throw new MAPScheduleRequestError(
          -32602,
          `Invalid params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      const { hive_id, initiator_id, paused, limit, offset } = parsed.data;

      // `owned_by_me`: agent-friendly shorthand. When true (default), filter
      // to schedules this agent created via MAP. When explicitly false, the
      // agent sees any in-scope schedule (still hive-bound when set).
      const ownedByMe = p.owned_by_me !== false;
      const effectiveInitiator =
        ownedByMe && !initiator_id ? context.agentId : initiator_id;

      const result = schedulesDAL.listSchedules({
        hive_id,
        initiator_id: effectiveInitiator,
        paused,
        limit,
        offset,
      });
      return {
        schedules: result.data,
        total: result.total,
        limit,
        offset,
      };
    }

    // ──────────────────────────────────────────────────────────── get ──
    case MAP_SCHEDULE_METHODS.GET: {
      const id = requireString(p, 'schedule_id');
      const schedule = schedulesDAL.findScheduleById(id);
      if (!schedule) {
        throw new MAPScheduleRequestError(-32605, 'Schedule not found');
      }
      const fires = dispatchesDAL.listDispatches({
        initiator_id: `schedule:${id}`,
        limit: 20,
      });
      return { schedule, fires: fires.data, fire_total: fires.total };
    }

    // ───────────────────────────────────────────────────────── update ──
    case MAP_SCHEDULE_METHODS.UPDATE: {
      const id = requireString(p, 'schedule_id');
      const existing = schedulesDAL.findScheduleById(id);
      if (!existing) {
        throw new MAPScheduleRequestError(-32605, 'Schedule not found');
      }
      if (!isOwner(existing, context.agentId)) {
        throw new MAPScheduleRequestError(
          -32604,
          'Only the schedule owner can update it',
        );
      }

      const patchSource =
        (p.patch as Record<string, unknown> | undefined) ?? p;
      const parsed = UpdateScheduleBodySchema.safeParse(patchSource);
      if (!parsed.success) {
        throw new MAPScheduleRequestError(
          -32602,
          `Invalid params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      const body = parsed.data;

      // Recompute next_fires_at from now when cron changes (per design doc).
      let nextFiresAt: string | null | undefined;
      if (body.cron !== undefined) {
        const tz =
          body.timezone !== undefined
            ? body.timezone ?? undefined
            : existing.timezone;
        const next = evaluateCron(body.cron, { now: new Date(), timezone: tz });
        if (next === null) {
          throw new MAPScheduleRequestError(
            -32603,
            'Cron expression has no future fires',
          );
        }
        nextFiresAt = next.toISOString();
      }

      const updated = schedulesDAL.updateSchedule(id, {
        cron: body.cron,
        timezone: body.timezone,
        payload: body.payload,
        policy: body.policy,
        next_fires_at: nextFiresAt,
      });

      broadcastToChannel('map:schedules', {
        type: 'schedule.updated',
        data: { schedule_id: id },
      });

      return { schedule_id: id, next_fires_at: updated?.next_fires_at ?? null };
    }

    // ───────────────────────────────────────────────────────── delete ──
    case MAP_SCHEDULE_METHODS.DELETE: {
      const id = requireString(p, 'schedule_id');
      const existing = schedulesDAL.findScheduleById(id);
      if (!existing) {
        throw new MAPScheduleRequestError(-32605, 'Schedule not found');
      }
      if (!isOwner(existing, context.agentId)) {
        throw new MAPScheduleRequestError(
          -32604,
          'Only the schedule owner can delete it',
        );
      }
      schedulesDAL.deleteSchedule(id);
      broadcastToChannel('map:schedules', {
        type: 'schedule.deleted',
        data: { schedule_id: id },
      });
      return { ok: true };
    }

    // ────────────────────────────────────────────────────────── pause ──
    case MAP_SCHEDULE_METHODS.PAUSE: {
      const id = requireString(p, 'schedule_id');
      const existing = schedulesDAL.findScheduleById(id);
      if (!existing) {
        throw new MAPScheduleRequestError(-32605, 'Schedule not found');
      }
      if (!isOwner(existing, context.agentId)) {
        throw new MAPScheduleRequestError(
          -32604,
          'Only the schedule owner can pause it',
        );
      }
      const reason = typeof p.reason === 'string' ? p.reason : null;
      const paused = schedulesDAL.pauseSchedule(id, reason);
      broadcastToChannel('map:schedules', {
        type: 'schedule.paused',
        data: { schedule_id: id, reason },
      });
      return { schedule_id: id, paused: paused?.paused ?? true };
    }

    // ───────────────────────────────────────────────────────── resume ──
    case MAP_SCHEDULE_METHODS.RESUME: {
      const id = requireString(p, 'schedule_id');
      const existing = schedulesDAL.findScheduleById(id);
      if (!existing) {
        throw new MAPScheduleRequestError(-32605, 'Schedule not found');
      }
      if (!isOwner(existing, context.agentId)) {
        throw new MAPScheduleRequestError(
          -32604,
          'Only the schedule owner can resume it',
        );
      }
      const next = evaluateCron(existing.cron, {
        now: new Date(),
        timezone: existing.timezone,
      });
      schedulesDAL.updateSchedule(id, {
        next_fires_at: next ? next.toISOString() : null,
      });
      const resumed = schedulesDAL.resumeSchedule(id);
      broadcastToChannel('map:schedules', {
        type: 'schedule.resumed',
        data: { schedule_id: id },
      });
      return {
        schedule_id: id,
        paused: false,
        next_fires_at: resumed?.next_fires_at ?? null,
      };
    }

    default:
      throw new MAPScheduleRequestError(-32601, `Method not found: ${method}`);
  }
}

// Coerce non-string list params (booleans / numbers passed via MAP) into the
// string-typed shape ListSchedulesQuerySchema expects.
function normalizeListParams(p: Record<string, unknown>): Record<string, string | undefined> {
  return {
    hive_id: typeof p.hive_id === 'string' ? p.hive_id : undefined,
    initiator_id: typeof p.initiator_id === 'string' ? p.initiator_id : undefined,
    paused:
      typeof p.paused === 'boolean'
        ? String(p.paused)
        : typeof p.paused === 'string'
          ? p.paused
          : undefined,
    limit:
      typeof p.limit === 'number'
        ? String(p.limit)
        : typeof p.limit === 'string'
          ? p.limit
          : undefined,
    offset:
      typeof p.offset === 'number'
        ? String(p.offset)
        : typeof p.offset === 'string'
          ? p.offset
          : undefined,
  };
}
