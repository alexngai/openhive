/**
 * Schedules DAL — OpenHive's persistent schedules + ScheduleStore impl.
 *
 * Wraps the schedules table with both:
 *   - The library `ScheduleStore` contract (listDue/markFired/advance) consumed
 *     by `swarm-dispatch`'s scheduler tick loop.
 *   - OpenHive-shaped CRUD + query helpers (create, get, list-by-*, pause,
 *     etc.) used by REST/MAP handlers and the fire handler.
 *
 * The library schema columns are normalized via `parseScheduleRow` from
 * swarm-dispatch; OpenHive-specific audit columns (hive_id, initiator_*,
 * pause_reason) are added on top in `OpenHiveSchedule`.
 */

import { nanoid } from 'nanoid';
import {
  parseScheduleRow,
  type Schedule,
  type ScheduleStore,
  type SchedulePolicy,
  type RawScheduleRow,
  normalizeSchedulePolicy,
} from 'swarm-dispatch';
import { getDatabase } from '../index.js';

export type ScheduleInitiatorType = 'user' | 'agent';

export interface OpenHiveSchedule extends Schedule {
  hive_id: string;
  initiator_type: ScheduleInitiatorType;
  initiator_id: string;
  pause_reason: string | null;
}

interface ScheduleRow extends RawScheduleRow {
  hive_id: string;
  initiator_type: ScheduleInitiatorType;
  initiator_id: string;
  pause_reason: string | null;
}

function rowToSchedule(row: ScheduleRow): OpenHiveSchedule {
  const base = parseScheduleRow(row);
  return {
    ...base,
    hive_id: row.hive_id,
    initiator_type: row.initiator_type,
    initiator_id: row.initiator_id,
    pause_reason: row.pause_reason,
  };
}

// ============================================================================
// ScheduleStore contract (consumed by swarm-dispatch's scheduler tick)
// ============================================================================

export function createScheduleStore(): ScheduleStore {
  return {
    async listDue(now) {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT * FROM schedules
             WHERE paused = 0
               AND next_fires_at IS NOT NULL
               AND next_fires_at <= ?
             ORDER BY next_fires_at ASC
             LIMIT 1000`,
        )
        .all(now.toISOString()) as ScheduleRow[];
      return rows.map(rowToSchedule);
    },

    async markFired(id, firedAt, nextFiresAt) {
      const db = getDatabase();
      db.prepare(
        `UPDATE schedules
           SET last_fired_at = ?,
               next_fires_at = ?,
               updated_at = ?
         WHERE id = ?`,
      ).run(
        firedAt.toISOString(),
        nextFiresAt ? nextFiresAt.toISOString() : null,
        new Date().toISOString(),
        id,
      );
    },

    async advance(id, nextFiresAt) {
      const db = getDatabase();
      db.prepare(
        `UPDATE schedules
           SET next_fires_at = ?,
               updated_at = ?
         WHERE id = ?`,
      ).run(
        nextFiresAt ? nextFiresAt.toISOString() : null,
        new Date().toISOString(),
        id,
      );
    },
  };
}

// ============================================================================
// OpenHive CRUD
// ============================================================================

export interface CreateScheduleInput {
  cron: string;
  timezone?: string;
  payload: unknown;
  policy?: Partial<SchedulePolicy>;
  paused?: boolean;
  next_fires_at: string | null;
  hive_id: string;
  initiator_type: ScheduleInitiatorType;
  initiator_id: string;
}

export function createSchedule(input: CreateScheduleInput): OpenHiveSchedule {
  const db = getDatabase();
  const id = `sch_${nanoid()}`;
  const now = new Date().toISOString();
  const policy = normalizeSchedulePolicy(input.policy);

  db.prepare(
    `INSERT INTO schedules (
       id, cron, timezone, payload, policy, paused,
       next_fires_at, last_fired_at,
       hive_id, initiator_type, initiator_id, pause_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.cron,
    input.timezone ?? null,
    JSON.stringify(input.payload),
    JSON.stringify(policy),
    input.paused ? 1 : 0,
    input.next_fires_at,
    null,
    input.hive_id,
    input.initiator_type,
    input.initiator_id,
    null,
    now,
    now,
  );

  return findScheduleById(id)!;
}

export function findScheduleById(id: string): OpenHiveSchedule | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM schedules WHERE id = ?')
    .get(id) as ScheduleRow | undefined;
  return row ? rowToSchedule(row) : null;
}

export interface ListSchedulesOptions {
  hive_id?: string;
  initiator_id?: string;
  paused?: boolean;
  limit?: number;
  offset?: number;
}

export function listSchedules(
  options: ListSchedulesOptions = {},
): { data: OpenHiveSchedule[]; total: number } {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.hive_id !== undefined) {
    where.push('hive_id = ?');
    params.push(options.hive_id);
  }
  if (options.initiator_id !== undefined) {
    where.push('initiator_id = ?');
    params.push(options.initiator_id);
  }
  if (options.paused !== undefined) {
    where.push('paused = ?');
    params.push(options.paused ? 1 : 0);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  const total = (
    db
      .prepare(`SELECT COUNT(*) as n FROM schedules ${whereSql}`)
      .get(...params) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT * FROM schedules ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ScheduleRow[];

  return { data: rows.map(rowToSchedule), total };
}

export function countByInitiator(initiator_id: string): number {
  const db = getDatabase();
  return (
    db
      .prepare('SELECT COUNT(*) as n FROM schedules WHERE initiator_id = ?')
      .get(initiator_id) as { n: number }
  ).n;
}

export interface UpdateScheduleInput {
  cron?: string;
  timezone?: string | null;
  payload?: unknown;
  policy?: Partial<SchedulePolicy>;
  next_fires_at?: string | null;
}

export function updateSchedule(
  id: string,
  input: UpdateScheduleInput,
): OpenHiveSchedule | null {
  const db = getDatabase();
  const existing = findScheduleById(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.cron !== undefined) {
    sets.push('cron = ?');
    params.push(input.cron);
  }
  if (input.timezone !== undefined) {
    sets.push('timezone = ?');
    params.push(input.timezone);
  }
  if (input.payload !== undefined) {
    sets.push('payload = ?');
    params.push(JSON.stringify(input.payload));
  }
  if (input.policy !== undefined) {
    sets.push('policy = ?');
    params.push(JSON.stringify(normalizeSchedulePolicy(input.policy)));
  }
  if (input.next_fires_at !== undefined) {
    sets.push('next_fires_at = ?');
    params.push(input.next_fires_at);
  }

  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(
    ...params,
  );
  return findScheduleById(id);
}

export function pauseSchedule(
  id: string,
  reason: string | null = null,
): OpenHiveSchedule | null {
  const db = getDatabase();
  const result = db
    .prepare(
      `UPDATE schedules
         SET paused = 1, pause_reason = ?, updated_at = ?
         WHERE id = ?`,
    )
    .run(reason, new Date().toISOString(), id);
  if (result.changes === 0) return null;
  return findScheduleById(id);
}

export function resumeSchedule(id: string): OpenHiveSchedule | null {
  const db = getDatabase();
  const result = db
    .prepare(
      `UPDATE schedules
         SET paused = 0, pause_reason = NULL, updated_at = ?
         WHERE id = ?`,
    )
    .run(new Date().toISOString(), id);
  if (result.changes === 0) return null;
  return findScheduleById(id);
}

export function deleteSchedule(id: string): boolean {
  const db = getDatabase();
  return db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
}

// ============================================================================
// Fire-handler helpers
// ============================================================================

/**
 * isFireRunning probe for the scheduler. Returns true when there's a
 * non-terminal dispatch row tied to this schedule (`initiator_id =
 * 'schedule:<id>'`). Cheap query; runs every tick for every due schedule
 * whose policy.skipIfRunning is true.
 */
export function hasUnfinishedDispatchForSchedule(scheduleId: string): boolean {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT 1 FROM dispatches
         WHERE initiator_id = ?
           AND status IN ('queued', 'running')
         LIMIT 1`,
    )
    .get(`schedule:${scheduleId}`);
  return row !== undefined;
}
