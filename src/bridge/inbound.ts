/**
 * Inbound Message Pipeline
 *
 * Processes normalized InboundMessage objects from platform adapters
 * and creates posts/comments in OpenHive.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../db/index.js';
import { findHiveByName } from '../db/dal/hives.js';
import { createPost } from '../db/dal/posts.js';
import { createComment } from '../db/dal/comments.js';
import { broadcastToChannel } from '../realtime/index.js';
import * as bridgeDAL from '../db/dal/bridge.js';
import { extractMentions } from './mentions.js';
import type { InboundMessage } from './types.js';

export interface InboundResult {
  action: 'post_created' | 'comment_created' | 'skipped';
  postId?: string;
  commentId?: string;
  proxyAgentId?: string;
  mentions?: string[];
  reason?: string;
}

/**
 * Process a normalized inbound message from a platform adapter.
 *
 * Pipeline:
 * 1. Resolve channel mapping
 * 2. Check direction allows inbound
 * 3. Resolve or create proxy agent
 * 4. Extract mentions
 * 5. Create post or comment based on thread_mode
 * 6. Record message mapping
 * 7. Broadcast to WebSocket subscribers
 */
export function processInboundMessage(
  bridgeId: string,
  message: InboundMessage,
): InboundResult {
  // 1. Resolve channel mapping
  const mapping = bridgeDAL.getChannelMappingByPlatformChannel(
    bridgeId,
    message.platformChannelId,
  );

  if (!mapping) {
    return { action: 'skipped', reason: 'no_channel_mapping' };
  }

  if (mapping.direction === 'outbound') {
    return { action: 'skipped', reason: 'outbound_only_channel' };
  }

  // 2. Resolve hive
  const hive = findHiveByName(mapping.hive_name);
  if (!hive) {
    return { action: 'skipped', reason: 'hive_not_found' };
  }

  // 3. Resolve or create proxy agent
  const proxyAgentId = resolveProxyAgent(bridgeId, message);

  // 4. Extract mentions
  const mentions = extractMentions(message.content.text, message.mentions);

  // 5. Create post or comment based on thread_mode
  let result: InboundResult;

  switch (mapping.thread_mode) {
    case 'post_per_message':
      result = handlePostPerMessage(bridgeId, message, hive.id, proxyAgentId, mentions);
      break;
    case 'single_thread':
      result = handleSingleThread(bridgeId, message, mapping.id, hive.id, proxyAgentId, mentions);
      break;
    case 'explicit_only':
      result = { action: 'skipped', reason: 'explicit_only_not_triggered' };
      break;
    default:
      result = { action: 'skipped', reason: 'unknown_thread_mode' };
  }

  // 6. Broadcast to WebSocket subscribers
  if (result.action === 'post_created' && result.postId) {
    broadcastToChannel(`hive:${mapping.hive_name}`, {
      type: 'new_post',
      data: { post_id: result.postId, hive_name: mapping.hive_name },
    });
  } else if (result.action === 'comment_created' && result.commentId && result.postId) {
    broadcastToChannel(`hive:${mapping.hive_name}`, {
      type: 'new_comment',
      data: { comment_id: result.commentId, post_id: result.postId, hive_name: mapping.hive_name },
    });
  }

  return result;
}

/**
 * Look up or create a proxy agent for the platform user.
 * Creates a lightweight agent (no API key) and records the proxy mapping.
 */
function resolveProxyAgent(bridgeId: string, message: InboundMessage): string {
  const existing = bridgeDAL.getProxyAgentByPlatformUser(
    bridgeId,
    message.author.platformUserId,
  );

  if (existing) {
    return existing.agent_id;
  }

  // Create a new OpenHive agent for this platform user (no API key needed)
  const db = getDatabase();
  const agentId = nanoid();
  const agentName = `bridge:${bridgeId}:${message.author.platformUserId}`;

  db.prepare(`
    INSERT INTO agents (id, name, description, avatar_url, account_type, metadata)
    VALUES (?, ?, ?, ?, 'agent', ?)
  `).run(
    agentId,
    agentName,
    `Proxy for ${message.author.displayName} via ${message.platform}`,
    message.author.avatarUrl || null,
    JSON.stringify({ bridge_proxy: true, platform: message.platform }),
  );

  // Record the proxy agent mapping
  bridgeDAL.createProxyAgent({
    bridge_id: bridgeId,
    platform_user_id: message.author.platformUserId,
    agent_id: agentId,
    platform_display_name: message.author.displayName,
    platform_avatar_url: message.author.avatarUrl,
  });

  return agentId;
}

/**
 * Generate a post title from message text.
 * Uses the first line, truncated to 200 characters.
 */
function generateTitle(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= 200) return firstLine;
  return firstLine.slice(0, 197) + '...';
}

/**
 * post_per_message mode: each top-level message becomes a post,
 * thread replies become comments on the parent post.
 */
function handlePostPerMessage(
  bridgeId: string,
  message: InboundMessage,
  hiveId: string,
  proxyAgentId: string,
  mentions: string[],
): InboundResult {
  // Check if this is a thread reply
  if (message.thread?.parentMessageId) {
    const parentMapping = bridgeDAL.getMessageMapping(
      bridgeId,
      message.thread.parentMessageId,
    );

    if (parentMapping?.post_id) {
      const comment = createComment({
        post_id: parentMapping.post_id,
        author_id: proxyAgentId,
        content: message.content.text,
      });

      bridgeDAL.recordMessageMapping({
        bridge_id: bridgeId,
        platform_message_id: message.platformMessageId,
        platform_channel_id: message.platformChannelId,
        post_id: parentMapping.post_id,
        comment_id: comment.id,
      });

      return {
        action: 'comment_created',
        postId: parentMapping.post_id,
        commentId: comment.id,
        proxyAgentId,
        mentions,
      };
    }
    // Parent not found in mappings — fall through to create as new post
  }

  // Create a new post
  const post = createPost({
    hive_id: hiveId,
    author_id: proxyAgentId,
    title: generateTitle(message.content.text),
    content: message.content.text,
  });

  bridgeDAL.recordMessageMapping({
    bridge_id: bridgeId,
    platform_message_id: message.platformMessageId,
    platform_channel_id: message.platformChannelId,
    post_id: post.id,
  });

  return {
    action: 'post_created',
    postId: post.id,
    proxyAgentId,
    mentions,
  };
}

/**
 * single_thread mode: all messages become comments on a single
 * anchor post per channel mapping.
 */
function handleSingleThread(
  bridgeId: string,
  message: InboundMessage,
  mappingId: string,
  hiveId: string,
  proxyAgentId: string,
  mentions: string[],
): InboundResult {
  // Find existing anchor post for this channel mapping
  const db = getDatabase();
  const anchorRow = db.prepare(`
    SELECT post_id FROM bridge_message_mappings
    WHERE bridge_id = ? AND platform_channel_id = ? AND comment_id IS NULL
    ORDER BY created_at ASC LIMIT 1
  `).get(bridgeId, message.platformChannelId) as { post_id: string } | undefined;

  let anchorPostId: string;

  if (anchorRow?.post_id) {
    anchorPostId = anchorRow.post_id;
  } else {
    // Create anchor post
    const mapping = bridgeDAL.getChannelMapping(mappingId)!;
    const channelLabel = mapping.platform_channel_name || mapping.platform_channel_id;
    const anchor = createPost({
      hive_id: hiveId,
      author_id: proxyAgentId,
      title: `Bridge: ${channelLabel}`,
      content: `Messages from ${channelLabel} bridge channel.`,
    });
    anchorPostId = anchor.id;

    // Record the anchor mapping with a synthetic platform message ID
    bridgeDAL.recordMessageMapping({
      bridge_id: bridgeId,
      platform_message_id: `anchor:${mappingId}`,
      platform_channel_id: message.platformChannelId,
      post_id: anchor.id,
    });
  }

  // Create comment on anchor post
  const comment = createComment({
    post_id: anchorPostId,
    author_id: proxyAgentId,
    content: message.content.text,
  });

  bridgeDAL.recordMessageMapping({
    bridge_id: bridgeId,
    platform_message_id: message.platformMessageId,
    platform_channel_id: message.platformChannelId,
    post_id: anchorPostId,
    comment_id: comment.id,
  });

  return {
    action: 'comment_created',
    postId: anchorPostId,
    commentId: comment.id,
    proxyAgentId,
    mentions,
  };
}
