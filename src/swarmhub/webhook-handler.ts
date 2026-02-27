/**
 * SwarmHub Webhook Handler
 *
 * Processes events forwarded from SwarmHub (Slack, and future integrations).
 * SwarmHub verifies signatures and routes events — this handler normalizes
 * them into the OpenHive bridge inbound pipeline.
 *
 * Flow:
 * 1. SwarmHub receives Slack event (webhook from Slack)
 * 2. SwarmHub verifies signature, looks up hive routing
 * 3. SwarmHub forwards to this hive at POST /api/v1/webhooks/swarmhub
 * 4. This handler normalizes the event into an InboundMessage
 * 5. Passes through processInboundMessage() in the bridge pipeline
 */

import { processInboundMessage, type InboundResult } from '../bridge/inbound.js';
import * as bridgeDAL from '../db/dal/bridge.js';
import type { InboundMessage } from '../bridge/types.js';
import type { ForwardedSlackEvent, SlackEventPayload } from './types.js';

// Track SwarmHub-managed bridge IDs per team
const managedBridgeIds = new Map<string, string>();

/**
 * Process a Slack event forwarded from SwarmHub.
 * Returns the inbound result, or null if the event was skipped.
 */
export function handleForwardedSlackEvent(event: ForwardedSlackEvent): InboundResult | null {
  const { team_id, event: slackEvent } = event;

  // Only process message events
  if (slackEvent.type !== 'message') {
    return null;
  }

  // Skip bot messages, subtypes (edits/deletes), and messages without user/text
  if (slackEvent.bot_id || (slackEvent.subtype && slackEvent.subtype !== 'file_share')) {
    return null;
  }
  if (!slackEvent.user || !slackEvent.text || !slackEvent.channel || !slackEvent.ts) {
    return null;
  }

  // Find or get the SwarmHub-managed bridge for this team
  const bridgeId = resolveManagedBridge(team_id);
  if (!bridgeId) {
    return null;
  }

  // Normalize to InboundMessage
  const message = normalizeSlackEvent(slackEvent);

  // Process through the standard bridge inbound pipeline
  return processInboundMessage(bridgeId, message);
}

/**
 * Look up the bridge config that handles SwarmHub-managed Slack events
 * for the given team_id. Creates a lightweight lookup cache.
 */
function resolveManagedBridge(teamId: string): string | null {
  // Check cache
  const cached = managedBridgeIds.get(teamId);
  if (cached) {
    // Verify bridge still exists
    const bridge = bridgeDAL.getBridge(cached);
    if (bridge) return cached;
    managedBridgeIds.delete(teamId);
  }

  // Look for a bridge named with our convention
  const bridgeName = `swarmhub:slack:${teamId}`;
  const bridge = bridgeDAL.getBridgeByName(bridgeName);
  if (bridge) {
    managedBridgeIds.set(teamId, bridge.id);
    return bridge.id;
  }

  return null;
}

/**
 * Normalize a Slack event payload into a bridge InboundMessage.
 */
function normalizeSlackEvent(event: SlackEventPayload): InboundMessage {
  const message: InboundMessage = {
    platformMessageId: event.ts!,
    platform: 'slack',
    platformChannelId: event.channel!,
    author: {
      platformUserId: event.user!,
      displayName: event.user!, // Will be resolved by proxy agent system
    },
    content: {
      text: event.text!,
      attachments: event.files?.map(f => ({
        type: 'file' as const,
        url: f.url_private,
        name: f.name,
        mimeType: f.mimetype,
      })),
    },
    timestamp: new Date(parseFloat(event.ts!) * 1000).toISOString(),
    platformMeta: {
      ts: event.ts,
      thread_ts: event.thread_ts,
      channel: event.channel,
    },
  };

  // Thread reply
  if (event.thread_ts && event.thread_ts !== event.ts) {
    message.thread = {
      parentMessageId: event.thread_ts,
    };
  }

  return message;
}

/**
 * Clear the managed bridge cache (for testing or reconnect).
 */
export function clearManagedBridgeCache(): void {
  managedBridgeIds.clear();
}
