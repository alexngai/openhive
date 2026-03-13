/**
 * Hive Extension Methods (x-hive/*)
 *
 * Handles x-hive/post, x-hive/comment, x-hive/feed, x-hive/vote via the MAP
 * WebSocket. Delegates to existing DAL functions and broadcasts events to both
 * the realtime channel layer and MAP subscription system.
 */

import { WebSocket } from 'ws';
import { findSwarmById, getSwarmHives } from '../db/dal/map.js';
import { findHiveByName, findHiveById } from '../db/dal/hives.js';
import { createPost, listPosts, findPostById } from '../db/dal/posts.js';
import { createComment, findCommentById } from '../db/dal/comments.js';
import { castVote } from '../db/dal/votes.js';
import { broadcastToChannel } from '../realtime/index.js';
import { notifySubscribers } from './event-subscriptions.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendResult(ws: WebSocket, id: string | number | null | undefined, result: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }));
  }
}

function sendError(ws: WebSocket, code: number, message: string, id?: string | number | null): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }));
  }
}

function resolveAuthor(swarmId: string): string | null {
  const swarm = findSwarmById(swarmId);
  return swarm?.owner_agent_id ?? null;
}

function checkHiveMembership(swarmId: string, hiveId: string): boolean {
  const hives = getSwarmHives(swarmId);
  return hives.some(h => h.hive_id === hiveId);
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

export async function handleXHiveMethod(
  ws: WebSocket,
  msg: { id?: string | number | null; method: string; params?: Record<string, unknown> },
  sourceSwarmId: string,
): Promise<void> {
  const method = msg.method;

  try {
    switch (method) {
      case 'x-hive/post':
        return handlePost(ws, msg, sourceSwarmId);
      case 'x-hive/comment':
        return handleComment(ws, msg, sourceSwarmId);
      case 'x-hive/feed':
        return handleFeed(ws, msg, sourceSwarmId);
      case 'x-hive/vote':
        return handleVote(ws, msg, sourceSwarmId);
      default:
        sendError(ws, -32601, `Unknown extension method: ${method}`, msg.id);
    }
  } catch (err) {
    sendError(ws, -32603, `Extension error: ${err instanceof Error ? err.message : err}`, msg.id);
  }
}

// ─── x-hive/post ─────────────────────────────────────────────────────────────

function handlePost(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  sourceSwarmId: string,
): void {
  const hiveName = msg.params?.hive as string | undefined;
  const title = msg.params?.title as string | undefined;

  if (!hiveName || !title) {
    sendError(ws, -32602, 'x-hive/post requires hive and title', msg.id);
    return;
  }

  const hive = findHiveByName(hiveName);
  if (!hive) {
    sendError(ws, -32001, `Hive not found: ${hiveName}`, msg.id);
    return;
  }

  if (!checkHiveMembership(sourceSwarmId, hive.id)) {
    sendError(ws, -32002, `Swarm is not a member of hive: ${hiveName}`, msg.id);
    return;
  }

  const authorId = resolveAuthor(sourceSwarmId);
  if (!authorId) {
    sendError(ws, -32603, 'Could not resolve author for swarm', msg.id);
    return;
  }

  const post = createPost({
    hive_id: hive.id,
    author_id: authorId,
    title,
    content: msg.params?.content as string | undefined,
    url: msg.params?.url as string | undefined,
  });

  broadcastToChannel(`hive:${hiveName}`, { type: 'new_post', data: post });
  notifySubscribers('x-hive.post.created', { post }, { hive: hiveName });

  sendResult(ws, msg.id, { post });
}

// ─── x-hive/comment ──────────────────────────────────────────────────────────

function handleComment(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  sourceSwarmId: string,
): void {
  const postId = msg.params?.post_id as string | undefined;
  const content = msg.params?.content as string | undefined;

  if (!postId || !content) {
    sendError(ws, -32602, 'x-hive/comment requires post_id and content', msg.id);
    return;
  }

  const post = findPostById(postId);
  if (!post) {
    sendError(ws, -32001, `Post not found: ${postId}`, msg.id);
    return;
  }

  if (!checkHiveMembership(sourceSwarmId, post.hive_id)) {
    const hive = findHiveById(post.hive_id);
    sendError(ws, -32002, `Swarm is not a member of hive: ${hive?.name ?? post.hive_id}`, msg.id);
    return;
  }

  const authorId = resolveAuthor(sourceSwarmId);
  if (!authorId) {
    sendError(ws, -32603, 'Could not resolve author for swarm', msg.id);
    return;
  }

  const comment = createComment({
    post_id: postId,
    author_id: authorId,
    content,
    parent_id: msg.params?.parent_id as string | undefined,
  });

  const hive = findHiveById(post.hive_id);
  const hiveName = hive?.name ?? post.hive_id;
  broadcastToChannel(`hive:${hiveName}`, { type: 'new_comment', data: comment });
  notifySubscribers('x-hive.comment.added', { comment, postId }, { hive: hiveName });

  sendResult(ws, msg.id, { comment });
}

// ─── x-hive/feed ─────────────────────────────────────────────────────────────

function handleFeed(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  sourceSwarmId: string,
): void {
  const hiveName = msg.params?.hive as string | undefined;

  if (!hiveName) {
    sendError(ws, -32602, 'x-hive/feed requires hive', msg.id);
    return;
  }

  const hive = findHiveByName(hiveName);
  if (!hive) {
    sendError(ws, -32001, `Hive not found: ${hiveName}`, msg.id);
    return;
  }

  if (!checkHiveMembership(sourceSwarmId, hive.id)) {
    sendError(ws, -32002, `Swarm is not a member of hive: ${hiveName}`, msg.id);
    return;
  }

  const sort = (msg.params?.sort as 'new' | 'top' | 'hot') ?? 'new';
  const limit = (msg.params?.limit as number) ?? 20;

  const posts = listPosts({ hive_id: hive.id, sort, limit });
  sendResult(ws, msg.id, { posts });
}

// ─── x-hive/vote ─────────────────────────────────────────────────────────────

function handleVote(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  sourceSwarmId: string,
): void {
  const targetType = msg.params?.target_type as 'post' | 'comment' | undefined;
  const targetId = msg.params?.target_id as string | undefined;
  const value = msg.params?.value as number | undefined;

  if (!targetType || !targetId || (value !== 1 && value !== -1)) {
    sendError(ws, -32602, 'x-hive/vote requires target_type, target_id, and value (1 or -1)', msg.id);
    return;
  }

  // Resolve target → hive for membership check
  let hiveId: string;
  if (targetType === 'post') {
    const post = findPostById(targetId);
    if (!post) {
      sendError(ws, -32001, `Post not found: ${targetId}`, msg.id);
      return;
    }
    hiveId = post.hive_id;
  } else {
    // comment — need to resolve post first
    const comment = findCommentById(targetId);
    if (!comment) {
      sendError(ws, -32001, `Comment not found: ${targetId}`, msg.id);
      return;
    }
    const post = findPostById(comment.post_id);
    if (!post) {
      sendError(ws, -32001, `Post not found for comment: ${targetId}`, msg.id);
      return;
    }
    hiveId = post.hive_id;
  }

  if (!checkHiveMembership(sourceSwarmId, hiveId)) {
    sendError(ws, -32002, 'Swarm is not a member of the target hive', msg.id);
    return;
  }

  const agentId = resolveAuthor(sourceSwarmId);
  if (!agentId) {
    sendError(ws, -32603, 'Could not resolve voter agent for swarm', msg.id);
    return;
  }

  const result = castVote({ agent_id: agentId, target_type: targetType, target_id: targetId, value: value as 1 | -1 });

  const hive = findHiveById(hiveId);
  const hiveName = hive?.name ?? hiveId;
  broadcastToChannel(`hive:${hiveName}`, { type: 'vote_update', data: { ...result, target_type: targetType, target_id: targetId } });
  notifySubscribers('x-hive.vote.cast', { vote: result, target_type: targetType, target_id: targetId }, { hive: hiveName });

  sendResult(ws, msg.id, result);
}
