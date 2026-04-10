/**
 * useSessionChat — Orchestrates chat for a session's trajectory view.
 *
 * Resolves the session's source swarm → checks MAP capabilities → determines
 * chat mode. Handles both ACP streaming and mail-based chat:
 *
 *   protocols includes 'acp'               → ACP mode (streaming via SwarmCraft REST)
 *   mail.canJoin || mail.canCreate          → Mail mode (async conversation turns)
 *   messaging.canReceive                    → Inject mode (send-only)
 *   none of the above / offline             → Unavailable (read-only)
 */

import { useMemo, useCallback, useEffect, useRef } from 'react';
import type { ChatMode, ChatStatus } from 'swarmcraft/ui/embed';
import { useMapSwarm } from './useApi.js';
import { useAcpStream } from './useAcpStream.js';
import { api } from '../lib/api.js';

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
  /** Streaming events from ACP in SessionEvent format (empty for mail mode) */
  streamingEvents: import('../lib/api').SessionEvent[];
  /** ACP stream error message (null when no error) */
  streamError: string | null;
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
  // Fetch swarm data to check published capabilities.
  const { data: swarm } = useMapSwarm(sourceSwarmId ?? '');

  // Resolve capabilities with stable deps.
  const swarmStatus = swarm?.status;
  const swarmCaps = swarm?.capabilities;
  const capabilities = useMemo(
    () => resolveCapabilities(swarm),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [swarmStatus, swarmCaps],
  );

  const isConnected = enabled && !!sourceSwarmId && capabilities.connected;
  const hasMail = capabilities.mail;
  const hasAnyChatCap = hasMail || capabilities.messaging || capabilities.supportsAcp;

  // Determine chat mode from capabilities
  const chatMode: ChatMode = useMemo(() => {
    if (!isConnected || !hasAnyChatCap) return 'unavailable';
    if (capabilities.supportsAcp) return 'acp';
    if (hasMail) return 'mail';
    if (capabilities.messaging) return 'inject';
    return 'unavailable';
  }, [isConnected, hasAnyChatCap, capabilities.supportsAcp, hasMail, capabilities.messaging]);

  // Resolve CWD from swarm metadata (set during agent registration)
  const projectPath = (swarmCaps as any)?.projectPath as string | undefined
    ?? (swarm?.metadata as any)?.projectPath as string | undefined;

  // ACP streaming (only active when mode is 'acp')
  const acpStream = useAcpStream({
    serverId: chatMode === 'acp' ? sourceSwarmId! : null,
    cwd: projectPath,
    enabled: chatMode === 'acp',
  });

  // Auto-connect ACP stream when mode becomes 'acp'
  const acpConnectedRef = useRef(false);
  useEffect(() => {
    if (chatMode === 'acp' && !acpConnectedRef.current && acpStream.status === 'idle') {
      acpConnectedRef.current = true;
      acpStream.connect();
    }
  }, [chatMode, acpStream.status, acpStream.connect]);

  // Reset connection tracking when mode changes away from ACP
  useEffect(() => {
    if (chatMode !== 'acp') {
      acpConnectedRef.current = false;
    }
  }, [chatMode]);

  // Determine effective status
  const chatStatus: ChatStatus = useMemo(() => {
    if (!isConnected || !hasAnyChatCap) return 'detecting';
    if (chatMode === 'acp') {
      if (acpStream.status === 'connecting') return 'connecting';
      if (acpStream.status === 'streaming') return 'streaming';
      if (acpStream.status === 'ready') return 'ready';
      if (acpStream.status === 'error') return 'error';
      return 'connecting';
    }
    return 'ready';
  }, [isConnected, hasAnyChatCap, chatMode, acpStream.status]);

  // Send message via appropriate channel
  const sendMessage = useCallback(async (text: string) => {
    if (chatMode === 'acp' && acpStream.status === 'ready') {
      await acpStream.send(text);
    } else if (hasMail && chatMode !== 'unavailable') {
      // Mail fallback (also used when ACP is connecting/errored)
      await api.post(`/sessions/${sessionId}/chat`, { content: text });
    }
  }, [chatMode, acpStream, hasMail, sessionId]);

  // Cancel ACP stream
  const cancelStream = useCallback(async () => {
    if (chatMode === 'acp') {
      await acpStream.cancel();
    }
  }, [chatMode, acpStream]);

  return {
    chatMode: acpStream.status === 'error' && hasMail ? 'mail' : chatMode,
    chatStatus,
    chatEnabled: chatMode !== 'unavailable' && (chatStatus === 'ready' || chatStatus === 'streaming'),
    sendMessage,
    cancelStream: chatMode === 'acp' ? cancelStream : undefined,
    capabilities,
    streamingEvents: acpStream.events,
    streamError: acpStream.error,
  };
}
