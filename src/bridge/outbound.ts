/**
 * Outbound Message Pipeline
 *
 * Processes OpenHive post/comment events and determines if/how they
 * should be relayed to external platforms via bridge adapters.
 */

import * as bridgeDAL from '../db/dal/bridge.js';
import type {
  BridgeConfig,
  ChannelMapping,
  OutboundMessage,
  PlatformDestination,
} from './types.js';

export interface HiveEvent {
  type: 'new_post' | 'new_comment';
  postId: string;
  commentId?: string;
  authorId: string;
  authorName: string;
  hiveName: string;
  title?: string;
  content: string;
}

export interface OutboundAction {
  destination: PlatformDestination;
  message: OutboundMessage;
}

/**
 * Process a hive event and determine if/how it should be relayed
 * to the platform. Returns an array of outbound actions (one per
 * matching channel mapping).
 *
 * Filters:
 * 1. Skip if author is a proxy agent for this bridge (echo prevention)
 * 2. Skip inbound-only channel mappings
 * 3. For comments, resolve thread context from message mappings
 */
export function processOutboundEvent(
  bridgeConfig: BridgeConfig,
  mappings: ChannelMapping[],
  event: HiveEvent,
): OutboundAction[] {
  const actions: OutboundAction[] = [];

  // Echo prevention: skip if author is a proxy agent for this bridge
  if (bridgeDAL.isProxyAgentForBridge(bridgeConfig.id, event.authorId)) {
    return actions;
  }

  // Find channel mappings for this hive
  const hiveMappings = mappings.filter(m => m.hive_name === event.hiveName);

  for (const mapping of hiveMappings) {
    // Skip inbound-only channels
    if (mapping.direction === 'inbound') {
      continue;
    }

    const destination: PlatformDestination = {
      platformChannelId: mapping.platform_channel_id,
    };

    // For comments, find the parent post's platform message ID for threading
    if (event.type === 'new_comment' && event.postId) {
      const postMapping = bridgeDAL.getMessageMappingByPost(
        bridgeConfig.id,
        event.postId,
      );
      if (postMapping) {
        destination.threadId = postMapping.platform_message_id;
      }
    }

    const message = formatOutboundMessage(event);
    actions.push({ destination, message });
  }

  return actions;
}

/**
 * Format an OpenHive event as an outbound message.
 * Prefixes the author name for attribution.
 */
function formatOutboundMessage(event: HiveEvent): OutboundMessage {
  let text: string;

  if (event.type === 'new_post') {
    if (event.title && event.content && event.title !== event.content) {
      text = `**${event.authorName}**: *${event.title}*\n${event.content}`;
    } else {
      text = `**${event.authorName}**: ${event.content || event.title || ''}`;
    }
  } else {
    text = `**${event.authorName}**: ${event.content}`;
  }

  return { text };
}
