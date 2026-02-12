/**
 * Event Compaction
 *
 * Compact old events into snapshots for storage management.
 * New peers backfill from snapshots instead of full event history.
 */

import { getDatabase } from '../db/index.js';

export interface CompactionResult {
  eventsRemoved: number;
  snapshotSeq: number;
}

export interface Snapshot {
  sync_group_id: string;
  snapshot_seq: number;
  posts: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  votes: Array<Record<string, unknown>>;
  created_at: string;
}

/**
 * Compact events older than retentionMs for a sync group.
 * Keeps only events newer than the retention window.
 */
export function compactEvents(syncGroupId: string, retentionMs: number): CompactionResult {
  const db = getDatabase();
  const cutoffTime = new Date(Date.now() - retentionMs).toISOString();

  // Find the max seq before the cutoff
  const seqRow = db.prepare(
    'SELECT MAX(seq) as max_seq FROM hive_events WHERE sync_group_id = ? AND received_at < ?'
  ).get(syncGroupId, cutoffTime) as { max_seq: number | null } | undefined;

  const snapshotSeq = seqRow?.max_seq ?? 0;
  if (snapshotSeq === 0) {
    return { eventsRemoved: 0, snapshotSeq: 0 };
  }

  // Delete events up to snapshotSeq
  const result = db.prepare(
    'DELETE FROM hive_events WHERE sync_group_id = ? AND seq <= ?'
  ).run(syncGroupId, snapshotSeq);

  return {
    eventsRemoved: result.changes,
    snapshotSeq,
  };
}

/**
 * Create a snapshot of current materialized state for a sync group.
 * Used for new peer backfill.
 */
export function createSnapshot(syncGroupId: string): Snapshot {
  const db = getDatabase();

  // Get the sync group's hive_id
  const syncGroup = db.prepare('SELECT hive_id FROM hive_sync_groups WHERE id = ?').get(syncGroupId) as { hive_id: string } | undefined;
  if (!syncGroup) {
    throw new Error(`Sync group ${syncGroupId} not found`);
  }

  const latestSeq = db.prepare(
    'SELECT MAX(seq) as max_seq FROM hive_events WHERE sync_group_id = ?'
  ).get(syncGroupId) as { max_seq: number | null };

  // Snapshot posts for this hive
  const posts = db.prepare(
    'SELECT * FROM posts WHERE hive_id = ?'
  ).all(syncGroup.hive_id) as Array<Record<string, unknown>>;

  // Snapshot comments for posts in this hive
  const postIds = posts.map(p => p.id);
  let comments: Array<Record<string, unknown>> = [];
  if (postIds.length > 0) {
    const placeholders = postIds.map(() => '?').join(',');
    comments = db.prepare(
      `SELECT * FROM comments WHERE post_id IN (${placeholders})`
    ).all(...postIds) as Array<Record<string, unknown>>;
  }

  // Snapshot votes for posts and comments in this hive
  const allTargetIds = [...postIds, ...comments.map(c => c.id as string)];
  let votes: Array<Record<string, unknown>> = [];
  if (allTargetIds.length > 0) {
    const placeholders = allTargetIds.map(() => '?').join(',');
    votes = db.prepare(
      `SELECT * FROM votes WHERE target_id IN (${placeholders})`
    ).all(...allTargetIds) as Array<Record<string, unknown>>;
  }

  return {
    sync_group_id: syncGroupId,
    snapshot_seq: latestSeq.max_seq ?? 0,
    posts,
    comments,
    votes,
    created_at: new Date().toISOString(),
  };
}
