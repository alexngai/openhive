/**
 * useOpenHiveAdapters — React hook that assembles the chat adapter set for
 * OpenHive (ACP + Mail) and ensures the underlying WS subscription is active.
 *
 * ACP adapter goes through SwarmCraft's /acp/streams proxy at /api/swarmcraft.
 * Mail hits OpenHive's /api/v1/mail/conversations and /api/v1/sessions/:id/chat.
 * Inject is deliberately omitted — OpenHive doesn't expose /agents/:id/inject.
 */

import { useEffect, useMemo } from 'react';
import {
  createAcpAdapter,
  createHostedChatAdapter,
  createMailAdapter,
  type ApiConfig,
  type ChatAdapter,
} from 'swarmcraft/ui/embed';
import { useSubscribe } from '../hooks/useWebSocket';
import {
  createOpenHiveAcpServiceLike,
  ensureAcpListenersRegistered,
} from './openhive-acp-service';
import { hostedChatService } from '../services/hosted-chat-service';
import { restBase, authHeader } from '../lib/hub';
import { useActiveHub } from '../hooks/useActiveHub';

/** OpenHive-specific ApiConfig: /api/v1 + lazy conv creation via /sessions/:id/chat */
function openHiveApiConfig(): ApiConfig {
  return {
    baseUrl: restBase(),
    getAuthHeader: () => authHeader(),
    endpoints: {
      mailConversations: '/mail/conversations',
      sessionChat: '/sessions/:id/chat',
    },
  };
}

export function useOpenHiveAdapters(): ChatAdapter[] {
  // Keep the WS subscription to 'global' alive so the ACP service's listeners
  // actually receive bridged acp.* events. Ref-counted at the store, so other
  // subscribers on 'global' share the channel.
  useSubscribe(['global']);

  // Rebuild the adapter set when the active hub changes so ACP/mail re-target
  // the new hub's origin + credential (baseUrl is captured per hub below).
  const { origin } = useActiveHub();

  // Register the ACP service's module-level WS listeners in an effect (not
  // during render) so the store mutation doesn't trigger a setState-during-
  // render warning for subscribers higher in the tree.
  useEffect(() => {
    ensureAcpListenersRegistered();
  }, []);

  return useMemo(() => {
    const api = openHiveApiConfig();
    const acpService = createOpenHiveAcpServiceLike();
    // No inject adapter: OpenHive does not currently expose an /agents/:id/inject
    // endpoint. Targets that only publish messaging.canReceive will fall through
    // to unavailable — which matches the old useSessionChat behavior where the
    // inject mode was purely a UI label with no working transport.
    return [
      createAcpAdapter({ acpService }),
      createHostedChatAdapter({ service: hostedChatService }),
      createMailAdapter(api),
    ];
  }, [origin]);
}
