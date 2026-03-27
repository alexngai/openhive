/**
 * Messaging Service
 *
 * High-level service for swarm-to-swarm direct messaging.
 * Persists via DAL, delivers JSON-RPC notifications, and broadcasts WebSocket events.
 */

import { sendToSwarm } from '../map/sync-listener.js';
import { broadcastToChannel } from '../realtime/index.js';
import * as coordinationDal from '../db/dal/coordination.js';
import { createCoordinationNotification } from '../coordination/types.js';
import { onCoordinationMessage } from '../sync/coordination-hooks.js';
import type { SwarmMessage, CreateMessageInput } from './types.js';

export class MessagingService {
  sendMessage(input: CreateMessageInput): SwarmMessage {
    const msg = coordinationDal.createMessage(input);

    // Deliver JSON-RPC notification to the target swarm
    if (msg.to_swarm_id) {
      sendToSwarm(
        msg.to_swarm_id,
        createCoordinationNotification('x-openhive/message.send', {
          message_id: msg.id,
          from_swarm_id: msg.from_swarm_id,
          to_swarm_id: msg.to_swarm_id,
          hive_id: msg.hive_id ?? undefined,
          content_type: msg.content_type,
          content: msg.content,
          reply_to: msg.reply_to ?? undefined,
          metadata: msg.metadata ?? undefined,
        }),
      );
    }

    // Broadcast to local WebSocket channel
    const channel = msg.hive_id
      ? `coordination:${msg.hive_id}`
      : `swarm:${msg.to_swarm_id}`;
    broadcastToChannel(channel, {
      type: 'swarm_message_received',
      data: msg,
    });

    // Cross-instance sync hook
    onCoordinationMessage(msg);

    return msg;
  }

  getMessages(
    swarmId: string,
    opts?: { hive_id?: string; since?: string; limit?: number; offset?: number },
  ): { data: SwarmMessage[]; total: number } {
    return coordinationDal.listMessages({
      to_swarm_id: swarmId,
      hive_id: opts?.hive_id,
      since: opts?.since,
      limit: opts?.limit,
      offset: opts?.offset,
    });
  }

  markRead(messageId: string): void {
    coordinationDal.markMessageRead(messageId);
  }
}
