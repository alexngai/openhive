/**
 * OpenHive capability resolvers for ChatChannel.
 *
 * Each resolver is a React hook that reads reactive data sources (swarm
 * records, conversation participants, agent lists) and produces a stable
 * CapabilityResolver function compatible with useChatChannel.
 */

import { useCallback } from 'react';
import type {
  CapabilityResolver,
  ChatCapabilities,
  ChatTarget,
  ConversationTarget,
  SessionTarget,
} from 'swarmcraft/ui/embed';
import { useMapSwarm, useMailConversation } from '../../hooks/useApi';

// ---------------------------------------------------------------------------
// Session capability resolver
// ---------------------------------------------------------------------------

interface RegisteredAgent {
  id: string;
  name?: string;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function extractAcpTarget(registeredAgents: RegisteredAgent[] | undefined): string | undefined {
  if (!registeredAgents) return undefined;
  const acpAgent = registeredAgents.find((a) => {
    const protos = a.capabilities?.protocols;
    return Array.isArray(protos) && (protos as string[]).includes('acp');
  });
  if (!acpAgent) return undefined;
  const peerMapId = acpAgent.metadata?.peerMapId;
  return (typeof peerMapId === 'string' && peerMapId) ? peerMapId : acpAgent.id;
}

/**
 * Hook returning a CapabilityResolver for a session target.
 *
 * The resolver reads the session's source swarm via useMapSwarm and surfaces
 * aggregate capabilities plus per-agent ACP routing info (peerMapId).
 */
export function useSessionCapabilityResolver(swarmId: string | undefined): CapabilityResolver {
  const { data: swarm } = useMapSwarm(swarmId ?? '');

  return useCallback(
    (target: ChatTarget): ChatCapabilities | undefined => {
      if (target.kind !== 'session') return undefined;
      if (target.swarmId !== swarmId) return undefined;
      if (!swarm) return { available: false, connected: false };

      const connected = swarm.status === 'online' || swarm.status === 'unreachable';
      const caps = swarm.capabilities ?? {};
      const protocols = Array.isArray((caps as { protocols?: string[] }).protocols)
        ? ((caps as { protocols: string[] }).protocols)
        : [];

      const mailCaps = (caps as { mail?: { canCreate?: boolean; canJoin?: boolean } }).mail;
      const messagingCaps = (caps as { messaging?: boolean | { canReceive?: boolean } }).messaging;
      const canReceive = typeof messagingCaps === 'boolean'
        ? messagingCaps
        : messagingCaps?.canReceive === true;

      const registeredAgents = (swarm as unknown as { registered_agents?: RegisteredAgent[] })
        .registered_agents;
      const acpTargetId = extractAcpTarget(registeredAgents);

      const projectPath = (caps as { projectPath?: string }).projectPath
        ?? (swarm.metadata as { projectPath?: string } | null | undefined)?.projectPath;

      const result: ChatCapabilities = {
        available: connected && (!!mailCaps || !!canReceive || (protocols.includes('acp') && !!acpTargetId)),
        connected,
      };

      if (protocols.includes('acp') && acpTargetId) {
        result.acp = { targetAgentId: acpTargetId, cwd: projectPath };
      }
      if (mailCaps) {
        result.mail = {
          canCreate: mailCaps.canCreate === true,
          canJoin: mailCaps.canJoin === true,
        };
      }
      if (canReceive) {
        result.inject = { canReceive: true };
      }

      return result;
    },
    [swarmId, swarm],
  );
}

// ---------------------------------------------------------------------------
// Conversation capability resolver
// ---------------------------------------------------------------------------

/**
 * Mail-only resolver for multi-participant conversations.
 *
 * ACP requires a single ACP-capable participant — if target.addressee is set
 * and that agent publishes ACP, we could in principle route there, but that
 * requires looking up each participant's MAP registration, which we don't do
 * here. Current behavior: mail-only, with availability gated on conversation
 * existence.
 */
export function useConversationCapabilityResolver(conversationId: string | undefined): CapabilityResolver {
  const { data } = useMailConversation(conversationId ?? '');

  return useCallback(
    (target: ChatTarget): ChatCapabilities | undefined => {
      if (target.kind !== 'conversation') return undefined;
      if (target.conversationId !== conversationId) return undefined;
      if (!data?.conversation) return { available: false, connected: false };

      const active = data.conversation.status === 'active';
      return {
        available: active,
        connected: active,
        mail: { canCreate: false, canJoin: true },
      };
    },
    [conversationId, data?.conversation],
  );
}

// ---------------------------------------------------------------------------
// Convenience: target constructors
// ---------------------------------------------------------------------------

export function sessionTarget(
  sessionId: string,
  swarmId: string,
  resume?: SessionTarget['resume'],
): SessionTarget {
  return { kind: 'session', sessionId, swarmId, resume };
}

export function conversationTarget(
  conversationId: string,
  addressee?: string,
): ConversationTarget {
  return { kind: 'conversation', conversationId, addressee };
}
