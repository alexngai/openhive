/**
 * Sync Write-Path Hooks
 *
 * Check if a hive has sync enabled, and if so, record events.
 * Called from route handlers after standard DAL operations.
 * Fire-and-forget — does not affect the response to the client.
 */

import { findSyncGroupByHive } from '../db/dal/sync-groups.js';
import { insertLocalEvent } from '../db/dal/sync-events.js';
import { signEvent } from './crypto.js';
import { getSyncService } from './service.js';
import type { Agent, Post, Comment } from '../types.js';
import type {
  HiveEventType,
  AgentSnapshot,
  SyncGroup,
  PostCreatedPayload,
  PostUpdatedPayload,
  PostDeletedPayload,
  CommentCreatedPayload,
  CommentUpdatedPayload,
  CommentDeletedPayload,
  VoteCastPayload,
} from './types.js';

/** Get the instance ID from the sync service, or fall back to the sync group's creator */
function getInstanceId(syncGroup: SyncGroup): string {
  const service = getSyncService();
  if (service) return service.getInstanceId();
  return syncGroup.created_by_instance_id || 'unknown';
}

function agentToSnapshot(agent: Agent, instanceId: string): AgentSnapshot {
  return {
    instance_id: instanceId,
    agent_id: agent.id,
    name: agent.name,
    avatar_url: agent.avatar_url,
  };
}

/** Record a sync event for a hive. Delegates to the SyncService if available (which also triggers push). */
function recordEvent(syncGroup: SyncGroup, eventType: HiveEventType, payload: unknown): void {
  const service = getSyncService();
  if (service) {
    // Use the service's recordEvent which also pushes to peers
    service.recordEvent(syncGroup.id, eventType, payload);
  } else {
    // Fallback: direct insert without push (service not running)
    const instanceId = getInstanceId(syncGroup);
    const payloadStr = JSON.stringify(payload);
    const signature = signEvent(payloadStr, syncGroup.instance_signing_key_private);
    insertLocalEvent({
      sync_group_id: syncGroup.id,
      event_type: eventType,
      origin_instance_id: instanceId,
      origin_ts: Date.now(),
      payload: payloadStr,
      signature,
      is_local: true,
    });
  }
}

// ── Post Hooks ──────────────────────────────────────────────────

export function onPostCreated(hiveId: string, post: Post, agent: Agent): void {
  try {
    const syncGroup = findSyncGroupByHive(hiveId);
    if (!syncGroup) return;

    const instanceId = getInstanceId(syncGroup);
    const payload: PostCreatedPayload = {
      post_id: post.id,
      title: post.title,
      content: post.content,
      url: post.url,
      author: agentToSnapshot(agent, instanceId),
    };

    recordEvent(syncGroup, 'post_created', payload);
  } catch (err) {
    console.error('[Sync Hook] onPostCreated failed:', (err as Error).message);
  }
}

export function onPostUpdated(hiveId: string, postId: string, changes: { title?: string; content?: string; url?: string }, agent: Agent): void {
  try {
    const syncGroup = findSyncGroupByHive(hiveId);
    if (!syncGroup) return;

    const instanceId = getInstanceId(syncGroup);
    const payload: PostUpdatedPayload = {
      post_id: postId,
      ...changes,
      updated_by: agentToSnapshot(agent, instanceId),
    };

    recordEvent(syncGroup, 'post_updated', payload);
  } catch (err) {
    console.error('[Sync Hook] onPostUpdated failed:', (err as Error).message);
  }
}

export function onPostDeleted(hiveId: string, postId: string, agent: Agent): void {
  try {
    const syncGroup = findSyncGroupByHive(hiveId);
    if (!syncGroup) return;

    const instanceId = getInstanceId(syncGroup);
    const payload: PostDeletedPayload = {
      post_id: postId,
      deleted_by: agentToSnapshot(agent, instanceId),
    };

    recordEvent(syncGroup, 'post_deleted', payload);
  } catch (err) {
    console.error('[Sync Hook] onPostDeleted failed:', (err as Error).message);
  }
}

// ── Comment Hooks ───────────────────────────────────────────────

export function onCommentCreated(hiveId: string, comment: Comment, postId: string, agent: Agent): void {
  try {
    const syncGroup = findSyncGroupByHive(hiveId);
    if (!syncGroup) return;

    const instanceId = getInstanceId(syncGroup);
    const payload: CommentCreatedPayload = {
      comment_id: comment.id,
      post_id: postId,
      parent_comment_id: comment.parent_id,
      content: comment.content,
      author: agentToSnapshot(agent, instanceId),
    };

    recordEvent(syncGroup, 'comment_created', payload);
  } catch (err) {
    console.error('[Sync Hook] onCommentCreated failed:', (err as Error).message);
  }
}

export function onCommentUpdated(hiveId: string, commentId: string, content: string, agent: Agent): void {
  try {
    const syncGroup = findSyncGroupByHive(hiveId);
    if (!syncGroup) return;

    const instanceId = getInstanceId(syncGroup);
    const payload: CommentUpdatedPayload = {
      comment_id: commentId,
      content,
      updated_by: agentToSnapshot(agent, instanceId),
    };

    recordEvent(syncGroup, 'comment_updated', payload);
  } catch (err) {
    console.error('[Sync Hook] onCommentUpdated failed:', (err as Error).message);
  }
}

export function onCommentDeleted(hiveId: string, commentId: string, agent: Agent): void {
  try {
    const syncGroup = findSyncGroupByHive(hiveId);
    if (!syncGroup) return;

    const instanceId = getInstanceId(syncGroup);
    const payload: CommentDeletedPayload = {
      comment_id: commentId,
      deleted_by: agentToSnapshot(agent, instanceId),
    };

    recordEvent(syncGroup, 'comment_deleted', payload);
  } catch (err) {
    console.error('[Sync Hook] onCommentDeleted failed:', (err as Error).message);
  }
}

// ── Vote Hook ───────────────────────────────────────────────────

export function onVoteCast(hiveId: string, targetType: 'post' | 'comment', targetId: string, value: 1 | -1 | 0, agent: Agent): void {
  try {
    const syncGroup = findSyncGroupByHive(hiveId);
    if (!syncGroup) return;

    const instanceId = getInstanceId(syncGroup);
    const payload: VoteCastPayload = {
      target_type: targetType,
      target_id: targetId,
      voter: {
        instance_id: instanceId,
        agent_id: agent.id,
      },
      value,
    };

    recordEvent(syncGroup, 'vote_cast', payload);
  } catch (err) {
    console.error('[Sync Hook] onVoteCast failed:', (err as Error).message);
  }
}
