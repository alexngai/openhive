/**
 * useSessionChat — Orchestrates chat for a session's trajectory view.
 *
 * Resolves the session's source swarm → checks MAP capabilities → delegates
 * to useChatChannel for mode detection. Each MAP capability maps to a distinct
 * interaction mode:
 *
 *   protocols includes 'acp'               → ACP mode (full streaming, bi-directional)
 *   mail.canJoin || mail.canCreate          → Mail mode (async conversation turns)
 *   messaging.canReceive                    → Inject mode (send-only, agent processes it)
 *   none of the above / offline             → Unavailable (read-only)
 *
 * useChatChannel's detection cascade: ACP → custom adapters (mail) → inject → unavailable.
 * We control what's attempted by providing/omitting the SessionChatAdapter and swarm agent ID.
 */

import { useMemo } from 'react';
import { useChatChannel } from 'swarmcraft/ui/embed';
import type { ChatMode, ChatStatus, ChatChannelConfig } from 'swarmcraft/ui/embed';
import { agentIdFromSwarm } from '../../swarmcraft/constants.js';
import { createSessionChatAdapter } from '../adapters/session-chat-adapter.js';
import { useMapSwarm } from './useApi.js';

export interface UseSessionChatOptions {
  sessionId: string;
  sourceSwarmId?: string | null;
  enabled?: boolean;
}

export interface UseSessionChatReturn {
  chatMode: ChatMode;
  chatStatus: ChatStatus;
  chatEnabled: boolean;
  sendMessage: (text: string) => Promise<void>;
  cancelStream?: () => Promise<void>;
  /** Published capabilities from the swarm's MAP registration */
  capabilities: SwarmChatCapabilities;
}

export interface SwarmChatCapabilities {
  /** Swarm declares mail support (agent-inbox conversations) */
  mail: boolean;
  /** Swarm declares MAP messaging support (canSend/canReceive) */
  messaging: boolean;
  /** Swarm declares ACP protocol support */
  supportsAcp: boolean;
  /** Swarm is connected (online or unreachable) */
  connected: boolean;
  /** Raw protocols list from capabilities */
  protocols: string[];
}

/** Exported for testing. Resolves swarm capabilities from MAP data. */
export function resolveCapabilities(
  swarm: { status: string; capabilities: Record<string, unknown> | null } | undefined,
): SwarmChatCapabilities {
  if (!swarm) {
    return { mail: false, messaging: false, supportsAcp: false, connected: false, protocols: [] };
  }

  const caps = swarm.capabilities || {};
  const protocols = Array.isArray(caps.protocols) ? (caps.protocols as string[]) : [];
  const connected = swarm.status === 'online' || swarm.status === 'unreachable';

  // Check structured mail capabilities (MAP ParticipantCapabilities.mail)
  const mailCaps = caps.mail as Record<string, unknown> | undefined;
  const hasMail = !!mailCaps && (mailCaps.canJoin === true || mailCaps.canCreate === true);

  // Check structured messaging capabilities (MAP ParticipantCapabilities.messaging)
  const msgCaps = caps.messaging as Record<string, unknown> | boolean | undefined;
  const hasMessaging = msgCaps === true || (!!msgCaps && typeof msgCaps === 'object' && (
    (msgCaps as Record<string, unknown>).canReceive === true
  ));

  return {
    mail: hasMail,
    messaging: hasMessaging,
    supportsAcp: protocols.includes('acp'),
    connected,
    protocols,
  };
}

export function useSessionChat({
  sessionId,
  sourceSwarmId,
  enabled = true,
}: UseSessionChatOptions): UseSessionChatReturn {
  // Fetch swarm data to check published capabilities
  const { data: swarm } = useMapSwarm(sourceSwarmId ?? '');

  const capabilities = useMemo(
    () => resolveCapabilities(swarm),
    [swarm],
  );

  // Determine which modes to attempt based on published capabilities.
  //
  // Gate logic:
  //   connected + mail cap      → provide SessionChatAdapter (mail fallback)
  //   connected + messaging cap → pass agent ID (enables inject mode)
  //   connected + acp protocol  → pass agent ID (enables ACP, tried first)
  //   not connected / no caps   → unavailable
  const isConnected = enabled && !!sourceSwarmId && capabilities.connected;
  const hasAnyChatCap = capabilities.mail || capabilities.messaging || capabilities.supportsAcp;

  // Pass swarm agent ID when ANY chat capability exists (enables ACP and inject detection)
  const swarmAgentId = useMemo(
    () => (isConnected && hasAnyChatCap ? agentIdFromSwarm(sourceSwarmId!) : null),
    [sourceSwarmId, isConnected, hasAnyChatCap],
  );

  // Only provide the mail adapter when the swarm declares mail capabilities.
  // messaging-only swarms get inject mode (no conversation, just MAP scope messages).
  const channelConfig = useMemo((): ChatChannelConfig | undefined => {
    if (!isConnected || !capabilities.mail) return undefined;
    return {
      adapters: [createSessionChatAdapter({ sessionId })],
    };
  }, [sessionId, isConnected, capabilities.mail]);

  const channel = useChatChannel(swarmAgentId, channelConfig);

  return {
    chatMode: channel.mode,
    chatStatus: channel.status,
    chatEnabled: channel.mode !== 'unavailable' && (channel.status === 'ready' || channel.status === 'streaming'),
    sendMessage: channel.send,
    cancelStream: channel.cancel,
    capabilities,
  };
}
