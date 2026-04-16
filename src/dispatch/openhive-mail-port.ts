/**
 * OpenHive MessagePort — mail-based dispatch routing
 *
 * Bridges swarm-dispatch's MessagePort to OpenHive's agent-inbox / mail system.
 * Sends x-dispatch/work messages to already-running agents for routed dispatch;
 * receives results via x-dispatch/result messages.
 */

import type {
  MessagePort,
  IncomingWork,
  DeliveryReceipt,
  CancelAck,
  ResultEnvelope,
  AgentRef,
} from 'swarm-dispatch';
import { getInbound } from '../map/connection-registry.js';

export interface MailTransport {
  sendToAgent(
    swarmId: string,
    agentId: string,
    message: { type: string; body: Record<string, unknown> },
  ): Promise<{ delivered: boolean; reason?: string }>;
  onMessage(
    handler: (from: { swarmId: string; agentId: string }, message: Record<string, unknown>) => void,
  ): () => void;
}

export function createOpenHiveMailPort(transport: MailTransport): MessagePort {
  const incomingHandlers: Array<(msg: IncomingWork) => void> = [];

  const unsubscribe = transport.onMessage((from, message) => {
    if (message.type !== 'x-dispatch/work') return;
    const task = message.task as IncomingWork['task'];
    if (!task?.id) return;

    const incoming: IncomingWork = {
      messageId: (message.messageId as string) ?? `${from.swarmId}:${task.id}:${Date.now()}`,
      correlationId: (message.correlationId as string) ?? task.id,
      replyTo: { agentId: from.agentId, system: from.swarmId },
      task,
    };

    for (const handler of incomingHandlers) {
      handler(incoming);
    }
  });

  return {
    onIncoming(handler) {
      incomingHandlers.push(handler);
      return () => {
        const idx = incomingHandlers.indexOf(handler);
        if (idx >= 0) incomingHandlers.splice(idx, 1);
        if (incomingHandlers.length === 0) unsubscribe();
      };
    },

    async deliver(to: AgentRef, payload): Promise<DeliveryReceipt> {
      const swarmId = to.system;
      if (!swarmId) {
        return { delivered: false, reason: 'recipient_unreachable' };
      }

      const conn = getInbound(swarmId);
      if (!conn) {
        return { delivered: false, reason: 'recipient_unreachable' };
      }

      const result = await transport.sendToAgent(swarmId, to.agentId, {
        type: 'x-dispatch/work',
        body: {
          prompt: payload.prompt,
          taskId: payload.taskId,
          role: payload.role,
        },
      });

      return {
        delivered: result.delivered,
        reason: result.reason,
      };
    },

    async cancel(to: AgentRef, correlationId: string, reason: string): Promise<CancelAck> {
      const swarmId = to.system;
      if (!swarmId) return { acked: false, reason: 'no system' };

      const result = await transport.sendToAgent(swarmId, to.agentId, {
        type: 'x-dispatch/cancel',
        body: { correlationId, reason },
      });

      return { acked: result.delivered, reason: result.reason };
    },

    dedupeKey(msg: IncomingWork): string | null {
      return msg.messageId ?? null;
    },

    async deliverResult(to: AgentRef, envelope: ResultEnvelope): Promise<DeliveryReceipt> {
      const swarmId = to.system;
      if (!swarmId) return { delivered: false, reason: 'no system' };

      const result = await transport.sendToAgent(swarmId, to.agentId, {
        type: 'x-dispatch/result',
        body: envelope as unknown as Record<string, unknown>,
      });

      return { delivered: result.delivered, reason: result.reason };
    },
  };
}
