/**
 * HostedChat — chat surface for any programmatic-mode (`mode: 'rpc'`)
 * hosted swarm. Provider-agnostic: codex today, future programmatic-mode
 * providers slot in by adding a translator on the backend (the wire
 * format is normalized — see `src/swarm/hosted-chat-events.ts`).
 *
 * Driven by swarmcraft's unified `useChatChannel`, with the host-managed
 * adapter picked up from `useOpenHiveAdapters`. Same primitives every
 * other openhive chat surface uses.
 */

import { useMemo } from 'react';
import { ChatMessageList, ChatInput, useChatChannel } from 'swarmcraft/ui/embed';
import { useOpenHiveAdapters } from '../../adapters/openhive-adapters';
import {
  hostedChatTarget,
  useHostedChatCapabilityResolver,
} from '../../lib/chat/resolvers';

interface HostedChatProps {
  hostedSwarmId: string;
  /** Display label shown above the chat (e.g. swarm name). */
  label?: string;
  /** Provider hint surfaced in the status row (e.g. 'codex'). Cosmetic. */
  providerLabel?: string;
  /** When false the channel disconnects (use to gate on mount visibility). */
  enabled?: boolean;
}

export function HostedChat({ hostedSwarmId, label, providerLabel, enabled = true }: HostedChatProps) {
  const adapters = useOpenHiveAdapters();
  const resolveCapabilities = useHostedChatCapabilityResolver(hostedSwarmId);
  const target = useMemo(() => hostedChatTarget(hostedSwarmId), [hostedSwarmId]);

  const channel = useChatChannel({
    target,
    adapters,
    resolveCapabilities,
    enabled,
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      {label && (
        <div
          className="px-3 py-2 border-b text-xs font-medium"
          style={{
            color: 'var(--color-text-secondary)',
            borderColor: 'var(--color-border-subtle)',
          }}
        >
          {label}
          <span
            className="ml-2 text-2xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {providerLabel ? `· ${providerLabel}` : ''}
            {channel.status !== 'connected' && channel.status !== 'idle' ? ` · ${channel.status}` : ''}
          </span>
          {channel.statusDetail && (
            <span className="ml-2 text-2xs text-red-400">{channel.statusDetail}</span>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ChatMessageList channel={channel} />
      </div>
      <div className="border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <ChatInput channel={channel} placeholder="Send a message…" />
      </div>
    </div>
  );
}
