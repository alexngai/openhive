/**
 * Event Materializer
 *
 * Materializes sync events into posts/comments/votes tables.
 * Called after remote events are received and verified.
 *
 * NEW-10: Uses MaterializerRepository abstraction instead of direct db.prepare()
 * calls. The SQLiteMaterializerRepository is the default implementation;
 * swap via setMaterializerRepo() for Postgres/Turso/testing.
 */

import { getDatabase } from '../db/index.js';
import { nanoid } from 'nanoid';
import { upsertRemoteAgent } from '../db/dal/remote-agents.js';
import { insertPendingEvent, countPendingEvents, trimPendingEvents } from '../db/dal/sync-events.js';
import { createSyncEvent } from '../db/dal/syncable-resources.js';
import * as coordinationDal from '../db/dal/coordination.js';
import { broadcastToChannel } from '../realtime/index.js';
import { getMaterializerRepo } from './materializer-repo.js';
import type {
  HiveEvent,
  PostCreatedPayload,
  PostUpdatedPayload,
  PostDeletedPayload,
  CommentCreatedPayload,
  CommentUpdatedPayload,
  CommentDeletedPayload,
  VoteCastPayload,
  ResourcePublishedPayload,
  ResourceUpdatedPayload,
  ResourceUnpublishedPayload,
  ResourceSyncedPayload,
  CoordinationTaskOfferedPayload,
  CoordinationTaskClaimedPayload,
  CoordinationTaskCompletedPayload,
  CoordinationMessagePayload,
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
      materializePostDeleted(payload as PostDeletedPayload, hiveName);
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
    case 'resource_published':
      materializeResourcePublished(event, payload as ResourcePublishedPayload, isLocal);
      break;
    case 'resource_updated':
      materializeResourceUpdated(event, payload as ResourceUpdatedPayload);
      break;
    case 'resource_unpublished':
      materializeResourceUnpublished(event, payload as ResourceUnpublishedPayload);
      break;
    case 'resource_synced':
      materializeResourceSynced(event, payload as ResourceSyncedPayload);
      break;
    case 'coordination_task_offered':
      materializeCoordinationTaskOffered(event, payload as CoordinationTaskOfferedPayload);
      break;
    case 'coordination_task_claimed':
      materializeCoordinationTaskClaimed(event, payload as CoordinationTaskClaimedPayload);
      break;
    case 'coordination_task_completed':
      materializeCoordinationTaskCompleted(event, payload as CoordinationTaskCompletedPayload);
      break;
    case 'coordination_message':
      materializeCoordinationMessage(event, payload as CoordinationMessagePayload);
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
  const repo = getMaterializerRepo();

  // Check for duplicate (idempotency)
  const existing = repo.findPostByOrigin(event.origin_instance_id, payload.post_id);
  if (existing) return;

  const { authorId, remoteAuthorId } = resolveAuthor(payload.author, isLocal);
  const id = `rp_${nanoid()}`;
  const createdAt = new Date(event.origin_ts).toISOString();

  repo.insertPost({
    id, hive_id: hiveId, author_id: authorId, title: payload.title,
    content: payload.content ?? null, url: payload.url ?? null,
    sync_event_id: event.id, origin_instance_id: event.origin_instance_id,
    origin_post_id: payload.post_id, remote_author_id: remoteAuthorId, created_at: createdAt,
  });

  broadcastToChannel(`hive:${hiveName}`, {
    type: 'new_post',
    data: { id, title: payload.title, origin_instance_id: event.origin_instance_id },
  });

  syncLogger.info('Materialized post_created', { post_id: id, origin: event.origin_instance_id });
}

function materializePostUpdated(event: HiveEvent, payload: PostUpdatedPayload): void {
  const repo = getMaterializerRepo();

  const post = repo.findPostByOrigin(event.origin_instance_id, payload.post_id);
  if (!post) {
    syncLogger.warn('post_updated for unknown post', { post_id: payload.post_id, origin: event.origin_instance_id });
    return;
  }

  // GAP-11: Last-writer-wins — only apply if this event is newer than current state
  if (post.updated_at) {
    const existingTs = new Date(post.updated_at).getTime();
    if (event.origin_ts <= existingTs) {
      syncLogger.info('Skipping stale post_updated (last-writer-wins)', {
        post_id: post.id,
        event_ts: event.origin_ts,
        existing_ts: existingTs,
      });
      return;
    }
  }

  const eventTs = new Date(event.origin_ts).toISOString();
  const hasUpdates = payload.title !== undefined || payload.content !== undefined || payload.url !== undefined;
  if (!hasUpdates) return;

  repo.updatePost(post.id, {
    title: payload.title, content: payload.content, url: payload.url, updated_at: eventTs,
  });
  syncLogger.info('Materialized post_updated', { post_id: post.id });
}

function materializePostDeleted(payload: PostDeletedPayload, hiveName: string): void {
  const repo = getMaterializerRepo();

  // Search by origin_post_id across all instances
  const db = getDatabase();
  const post = db.prepare(
    'SELECT id FROM posts WHERE origin_post_id = ? OR id = ?'
  ).get(payload.post_id, payload.post_id) as { id: string } | undefined;
  if (!post) return;

  repo.deletePost(post.id);

  broadcastToChannel(`hive:${hiveName}`, {
    type: 'post_deleted',
    data: { id: post.id },
  });

  syncLogger.info('Materialized post_deleted', { post_id: post.id });
}

// ── Comment Materialization ─────────────────────────────────────

function materializeCommentCreated(event: HiveEvent, payload: CommentCreatedPayload, _hiveId: string, _hiveName: string, isLocal: boolean): void {
  const repo = getMaterializerRepo();

  // Idempotency check
  const existing = repo.findCommentByOrigin(event.origin_instance_id, payload.comment_id);
  if (existing) return;

  // Resolve the post (may be a remote post)
  const localPost = repo.findPostByOriginOrId(payload.post_id);

  if (!localPost) {
    // Parent post hasn't arrived yet — enqueue for causal ordering
    insertPendingEvent(event.sync_group_id, JSON.stringify(event), [payload.post_id]);
    syncLogger.info('Enqueued comment_created pending parent post', { comment_id: payload.comment_id, post_id: payload.post_id });
    return;
  }

  const postId = localPost.id;
  const { authorId, remoteAuthorId } = resolveAuthor(payload.author, isLocal);
  const id = `rc_${nanoid()}`;
  const createdAt = new Date(event.origin_ts).toISOString();

  // Compute path/depth
  let depth = 0;
  let path = id;
  if (payload.parent_comment_id) {
    const parent = repo.findCommentByOriginOrId(payload.parent_comment_id);
    if (parent) {
      depth = parent.depth + 1;
      path = `${parent.path}.${id}`;
    }
  }

  repo.insertComment({
    id, post_id: postId, parent_id: payload.parent_comment_id ?? null,
    author_id: authorId, content: payload.content, depth, path,
    sync_event_id: event.id, origin_instance_id: event.origin_instance_id,
    origin_comment_id: payload.comment_id, remote_author_id: remoteAuthorId, created_at: createdAt,
  });

  // Update post comment count
  repo.updatePostCommentCount(postId, 1);

  broadcastToChannel(`post:${postId}`, {
    type: 'new_comment',
    data: { id, post_id: postId, origin_instance_id: event.origin_instance_id },
  });

  syncLogger.info('Materialized comment_created', { comment_id: id });
}

function materializeCommentUpdated(event: HiveEvent, payload: CommentUpdatedPayload): void {
  const repo = getMaterializerRepo();

  const comment = repo.findCommentByOrigin(event.origin_instance_id, payload.comment_id);
  if (!comment) return;

  // GAP-11: Last-writer-wins — only apply if this event is newer
  if (comment.updated_at) {
    const existingTs = new Date(comment.updated_at).getTime();
    if (event.origin_ts <= existingTs) {
      syncLogger.info('Skipping stale comment_updated (last-writer-wins)', {
        comment_id: comment.id,
        event_ts: event.origin_ts,
        existing_ts: existingTs,
      });
      return;
    }
  }

  const eventTs = new Date(event.origin_ts).toISOString();
  repo.updateComment(comment.id, payload.content, eventTs);

  syncLogger.info('Materialized comment_updated', { comment_id: comment.id });
}

function materializeCommentDeleted(payload: CommentDeletedPayload): void {
  const repo = getMaterializerRepo();

  const comment = repo.findCommentForDelete(payload.comment_id);
  if (!comment) return;

  const deletedCount = repo.deleteCommentTree(comment.path);
  repo.updatePostCommentCount(comment.post_id, -deletedCount);

  syncLogger.info('Materialized comment_deleted', { comment_id: comment.id });
}

// ── Vote Materialization ────────────────────────────────────────

function materializeVoteCast(event: HiveEvent, payload: VoteCastPayload): void {
  const repo = getMaterializerRepo();

  // Resolve the target to a local ID
  const target = repo.findVoteTarget(payload.target_type, payload.target_id);

  // NEW-7: If target doesn't exist locally, enqueue as pending event
  if (!target) {
    insertPendingEvent(event.sync_group_id, JSON.stringify(event), [payload.target_id]);
    syncLogger.info('Enqueued vote_cast pending target arrival', {
      target_type: payload.target_type,
      target_id: payload.target_id,
    });
    return;
  }

  const targetId = target.id;

  // Build a unique voter ID from instance + agent
  const voterId = `${payload.voter.instance_id}:${payload.voter.agent_id}`;

  if (payload.value === 0) {
    // Remove vote
    const existing = repo.findVote(voterId, payload.target_type, targetId);
    if (existing) {
      repo.deleteVote(existing.id);
      repo.updateTargetScore(payload.target_type, targetId, -existing.value);
    }
  } else {
    // Upsert vote
    const existing = repo.findVote(voterId, payload.target_type, targetId);

    if (existing) {
      const delta = payload.value - existing.value;
      repo.updateVoteValue(existing.id, payload.value);
      if (delta !== 0) {
        repo.updateTargetScore(payload.target_type, targetId, delta);
      }
    } else {
      const id = `rv_${nanoid()}`;
      repo.insertVote({
        id, agent_id: voterId, target_type: payload.target_type,
        target_id: targetId, value: payload.value,
        sync_event_id: event.id, origin_instance_id: event.origin_instance_id,
      });
      repo.updateTargetScore(payload.target_type, targetId, payload.value);
    }
  }

  syncLogger.info('Materialized vote_cast', { target_type: payload.target_type, target_id: targetId });
}

// ── Resource Materialization ────────────────────────────────────

function materializeResourcePublished(event: HiveEvent, payload: ResourcePublishedPayload, isLocal: boolean): void {
  const repo = getMaterializerRepo();

  const existing = repo.findResourceByOrigin(event.origin_instance_id, payload.resource_id);
  if (existing) return;

  const { authorId } = resolveAuthor(payload.owner, isLocal);
  const id = `rr_${nanoid()}`;
  const createdAt = new Date(event.origin_ts).toISOString();

  repo.upsertRemoteResource({
    id, resource_type: payload.resource_type, name: payload.name,
    description: payload.description, git_remote_url: payload.git_remote_url,
    visibility: payload.visibility, owner_agent_id: authorId,
    sync_event_id: event.id, origin_instance_id: event.origin_instance_id,
    origin_resource_id: payload.resource_id,
    metadata: payload.metadata ? JSON.stringify(payload.metadata) : null,
    created_at: createdAt,
  });

  broadcastToChannel(`resource:${payload.resource_type}:${id}`, {
    type: 'resource_published',
    data: {
      resource_id: id,
      resource_type: payload.resource_type,
      name: payload.name,
      visibility: payload.visibility,
      origin_instance_id: event.origin_instance_id,
    },
  });

  syncLogger.info('Materialized resource_published', { resource_id: id, origin: event.origin_instance_id });
}

function materializeResourceUpdated(event: HiveEvent, payload: ResourceUpdatedPayload): void {
  const repo = getMaterializerRepo();

  const resource = repo.findResourceByOrigin(event.origin_instance_id, payload.resource_id);
  if (!resource) {
    syncLogger.warn('resource_updated for unknown resource', { resource_id: payload.resource_id, origin: event.origin_instance_id });
    return;
  }

  if (resource.updated_at) {
    const existingTs = new Date(resource.updated_at).getTime();
    if (event.origin_ts <= existingTs) {
      syncLogger.info('Skipping stale resource_updated (last-writer-wins)', {
        resource_id: resource.id,
        event_ts: event.origin_ts,
        existing_ts: existingTs,
      });
      return;
    }
  }

  const eventTs = new Date(event.origin_ts).toISOString();
  const f = payload.fields;
  const hasUpdates = f.name !== undefined || f.description !== undefined || f.visibility !== undefined || f.metadata !== undefined;
  if (!hasUpdates) return;

  repo.updateRemoteResource(resource.id, {
    name: f.name, description: f.description, visibility: f.visibility,
    metadata: f.metadata ? JSON.stringify(f.metadata) : undefined,
    updated_at: eventTs,
  });

  syncLogger.info('Materialized resource_updated', { resource_id: resource.id });
}

function materializeResourceUnpublished(event: HiveEvent, payload: ResourceUnpublishedPayload): void {
  const repo = getMaterializerRepo();

  const resource = repo.findResourceByOrigin(event.origin_instance_id, payload.resource_id);
  if (!resource) return;

  broadcastToChannel(`resource:${resource.resource_type}:${resource.id}`, {
    type: 'resource_unpublished',
    data: {
      resource_id: resource.id,
      resource_type: resource.resource_type,
      origin_instance_id: event.origin_instance_id,
    },
  });

  repo.deleteRemoteResource(resource.id);
  syncLogger.info('Materialized resource_unpublished', { resource_id: resource.id });
}

function materializeResourceSynced(event: HiveEvent, payload: ResourceSyncedPayload): void {
  const repo = getMaterializerRepo();

  const resource = repo.findResourceByOrigin(event.origin_instance_id, payload.resource_id);
  if (!resource) {
    syncLogger.warn('resource_synced for unknown resource', { resource_id: payload.resource_id, origin: event.origin_instance_id });
    return;
  }

  const eventTs = new Date(event.origin_ts).toISOString();
  repo.updateResourceCommit(resource.id, payload.commit_hash, eventTs);

  const syncEvent = createSyncEvent({
    resource_id: resource.id,
    commit_hash: payload.commit_hash,
    commit_message: payload.commit_message ?? undefined,
    pusher: `sync:${payload.pusher_agent_id}`,
    files_added: payload.files_added,
    files_modified: payload.files_modified,
    files_removed: payload.files_removed,
  });

  broadcastToChannel(`resource:${resource.resource_type}:${resource.id}`, {
    type: 'resource_synced',
    data: {
      resource_id: resource.id,
      resource_type: resource.resource_type,
      commit_hash: payload.commit_hash,
      commit_message: payload.commit_message,
      pusher_agent_id: payload.pusher_agent_id,
      event_id: syncEvent.id,
      origin_instance_id: event.origin_instance_id,
    },
  });

  syncLogger.info('Materialized resource_synced', { resource_id: resource.id, commit: payload.commit_hash });
}

// ── Coordination Materialization ────────────────────────────────

function materializeCoordinationTaskOffered(event: HiveEvent, payload: CoordinationTaskOfferedPayload): void {
  // Idempotency: check if task already exists by origin tracking
  const existing = coordinationDal.findTaskByOrigin(event.origin_instance_id, payload.task_id);
  if (existing) return;

  coordinationDal.createTask(payload.hive_id, {
    title: payload.title,
    description: payload.description ?? undefined,
    priority: payload.priority,
    assigned_by_agent_id: payload.offered_by.agent_id,
    assigned_by_swarm_id: undefined,
    assigned_to_swarm_id: payload.assigned_to_swarm_id ?? '',
    context: payload.context ?? undefined,
    deadline: payload.deadline ?? undefined,
    origin_instance_id: event.origin_instance_id,
    origin_task_id: payload.task_id,
  });

  broadcastToChannel(`coordination:${payload.hive_id}`, {
    type: 'task_assigned',
    data: {
      task_id: payload.task_id,
      title: payload.title,
      priority: payload.priority,
      origin_instance_id: event.origin_instance_id,
    },
  });

  syncLogger.info('Materialized coordination_task_offered', { task_id: payload.task_id, origin: event.origin_instance_id });
}

function resolveTaskByOriginChain(
  event: HiveEvent,
  payload: { task_id: string; origin_instance_id?: string | null; origin_task_id?: string | null },
): ReturnType<typeof coordinationDal.findTaskById> {
  // 1. The claiming instance's local ID may match our origin tracking
  //    (e.g., we created the task locally with that ID as origin_task_id)
  let task = coordinationDal.findTaskByOrigin(event.origin_instance_id, payload.task_id);
  // 2. The payload carries the task's original origin (where it was first offered).
  //    This handles: A offers → B materializes → B claims → A receives claim.
  //    A's local task has no origin columns (created locally), but the payload
  //    tells us it was originally from A with origin_task_id = the original ID.
  if (!task && payload.origin_instance_id && payload.origin_task_id) {
    task = coordinationDal.findTaskByOrigin(payload.origin_instance_id, payload.origin_task_id);
  }
  // 3. Direct ID match — covers same-instance case and the case where
  //    the original task ID happens to match our local ID (task was created here)
  if (!task) {
    task = coordinationDal.findTaskById(payload.task_id);
  }
  // 4. The payload's origin_task_id might be our local task ID
  //    (A offered task ct_abc → B got it with origin_task_id=ct_abc → B claims →
  //     claim event has origin_task_id=ct_abc → A can find by direct ID ct_abc)
  if (!task && payload.origin_task_id) {
    task = coordinationDal.findTaskById(payload.origin_task_id);
  }
  return task;
}

function materializeCoordinationTaskClaimed(event: HiveEvent, payload: CoordinationTaskClaimedPayload): void {
  const task = resolveTaskByOriginChain(event, payload);
  if (!task) {
    syncLogger.warn('coordination_task_claimed for unknown task', { task_id: payload.task_id, origin: event.origin_instance_id });
    return;
  }

  coordinationDal.updateTask(task.id, { status: 'accepted' });

  broadcastToChannel(`coordination:${task.hive_id}`, {
    type: 'task_status_updated',
    data: {
      task_id: task.id,
      status: 'accepted',
      claimed_by: payload.claimed_by,
      origin_instance_id: event.origin_instance_id,
    },
  });

  syncLogger.info('Materialized coordination_task_claimed', { task_id: task.id, local_id: task.id, payload_id: payload.task_id });
}

function materializeCoordinationTaskCompleted(event: HiveEvent, payload: CoordinationTaskCompletedPayload): void {
  const task = resolveTaskByOriginChain(event, payload);
  if (!task) {
    syncLogger.warn('coordination_task_completed for unknown task', { task_id: payload.task_id, origin: event.origin_instance_id });
    return;
  }

  coordinationDal.updateTask(task.id, {
    status: payload.status,
    result: payload.result ?? undefined,
    error: payload.error ?? undefined,
  });

  broadcastToChannel(`coordination:${task.hive_id}`, {
    type: 'task_status_updated',
    data: {
      task_id: task.id,
      status: payload.status,
      completed_by: payload.completed_by,
      origin_instance_id: event.origin_instance_id,
    },
  });

  syncLogger.info('Materialized coordination_task_completed', { task_id: task.id, status: payload.status });
}

function materializeCoordinationMessage(event: HiveEvent, payload: CoordinationMessagePayload): void {
  // Idempotency: check if message already exists by origin tracking
  const existing = coordinationDal.findMessageByOrigin(event.origin_instance_id, payload.message_id);
  if (existing) return;

  const msg = coordinationDal.createMessage({
    hive_id: payload.hive_id ?? undefined,
    from_swarm_id: payload.from_swarm_id,
    to_swarm_id: payload.to_swarm_id ?? '',
    content_type: payload.content_type,
    content: typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content),
    reply_to: payload.reply_to ?? undefined,
    metadata: payload.metadata ?? undefined,
    origin_instance_id: event.origin_instance_id,
    origin_message_id: payload.message_id,
  });

  const channel = payload.hive_id
    ? `coordination:${payload.hive_id}`
    : `swarm:${payload.to_swarm_id}`;
  broadcastToChannel(channel, {
    type: 'swarm_message_received',
    data: {
      message_id: msg.id,
      from_swarm_id: payload.from_swarm_id,
      origin_instance_id: event.origin_instance_id,
    },
  });

  syncLogger.info('Materialized coordination_message', { message_id: msg.id, origin: event.origin_instance_id });
}

// ── Pending Queue Processing ────────────────────────────────────

/** Process pending events whose dependencies are now satisfied.
 *  GAP-12: Enforces a per-sync-group cap on pending events (maxPendingEvents).
 */
export function processPendingQueue(syncGroupId: string, hiveId: string, hiveName: string, localInstanceId: string, maxPendingEvents: number = 1000): number {
  const db = getDatabase();
  const repo = getMaterializerRepo();

  // GAP-12: Enforce pending queue cap before processing
  const pendingCount = countPendingEvents(syncGroupId);
  if (pendingCount > maxPendingEvents) {
    const trimmed = trimPendingEvents(syncGroupId, maxPendingEvents);
    if (trimmed > 0) {
      syncLogger.warn('Trimmed pending event queue (GAP-12 cap exceeded)', {
        sync_group_id: syncGroupId,
        trimmed,
        remaining: maxPendingEvents,
      });
    }
  }

  const pending = db.prepare(
    'SELECT * FROM hive_events_pending WHERE sync_group_id = ? ORDER BY received_at ASC'
  ).all(syncGroupId) as Array<{ id: string; event_json: string; depends_on: string }>;

  let processed = 0;

  for (const p of pending) {
    const deps = JSON.parse(p.depends_on) as string[];
    // Check if all dependencies are satisfied (posts/comments exist)
    const allSatisfied = deps.every(dep => {
      const post = repo.findPostByOriginOrId(dep);
      const comment = repo.findCommentByOriginOrId(dep);
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
