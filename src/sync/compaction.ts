/**
 * Event Compaction
 *
 * Compact old events into snapshots for storage management.
 * New peers backfill from snapshots instead of full event history.
 */

import { nanoid } from 'nanoid';
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

/**
 * Restore materialized state from a snapshot.
 * Used for new peer backfill when event history has been compacted.
 * Deduplicates against existing records via origin tracking columns.
 */
export function restoreFromSnapshot(syncGroupId: string, snapshot: Snapshot): { posts: number; comments: number; votes: number } {
  const db = getDatabase();
  let postsRestored = 0;
  let commentsRestored = 0;
  let votesRestored = 0;

  const syncGroup = db.prepare('SELECT hive_id FROM hive_sync_groups WHERE id = ?').get(syncGroupId) as { hive_id: string } | undefined;
  if (!syncGroup) {
    throw new Error(`Sync group ${syncGroupId} not found`);
  }

  // Restore posts
  for (const post of snapshot.posts) {
    // Skip if we already have this post (by origin or id)
    if (post.origin_instance_id && post.origin_post_id) {
      const existing = db.prepare(
        'SELECT id FROM posts WHERE origin_instance_id = ? AND origin_post_id = ?'
      ).get(post.origin_instance_id, post.origin_post_id);
      if (existing) continue;
    }

    const id = `rp_${nanoid()}`;
    db.prepare(`
      INSERT OR IGNORE INTO posts (id, hive_id, author_id, title, content, url, score, comment_count,
        sync_event_id, origin_instance_id, origin_post_id, remote_author_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, syncGroup.hive_id,
      post.author_id, post.title, post.content, post.url,
      post.score ?? 0, post.comment_count ?? 0,
      post.sync_event_id, post.origin_instance_id, post.origin_post_id,
      post.remote_author_id,
      post.created_at, post.updated_at
    );
    postsRestored++;
  }

  // Restore comments
  for (const comment of snapshot.comments) {
    if (comment.origin_instance_id && comment.origin_comment_id) {
      const existing = db.prepare(
        'SELECT id FROM comments WHERE origin_instance_id = ? AND origin_comment_id = ?'
      ).get(comment.origin_instance_id, comment.origin_comment_id);
      if (existing) continue;
    }

    const id = `rc_${nanoid()}`;
    db.prepare(`
      INSERT OR IGNORE INTO comments (id, post_id, parent_id, author_id, content, score, depth, path,
        sync_event_id, origin_instance_id, origin_comment_id, remote_author_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, comment.post_id, comment.parent_id,
      comment.author_id, comment.content, comment.score ?? 0,
      comment.depth ?? 0, comment.path ?? id,
      comment.sync_event_id, comment.origin_instance_id, comment.origin_comment_id,
      comment.remote_author_id,
      comment.created_at, comment.updated_at
    );
    commentsRestored++;
  }

  // Restore votes
  for (const vote of snapshot.votes) {
    const existing = db.prepare(
      'SELECT id FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?'
    ).get(vote.agent_id, vote.target_type, vote.target_id);
    if (existing) continue;

    const id = `rv_${nanoid()}`;
    db.prepare(`
      INSERT OR IGNORE INTO votes (id, agent_id, target_type, target_id, value,
        sync_event_id, origin_instance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, vote.agent_id, vote.target_type, vote.target_id, vote.value,
      vote.sync_event_id, vote.origin_instance_id, vote.created_at
    );
    votesRestored++;
  }

  return { posts: postsRestored, comments: commentsRestored, votes: votesRestored };
}
