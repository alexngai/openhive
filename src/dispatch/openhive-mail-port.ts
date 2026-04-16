/**
 * OpenHive MessagePort — mail-based dispatch routing
 *
 * Composes swarm-dispatch's generic createMailPort with OpenHive's
 * MAP connection registry for reachability checks and agent-inbox
 * transport for message delivery.
 */

import { createMailPort } from 'swarm-dispatch/client';
import type { MessagePort } from 'swarm-dispatch';
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
  return createMailPort({
    send: (system, agentId, envelope) =>
      transport.sendToAgent(system, agentId, envelope),

    onMessage: (handler) =>
      transport.onMessage((from, msg) =>
        handler({ system: from.swarmId, agentId: from.agentId }, msg),
      ),

    isReachable: (system) => !!getInbound(system),
  });
}
