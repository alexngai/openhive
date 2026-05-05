/**
 * Dispatch Mail Transport — cascade: agent-inbox → MAP scope
 *
 * Satisfies the `MailTransport` interface expected by
 * `createOpenHiveMailPort`. The send path picks a route per message based on
 * the target agent's declared capabilities:
 *
 *   1. `mail.canJoin` present → agent-inbox mail pipeline. A long-lived
 *      conversation per `(swarm, agent)` pair is created lazily with
 *      `metadata.source = 'swarm-dispatch'` so replies can be demuxed.
 *      The envelope is stored as the turn content (JSON).
 *   2. `messaging.canReceive` present → MAP JSON-RPC notification
 *      `x-dispatch/message` sent via `sendToSwarm` (the canonical method
 *      name; method/schema constants live in swarm-dispatch's
 *      `client/methods.ts`). The sidecar is expected to forward to the
 *      named agent and reply on the dispatch's mail conversation.
 *   3. Neither → `{ delivered: false, reason: 'recipient_unreachable' }`.
 *
 * The receive path fans inbound mail turns (matching our conversation
 * metadata) and MAP replies (from mail-ingress.ts) into the port's handler.
 */
import type { EventEmitter } from 'node:events';
import type { MailJsonRpcServer, Storage } from 'agent-inbox';
import {
  X_DISPATCH_METHODS,
  LEGACY_MAP_DISPATCH_MESSAGE_METHOD,
} from 'swarm-dispatch/client';
import type { MailTransport } from './openhive-mail-port.js';
import { hasAgentCapability, getAgentOnSwarm } from '../map/connection-registry.js';
import { subscribeDispatchMapReply } from './mail-ingress.js';

export const DISPATCHER_PARTICIPANT_ID = 'openhive:dispatcher';
export const DISPATCH_CONVERSATION_SCOPE = 'swarm-dispatch';

/**
 * Canonical method name for dispatch envelopes routed via MAP scope.
 * Re-exported from swarm-dispatch's protocol-constants module so callers
 * importing from this file see the same string the orchestrator uses.
 */
export const DISPATCH_MAP_MESSAGE_METHOD: typeof X_DISPATCH_METHODS.MESSAGE =
  X_DISPATCH_METHODS.MESSAGE;

/**
 * @deprecated — old method name, kept exported for one release window so
 * external callers (tests, downstream consumers) can identify the legacy
 * alias. Use `DISPATCH_MAP_MESSAGE_METHOD` (or
 * `X_DISPATCH_METHODS.MESSAGE` from swarm-dispatch directly) instead.
 */
export const DISPATCH_MAP_MESSAGE_METHOD_LEGACY: typeof LEGACY_MAP_DISPATCH_MESSAGE_METHOD =
  LEGACY_MAP_DISPATCH_MESSAGE_METHOD;

type DispatchEnvelope = { type: string; body: Record<string, unknown> };

export interface MailTransportDeps {
  getMailJsonRpc: () => MailJsonRpcServer;
  getMailStorage: () => Storage;
  getMailEvents: () => EventEmitter;
  sendToSwarm: (swarmId: string, message: object) => boolean;
}

function conversationKey(swarmId: string, agentId: string): string {
  return `${swarmId}::${agentId}`;
}

async function invokeMailMethod(
  jsonRpc: MailJsonRpcServer,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const id = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await jsonRpc.handleRequest({
    jsonrpc: '2.0',
    id,
    method,
    params,
  } as Parameters<MailJsonRpcServer['handleRequest']>[0]);
  if (response && typeof response === 'object' && 'error' in response && response.error) {
    const err = response.error as { message?: string; code?: number };
    throw new Error(err.message ?? `mail method ${method} failed (code ${err.code ?? -32000})`);
  }
  return (response as { result?: unknown })?.result;
}

export function createOpenHiveMailTransport(deps: MailTransportDeps): MailTransport {
  const conversationCache = new Map<string, string>();
  const inFlightCreations = new Map<string, Promise<string>>();
  const incomingHandlers = new Set<
    (from: { swarmId: string; agentId: string }, message: Record<string, unknown>) => void
  >();

  async function ensureConversation(swarmId: string, agentId: string): Promise<string> {
    const key = conversationKey(swarmId, agentId);
    const cached = conversationCache.get(key);
    if (cached) return cached;

    const pending = inFlightCreations.get(key);
    if (pending) return pending;

    const creation = (async () => {
      const result = (await invokeMailMethod(deps.getMailJsonRpc(), 'mail/create', {
        scope: DISPATCH_CONVERSATION_SCOPE,
        subject: `Dispatch channel: ${agentId} on ${swarmId}`,
        metadata: {
          source: DISPATCH_CONVERSATION_SCOPE,
          swarm_id: swarmId,
          agent_id: agentId,
        },
      })) as { id: string };
      conversationCache.set(key, result.id);
      return result.id;
    })();

    inFlightCreations.set(key, creation);
    try {
      return await creation;
    } finally {
      inFlightCreations.delete(key);
    }
  }

  function demuxMailTurn(turn: {
    conversation_id: string;
    participant_id: string;
    content: unknown;
  }): void {
    if (turn.participant_id === DISPATCHER_PARTICIPANT_ID) return;

    const conv = deps.getMailStorage().getConversation(turn.conversation_id);
    const meta = conv?.metadata as Record<string, unknown> | undefined;
    if (!meta || meta.source !== DISPATCH_CONVERSATION_SCOPE) return;

    const swarmId = typeof meta.swarm_id === 'string' ? meta.swarm_id : null;
    const agentId = typeof meta.agent_id === 'string' ? meta.agent_id : null;
    if (!swarmId || !agentId) return;

    // Dispatch conversations are strictly 1:1 (dispatcher ↔ target agent).
    // Drop turns from any other participant so swarm-dispatch never receives
    // replies misattributed to a third party who happened to join.
    if (turn.participant_id !== agentId) return;

    let envelope: Record<string, unknown>;
    try {
      envelope =
        typeof turn.content === 'string'
          ? (JSON.parse(turn.content) as Record<string, unknown>)
          : (turn.content as Record<string, unknown>);
    } catch {
      return;
    }
    if (!envelope || typeof envelope !== 'object') return;

    for (const handler of incomingHandlers) {
      handler({ swarmId, agentId }, envelope);
    }
  }

  const onTurn = (turn: unknown): void => {
    if (!turn || typeof turn !== 'object') return;
    demuxMailTurn(turn as Parameters<typeof demuxMailTurn>[0]);
  };
  deps.getMailEvents().on('mail.turn.added', onTurn);

  const unsubscribeMapReply = subscribeDispatchMapReply(({ swarmId, fromAgentId, message }) => {
    for (const handler of incomingHandlers) {
      handler({ swarmId, agentId: fromAgentId }, message);
    }
  });

  async function sendViaMail(
    swarmId: string,
    agentId: string,
    envelope: DispatchEnvelope,
  ): Promise<{ delivered: boolean; reason?: string }> {
    try {
      const conversationId = await ensureConversation(swarmId, agentId);
      await invokeMailMethod(deps.getMailJsonRpc(), 'mail/turn', {
        conversationId,
        participantId: DISPATCHER_PARTICIPANT_ID,
        contentType: 'application/json',
        content: JSON.stringify(envelope),
      });
      return { delivered: true };
    } catch (err) {
      return { delivered: false, reason: (err as Error).message || 'mail_send_failed' };
    }
  }

  function sendViaMapScope(
    swarmId: string,
    agentId: string,
    envelope: DispatchEnvelope,
  ): { delivered: boolean; reason?: string } {
    const sent = deps.sendToSwarm(swarmId, {
      jsonrpc: '2.0',
      method: DISPATCH_MAP_MESSAGE_METHOD,
      params: {
        to_agent_id: agentId,
        envelope,
      },
    });
    return sent
      ? { delivered: true }
      : { delivered: false, reason: 'recipient_unreachable' };
  }

  return {
    async sendToAgent(swarmId, agentId, envelope) {
      if (!getAgentOnSwarm(swarmId, agentId)) {
        return { delivered: false, reason: 'recipient_unreachable' };
      }

      if (hasAgentCapability(swarmId, agentId, 'mail.canJoin')) {
        const result = await sendViaMail(swarmId, agentId, envelope);
        if (result.delivered) return result;
        // Fall through to MAP scope on mail failure, if eligible.
      }

      if (hasAgentCapability(swarmId, agentId, 'messaging.canReceive')) {
        // Ensure a per-(swarm, agent) conversation exists and inject its
        // id into the envelope body so the swarm-side `x-dispatch/message`
        // handler can surface it as `_conversationId` on the inbox event.
        // Without this, the mail-inbound-reuse-consumer has no
        // conversation to post the agent's reply turn to.
        let envelopeWithConv = envelope;
        try {
          const conversationId = await ensureConversation(swarmId, agentId);
          envelopeWithConv = {
            ...envelope,
            body: {
              ...envelope.body,
              _conversationId: conversationId,
            },
          };
        } catch {
          // Best-effort: if conversation creation fails, fall through to
          // sending without — the dispatch's reply path will be lost
          // but the prompt itself still flows.
        }
        return sendViaMapScope(swarmId, agentId, envelopeWithConv);
      }

      return { delivered: false, reason: 'no_mail_transport' };
    },

    onMessage(handler) {
      incomingHandlers.add(handler);
      return () => {
        incomingHandlers.delete(handler);
      };
    },

    destroy() {
      deps.getMailEvents().off('mail.turn.added', onTurn);
      unsubscribeMapReply();
      incomingHandlers.clear();
      conversationCache.clear();
      inFlightCreations.clear();
    },
  };
}
