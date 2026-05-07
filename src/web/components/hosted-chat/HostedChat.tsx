/**
 * HostedChat — chat surface for any programmatic-mode (`mode: 'rpc'`)
 * hosted swarm. Provider-agnostic: codex today, future programmatic-mode
 * providers slot in by adding a translator on the backend (the wire
 * format is normalized — see `src/swarm/hosted-chat-events.ts`).
 *
 * Composes `useHostedChatChannel` with swarmcraft's `ChatMessageList` +
 * `ChatInput` (the same primitives every other openhive chat surface
 * uses). Embed inline (e.g. in SwarmDetail) or open as overlay (e.g. via
 * ChatFab).
 */

import { ChatMessageList, ChatInput } from 'swarmcraft/ui/embed';
import { useHostedChatChannel } from '../../hooks/useHostedChatChannel';

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
  const channel = useHostedChatChannel({ hostedSwarmId, enabled });

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
