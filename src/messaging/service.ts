/**
 * Messaging Service
 *
 * High-level service for swarm-to-swarm direct messaging.
 * Persists via DAL and broadcasts WebSocket events.
 *
 * Message delivery to swarm agents uses agent-inbox (not MAP notifications).
 * The hub persists the message and broadcasts to local UI; actual delivery
 * to agents happens through agent-inbox's routing layer.
 */

import { broadcastToChannel } from '../realtime/index.js';
import * as coordinationDal from '../db/dal/coordination.js';
import { onCoordinationMessage } from '../sync/coordination-hooks.js';
import type { SwarmMessage, CreateMessageInput } from './types.js';

export class MessagingService {
  sendMessage(input: CreateMessageInput): SwarmMessage {
    const msg = coordinationDal.createMessage(input);

    // Broadcast to local WebSocket channel (UI subscribers)
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
