/**
 * Schedules REST routes.
 *
 * 7 endpoints exposing the schedules DAL + scheduler integration to users:
 *   GET    /schedules                list
 *   POST   /schedules                create (computes initial next_fires_at)
 *   GET    /schedules/:id            detail (includes recent fire history)
 *   PATCH  /schedules/:id            update (cron change → recompute next_fires_at)
 *   DELETE /schedules/:id
 *   POST   /schedules/:id/pause
 *   POST   /schedules/:id/resume     (recomputes next_fires_at from now)
 *
 * `fire-now` deliberately omitted — users already have POST /specs/:id/dispatch
 * for immediate execution; a wrapper buys nothing.
 *
 * Per-user cap enforced on create (config.scheduler.maxSchedulesPerAgent),
 * returning HTTP 429 when hit. Kill switch (autonomousDispatchPaused) is NOT
 * checked here for user-initiated REST calls — only agent-initiated MAP
 * calls (PR 4) are blocked by it, matching the dispatches pattern.
 */

import { FastifyInstance } from 'fastify';
import { evaluateCron } from 'swarm-dispatch';
import { createAuthOrAdminKey } from '../middleware/auth.js';
import * as schedulesDAL from '../../db/dal/schedules.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import { broadcastToChannel } from '../../realtime/index.js';
import {
  CreateScheduleBodySchema,
  UpdateScheduleBodySchema,
  ListSchedulesQuerySchema,
} from '../schemas/schedules.js';
import type { Config } from '../../config.js';

export async function schedulesRoutes(
  fastify: FastifyInstance,
  options: { config: Config },
): Promise<void> {
  const authOrAdminKey = createAuthOrAdminKey(options.config);
  const { scheduler: schedulerCfg } = options.config;

  // -------------------------------------------------------------------------
  // GET /schedules
  // -------------------------------------------------------------------------
  fastify.get(
    '/schedules',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const parsed = ListSchedulesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }
      const { hive_id, initiator_id, paused, limit, offset } = parsed.data;
      const result = schedulesDAL.listSchedules({
        hive_id,
        initiator_id,
        paused,
        limit,
        offset,
      });
      return reply.send({
        data: result.data,
        total: result.total,
        limit,
        offset,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /schedules
  // -------------------------------------------------------------------------
  fastify.post(
    '/schedules',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const parsed = CreateScheduleBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }
      const body = parsed.data;

      // Identity: REST callers are users (admin key creates as 'admin').
      const initiator_id = request.agent?.id ?? 'admin';
      const initiator_type = 'user';

      // Per-user cap.
      const existing = schedulesDAL.countByInitiator(initiator_id);
      if (existing >= schedulerCfg.maxSchedulesPerAgent) {
        return reply.status(429).send({
          error: 'Too Many Requests',
          message: `schedule cap reached (${schedulerCfg.maxSchedulesPerAgent})`,
        });
      }

      // Compute initial next_fires_at. Cron is already syntactically valid
      // (Zod refine via isValidCron); evaluateCron returns null only when
      // the expression has no future fires — reject in that case.
      const next = evaluateCron(body.cron, {
        now: new Date(),
        timezone: body.timezone,
      });
      if (next === null) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'cron has no future fires',
        });
      }

      const created = schedulesDAL.createSchedule({
        cron: body.cron,
        timezone: body.timezone,
        payload: body.payload,
        policy: body.policy,
        paused: body.paused,
        next_fires_at: next.toISOString(),
        hive_id: body.hive_id,
        initiator_type,
        initiator_id,
      });

      broadcastToChannel('map:schedules', {
        type: 'schedule.created',
        data: { schedule_id: created.id },
      });

      return reply.status(201).send({ schedule: created });
    },
  );

  // -------------------------------------------------------------------------
  // GET /schedules/:id
  // -------------------------------------------------------------------------
  fastify.get<{ Params: { id: string } }>(
    '/schedules/:id',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const schedule = schedulesDAL.findScheduleById(request.params.id);
      if (!schedule) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Schedule not found' });
      }
      // Recent fire history — dispatches with initiator_id="schedule:<id>".
      const fires = dispatchesDAL.listDispatches({
        initiator_id: `schedule:${schedule.id}`,
        limit: 20,
      });
      return reply.send({ schedule, fires: fires.data, fire_total: fires.total });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /schedules/:id
  // -------------------------------------------------------------------------
  fastify.patch<{ Params: { id: string } }>(
    '/schedules/:id',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const existing = schedulesDAL.findScheduleById(request.params.id);
      if (!existing) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Schedule not found' });
      }

      const parsed = UpdateScheduleBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }
      const body = parsed.data;

      // If cron changed, recompute next_fires_at from now (per design doc).
      const newCron = body.cron ?? existing.cron;
      const newTz =
        body.timezone !== undefined
          ? body.timezone ?? undefined
          : existing.timezone;
      let nextFiresAt: string | null | undefined;
      if (body.cron !== undefined) {
        const next = evaluateCron(newCron, { now: new Date(), timezone: newTz });
        if (next === null) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'cron has no future fires',
          });
        }
        nextFiresAt = next.toISOString();
      }

      const updated = schedulesDAL.updateSchedule(request.params.id, {
        cron: body.cron,
        timezone: body.timezone,
        payload: body.payload,
        policy: body.policy,
        next_fires_at: nextFiresAt,
      });

      broadcastToChannel('map:schedules', {
        type: 'schedule.updated',
        data: { schedule_id: request.params.id },
      });

      return reply.send({ schedule: updated });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /schedules/:id
  // -------------------------------------------------------------------------
  fastify.delete<{ Params: { id: string } }>(
    '/schedules/:id',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const ok = schedulesDAL.deleteSchedule(request.params.id);
      if (!ok) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Schedule not found' });
      }
      broadcastToChannel('map:schedules', {
        type: 'schedule.deleted',
        data: { schedule_id: request.params.id },
      });
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /schedules/:id/pause
  // -------------------------------------------------------------------------
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/schedules/:id/pause',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const reason = request.body?.reason ?? null;
      const updated = schedulesDAL.pauseSchedule(request.params.id, reason);
      if (!updated) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Schedule not found' });
      }
      broadcastToChannel('map:schedules', {
        type: 'schedule.paused',
        data: { schedule_id: request.params.id, reason },
      });
      return reply.send({ schedule: updated });
    },
  );

  // -------------------------------------------------------------------------
  // POST /schedules/:id/resume
  //
  // Recompute next_fires_at from now so a long-paused schedule doesn't
  // immediately fire a stale slot.
  // -------------------------------------------------------------------------
  fastify.post<{ Params: { id: string } }>(
    '/schedules/:id/resume',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const existing = schedulesDAL.findScheduleById(request.params.id);
      if (!existing) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Schedule not found' });
      }
      const next = evaluateCron(existing.cron, {
        now: new Date(),
        timezone: existing.timezone,
      });
      schedulesDAL.updateSchedule(request.params.id, {
        next_fires_at: next ? next.toISOString() : null,
      });
      const resumed = schedulesDAL.resumeSchedule(request.params.id);
      broadcastToChannel('map:schedules', {
        type: 'schedule.resumed',
        data: { schedule_id: request.params.id },
      });
      return reply.send({ schedule: resumed });
    },
  );
}
