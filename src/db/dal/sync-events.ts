import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import { incrementSeq } from './sync-groups.js';
import type { HiveEvent, HiveEventType, PendingEvent } from '../../sync/types.js';

export interface InsertEventInput {
  sync_group_id: string;
  event_type: HiveEventType;
  origin_instance_id: string;
  origin_ts: number;
  payload: string;
  signature: string;
  is_local: boolean;
}

function rowToEvent(row: Record<string, unknown>): HiveEvent {
  return row as unknown as HiveEvent;
}

/** Insert a locally-created event (auto-increments seq) */
export function insertLocalEvent(input: InsertEventInput): HiveEvent {
  const db = getDatabase();
  const id = `evt_${nanoid()}`;
  const seq = incrementSeq(input.sync_group_id);

  db.prepare(`
    INSERT INTO hive_events
      (id, sync_group_id, seq, event_type, origin_instance_id, origin_ts, payload, signature, is_local)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, input.sync_group_id, seq, input.event_type, input.origin_instance_id, input.origin_ts, input.payload, input.signature);

  return findEventById(id)!;
}

/** Insert a remote event (assigns next local seq) */
export function insertRemoteEvent(input: InsertEventInput): HiveEvent {
  const db = getDatabase();
  const id = `evt_${nanoid()}`;
  const seq = incrementSeq(input.sync_group_id);

  db.prepare(`
    INSERT INTO hive_events
      (id, sync_group_id, seq, event_type, origin_instance_id, origin_ts, payload, signature, is_local)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, input.sync_group_id, seq, input.event_type, input.origin_instance_id, input.origin_ts, input.payload, input.signature);

  return findEventById(id)!;
}

export function findEventById(id: string): HiveEvent | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hive_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToEvent(row) : null;
}

/** Get events since a sequence number, with pagination */
export function getEventsSince(syncGroupId: string, since: number, limit: number): { events: HiveEvent[]; nextSeq: number; hasMore: boolean } {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM hive_events WHERE sync_group_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
  ).all(syncGroupId, since, limit + 1) as Record<string, unknown>[];

  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map(rowToEvent);
  const nextSeq = events.length > 0 ? events[events.length - 1].seq : since;

  return { events, nextSeq, hasMore };
}

/** Get the latest sequence number for a sync group */
export function getLatestSeq(syncGroupId: string): number {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT MAX(seq) as max_seq FROM hive_events WHERE sync_group_id = ?'
  ).get(syncGroupId) as { max_seq: number | null } | undefined;
  return row?.max_seq ?? 0;
}

/** List events for a sync group (for debugging) */
export function listEvents(syncGroupId: string, limit: number = 100, offset: number = 0): HiveEvent[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM hive_events WHERE sync_group_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?'
  ).all(syncGroupId, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

export function countEvents(syncGroupId: string): number {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM hive_events WHERE sync_group_id = ?'
  ).get(syncGroupId) as { count: number };
  return row.count;
}

// ── Pending Events (causal ordering queue) ──────────────────────

export function insertPendingEvent(syncGroupId: string, eventJson: string, dependsOn: string[]): void {
  const db = getDatabase();
  const id = `pend_${nanoid()}`;
  db.prepare(`
    INSERT INTO hive_events_pending (id, sync_group_id, event_json, depends_on)
    VALUES (?, ?, ?, ?)
  `).run(id, syncGroupId, eventJson, JSON.stringify(dependsOn));
}

export function getPendingEvents(syncGroupId: string): PendingEvent[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM hive_events_pending WHERE sync_group_id = ? ORDER BY received_at ASC'
  ).all(syncGroupId) as Record<string, unknown>[];
  return rows as unknown as PendingEvent[];
}

export function deletePendingEvent(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM hive_events_pending WHERE id = ?').run(id);
}

/** Check if an event from a given origin already exists (GAP-9 dedup) */
export function eventExistsByOrigin(syncGroupId: string, originInstanceId: string, eventId: string): boolean {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT 1 FROM hive_events WHERE sync_group_id = ? AND origin_instance_id = ? AND id = ? LIMIT 1'
  ).get(syncGroupId, originInstanceId, eventId);
  return !!row;
}

/** Count pending events for a sync group (GAP-12 cap enforcement) */
export function countPendingEvents(syncGroupId: string): number {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM hive_events_pending WHERE sync_group_id = ?'
  ).get(syncGroupId) as { count: number };
  return row.count;
}

/** Drop oldest pending events for a sync group to enforce a cap (GAP-12) */
export function trimPendingEvents(syncGroupId: string, maxCount: number): number {
  const db = getDatabase();
  const result = db.prepare(`
    DELETE FROM hive_events_pending WHERE id IN (
      SELECT id FROM hive_events_pending
      WHERE sync_group_id = ?
      ORDER BY received_at ASC
      LIMIT MAX(0, (SELECT COUNT(*) FROM hive_events_pending WHERE sync_group_id = ?) - ?)
    )
  `).run(syncGroupId, syncGroupId, maxCount);
  return result.changes;
}

/** Clean up pending events older than maxAgeMs. Returns count deleted. */
export function cleanupStalePendingEvents(maxAgeMs: number): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = db.prepare(
    'DELETE FROM hive_events_pending WHERE received_at < ?'
  ).run(cutoff);
  return result.changes;
}
