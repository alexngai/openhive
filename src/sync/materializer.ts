/**
 * Event Materializer
 *
 * Materializes sync events into posts/comments/votes tables.
 * Called after remote events are received and verified.
 */

import { getDatabase } from '../db/index.js';
import { nanoid } from 'nanoid';
import { upsertRemoteAgent } from '../db/dal/remote-agents.js';
import { broadcastToChannel } from '../realtime/index.js';
import type {
  HiveEvent,
  PostCreatedPayload,
  PostUpdatedPayload,
  PostDeletedPayload,
  CommentCreatedPayload,
  CommentUpdatedPayload,
  CommentDeletedPayload,
  VoteCastPayload,
  AgentSnapshot,
} from './types.js';

const syncLogger = {
  info: (message: string, ctx?: Record<string, unknown>) => {
    console.info(`[Sync Materializer] ${message}`, ctx ? JSON.stringify(ctx) : '');
  },
  warn: (message: string, ctx?: Record<string, unknown>) => {
    console.warn(`[Sync Materializer] ${message}`, ctx ? JSON.stringify(ctx) : '');
  },
  error: (message: string, ctx?: Record<string, unknown>) => {
    console.error(`[Sync Materializer] ${message}`, ctx ? JSON.stringify(ctx) : '');
  },
};

/** Resolve an agent snapshot to a local ID — upserts into remote_agents_cache for remote agents */
export function resolveAuthor(author: AgentSnapshot, isLocal: boolean): { authorId: string; remoteAuthorId: string | null } {
  if (isLocal) {
    // Local agent — author_id points to agents table
    return { authorId: author.agent_id, remoteAuthorId: null };
  }

  // Remote agent — upsert into remote_agents_cache
  const remoteAgent = upsertRemoteAgent({
    origin_instance_id: author.instance_id,
    origin_agent_id: author.agent_id,
    name: author.name,
    avatar_url: author.avatar_url,
  });

  // For remote posts, we use a placeholder author_id since the FK is NOT NULL
  // We set remote_author_id to the cache entry for display
  return { authorId: author.agent_id, remoteAuthorId: remoteAgent.id };
}

/** Materialize a single event into the posts/comments/votes tables */
export function materializeEvent(event: HiveEvent, hiveId: string, hiveName: string, isLocal: boolean): void {
  const payload = JSON.parse(event.payload);

  switch (event.event_type) {
    case 'post_created':
      materializePostCreated(event, payload as PostCreatedPayload, hiveId, hiveName, isLocal);
      break;
    case 'post_updated':
      materializePostUpdated(event, payload as PostUpdatedPayload);
      break;
    case 'post_deleted':
      materializePostDeleted(payload as PostDeletedPayload, hiveId, hiveName);
      break;
    case 'comment_created':
      materializeCommentCreated(event, payload as CommentCreatedPayload, hiveId, hiveName, isLocal);
      break;
    case 'comment_updated':
      materializeCommentUpdated(event, payload as CommentUpdatedPayload);
      break;
    case 'comment_deleted':
      materializeCommentDeleted(payload as CommentDeletedPayload);
      break;
    case 'vote_cast':
      materializeVoteCast(event, payload as VoteCastPayload);
      break;
    default:
      syncLogger.warn(`Unknown event type: ${event.event_type}`, { event_id: event.id });
  }
}

/** Process a batch of events in sequence order */
export function materializeBatch(events: HiveEvent[], hiveId: string, hiveName: string, localInstanceId: string): void {
  for (const event of events) {
    const isLocal = event.origin_instance_id === localInstanceId;
    try {
      materializeEvent(event, hiveId, hiveName, isLocal);
    } catch (err) {
      syncLogger.error(`Failed to materialize event ${event.id}`, {
        event_type: event.event_type,
        error: (err as Error).message,
      });
    }
  }
}

// ── Post Materialization ────────────────────────────────────────

function materializePostCreated(event: HiveEvent, payload: PostCreatedPayload, hiveId: string, hiveName: string, isLocal: boolean): void {
  const db = getDatabase();

  // Check for duplicate (idempotency)
  const existing = db.prepare(
    'SELECT id FROM posts WHERE origin_instance_id = ? AND origin_post_id = ?'
  ).get(event.origin_instance_id, payload.post_id);
  if (existing) return;

  const { authorId, remoteAuthorId } = resolveAuthor(payload.author, isLocal);
  const id = `rp_${nanoid()}`;

  db.prepare(`
    INSERT INTO posts (id, hive_id, author_id, title, content, url, sync_event_id, origin_instance_id, origin_post_id, remote_author_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, hiveId, authorId, payload.title, payload.content, payload.url, event.id, event.origin_instance_id, payload.post_id, remoteAuthorId);

  broadcastToChannel(`hive:${hiveName}`, {
    type: 'new_post',
    data: { id, title: payload.title, origin_instance_id: event.origin_instance_id },
  });

  syncLogger.info('Materialized post_created', { post_id: id, origin: event.origin_instance_id });
}

function materializePostUpdated(event: HiveEvent, payload: PostUpdatedPayload): void {
  const db = getDatabase();

  const post = db.prepare(
    'SELECT id FROM posts WHERE origin_instance_id = ? AND origin_post_id = ?'
  ).get(event.origin_instance_id, payload.post_id) as { id: string } | undefined;
  if (!post) {
    syncLogger.warn('post_updated for unknown post', { post_id: payload.post_id, origin: event.origin_instance_id });
    return;
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (payload.title !== undefined) { updates.push('title = ?'); values.push(payload.title); }
  if (payload.content !== undefined) { updates.push('content = ?'); values.push(payload.content); }
  if (payload.url !== undefined) { updates.push('url = ?'); values.push(payload.url); }

  if (updates.length === 0) return;

  updates.push("updated_at = datetime('now')");
  values.push(post.id);

  db.prepare(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  syncLogger.info('Materialized post_updated', { post_id: post.id });
}

function materializePostDeleted(payload: PostDeletedPayload, hiveId: string, hiveName: string): void {
  const db = getDatabase();

  const post = db.prepare(
    'SELECT id FROM posts WHERE origin_instance_id IS NOT NULL AND origin_post_id = ?'
  ).get(payload.post_id) as { id: string } | undefined;
  if (!post) return;

  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);

  broadcastToChannel(`hive:${hiveName}`, {
    type: 'post_deleted',
    data: { id: post.id },
  });

  syncLogger.info('Materialized post_deleted', { post_id: post.id });
}

// ── Comment Materialization ─────────────────────────────────────

function materializeCommentCreated(event: HiveEvent, payload: CommentCreatedPayload, hiveId: string, hiveName: string, isLocal: boolean): void {
  const db = getDatabase();

  // Idempotency check
  const existing = db.prepare(
    'SELECT id FROM comments WHERE origin_instance_id = ? AND origin_comment_id = ?'
  ).get(event.origin_instance_id, payload.comment_id);
  if (existing) return;

  // Resolve the post (may be a remote post)
  let postId = payload.post_id;
  const localPost = db.prepare(
    'SELECT id FROM posts WHERE origin_post_id = ? OR id = ?'
  ).get(payload.post_id, payload.post_id) as { id: string } | undefined;
  if (localPost) postId = localPost.id;

  const { authorId, remoteAuthorId } = resolveAuthor(payload.author, isLocal);
  const id = `rc_${nanoid()}`;

  // Compute path/depth
  let depth = 0;
  let path = id;
  if (payload.parent_comment_id) {
    const parent = db.prepare(
      'SELECT id, depth, path FROM comments WHERE origin_comment_id = ? OR id = ?'
    ).get(payload.parent_comment_id, payload.parent_comment_id) as { id: string; depth: number; path: string } | undefined;
    if (parent) {
      depth = parent.depth + 1;
      path = `${parent.path}.${id}`;
    }
  }

  db.prepare(`
    INSERT INTO comments (id, post_id, parent_id, author_id, content, depth, path, sync_event_id, origin_instance_id, origin_comment_id, remote_author_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, postId, payload.parent_comment_id ?? null, authorId, payload.content, depth, path, event.id, event.origin_instance_id, payload.comment_id, remoteAuthorId);

  // Update post comment count
  db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(postId);

  broadcastToChannel(`post:${postId}`, {
    type: 'new_comment',
    data: { id, post_id: postId, origin_instance_id: event.origin_instance_id },
  });

  syncLogger.info('Materialized comment_created', { comment_id: id });
}

function materializeCommentUpdated(event: HiveEvent, payload: CommentUpdatedPayload): void {
  const db = getDatabase();

  const comment = db.prepare(
    'SELECT id FROM comments WHERE origin_instance_id = ? AND origin_comment_id = ?'
  ).get(event.origin_instance_id, payload.comment_id) as { id: string } | undefined;
  if (!comment) return;

  db.prepare("UPDATE comments SET content = ?, updated_at = datetime('now') WHERE id = ?")
    .run(payload.content, comment.id);

  syncLogger.info('Materialized comment_updated', { comment_id: comment.id });
}

function materializeCommentDeleted(payload: CommentDeletedPayload): void {
  const db = getDatabase();

  const comment = db.prepare(
    'SELECT id, post_id, path FROM comments WHERE origin_comment_id = ?'
  ).get(payload.comment_id) as { id: string; post_id: string; path: string } | undefined;
  if (!comment) return;

  // Count children for comment_count update
  const countRow = db.prepare('SELECT COUNT(*) as count FROM comments WHERE path LIKE ?')
    .get(`${comment.path}%`) as { count: number };

  db.prepare('DELETE FROM comments WHERE path LIKE ?').run(`${comment.path}%`);
  db.prepare('UPDATE posts SET comment_count = comment_count - ? WHERE id = ?').run(countRow.count, comment.post_id);

  syncLogger.info('Materialized comment_deleted', { comment_id: comment.id });
}

// ── Vote Materialization ────────────────────────────────────────

function materializeVoteCast(event: HiveEvent, payload: VoteCastPayload): void {
  const db = getDatabase();

  // Resolve the target to a local ID
  let targetId = payload.target_id;
  if (payload.target_type === 'post') {
    const local = db.prepare('SELECT id FROM posts WHERE origin_post_id = ? OR id = ?').get(payload.target_id, payload.target_id) as { id: string } | undefined;
    if (local) targetId = local.id;
  } else {
    const local = db.prepare('SELECT id FROM comments WHERE origin_comment_id = ? OR id = ?').get(payload.target_id, payload.target_id) as { id: string } | undefined;
    if (local) targetId = local.id;
  }

  // Build a unique voter ID from instance + agent
  const voterId = `${payload.voter.instance_id}:${payload.voter.agent_id}`;

  if (payload.value === 0) {
    // Remove vote
    const existing = db.prepare(
      'SELECT id, value FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?'
    ).get(voterId, payload.target_type, targetId) as { id: string; value: number } | undefined;

    if (existing) {
      db.prepare('DELETE FROM votes WHERE id = ?').run(existing.id);
      if (payload.target_type === 'post') {
        db.prepare('UPDATE posts SET score = score - ? WHERE id = ?').run(existing.value, targetId);
      } else {
        db.prepare('UPDATE comments SET score = score - ? WHERE id = ?').run(existing.value, targetId);
      }
    }
  } else {
    // Upsert vote
    const existing = db.prepare(
      'SELECT id, value FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?'
    ).get(voterId, payload.target_type, targetId) as { id: string; value: number } | undefined;

    if (existing) {
      const delta = payload.value - existing.value;
      db.prepare('UPDATE votes SET value = ? WHERE id = ?').run(payload.value, existing.id);
      if (delta !== 0) {
        if (payload.target_type === 'post') {
          db.prepare('UPDATE posts SET score = score + ? WHERE id = ?').run(delta, targetId);
        } else {
          db.prepare('UPDATE comments SET score = score + ? WHERE id = ?').run(delta, targetId);
        }
      }
    } else {
      const id = `rv_${nanoid()}`;
      db.prepare(`
        INSERT INTO votes (id, agent_id, target_type, target_id, value, sync_event_id, origin_instance_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, voterId, payload.target_type, targetId, payload.value, event.id, event.origin_instance_id);

      if (payload.target_type === 'post') {
        db.prepare('UPDATE posts SET score = score + ? WHERE id = ?').run(payload.value, targetId);
      } else {
        db.prepare('UPDATE comments SET score = score + ? WHERE id = ?').run(payload.value, targetId);
      }
    }
  }

  syncLogger.info('Materialized vote_cast', { target_type: payload.target_type, target_id: targetId });
}

// ── Pending Queue Processing ────────────────────────────────────

/** Process pending events whose dependencies are now satisfied */
export function processPendingQueue(syncGroupId: string, hiveId: string, hiveName: string, localInstanceId: string): number {
  const db = getDatabase();
  const pending = db.prepare(
    'SELECT * FROM hive_events_pending WHERE sync_group_id = ? ORDER BY received_at ASC'
  ).all(syncGroupId) as Array<{ id: string; event_json: string; depends_on: string }>;

  let processed = 0;

  for (const p of pending) {
    const deps = JSON.parse(p.depends_on) as string[];
    // Check if all dependencies are satisfied (posts/comments exist)
    const allSatisfied = deps.every(dep => {
      const post = db.prepare('SELECT id FROM posts WHERE origin_post_id = ? OR id = ?').get(dep, dep);
      const comment = db.prepare('SELECT id FROM comments WHERE origin_comment_id = ? OR id = ?').get(dep, dep);
      return post || comment;
    });

    if (allSatisfied) {
      const event = JSON.parse(p.event_json) as HiveEvent;
      const isLocal = event.origin_instance_id === localInstanceId;
      materializeEvent(event, hiveId, hiveName, isLocal);
      db.prepare('DELETE FROM hive_events_pending WHERE id = ?').run(p.id);
      processed++;
    }
  }

  return processed;
}
