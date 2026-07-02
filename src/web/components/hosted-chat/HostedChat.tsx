/**
 * HostedChat — chat surface for any programmatic-mode (`mode: 'rpc'`)
 * hosted swarm. Provider-agnostic: codex today, future programmatic-mode
 * providers slot in by adding a translator on the backend (the wire
 * format is normalized — see `src/swarm/hosted-chat-events.ts`).
 *
 * Driven by swarmcraft's unified `useChatChannel`, with the host-managed
 * adapter picked up from `useOpenHiveAdapters`. Same primitives every
 * other openhive chat surface uses.
 *
 * Stop control: the hosted-chat adapter in swarmcraft doesn't implement
 * `cancel` (and reports `ready` during turns), so ChatInput's built-in
 * stop button never engages here. Instead we track the active turn id
 * through a second (ref-counted) service subscription and render our own
 * stop strip wired to `POST /map/hosted/:id/chat/interrupt`.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import { ChatMessageList, ChatInput, PermissionDialog, useChatChannel } from 'swarmcraft/ui/embed';
import { useOpenHiveAdapters } from '../../adapters/openhive-adapters';
import {
  hostedChatTarget,
  useHostedChatCapabilityResolver,
} from '../../lib/chat/resolvers';
import { hostedChatService, interruptHostedTurn } from '../../services/hosted-chat-service';
import { toast } from '../../stores/toast';

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

  // Active-turn tracking for the stop control. Uses the same ref-counted
  // service subscription mechanism as the adapter, so turns started from
  // sibling tabs are also stoppable here.
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [interrupting, setInterrupting] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const noop = () => {};
    const unsub = hostedChatService.subscribe(hostedSwarmId, {
      onMessageStart: noop,
      onMessageDelta: noop,
      onMessageComplete: noop,
      onTurnStarted: (turnId) => setActiveTurnId(turnId || null),
      onTurnCompleted: () => setActiveTurnId(null),
      onError: () => setActiveTurnId(null),
    });
    return () => {
      unsub();
      setActiveTurnId(null);
    };
  }, [hostedSwarmId, enabled]);

  const handleStop = async () => {
    if (!activeTurnId || interrupting) return;
    setInterrupting(true);
    try {
      await interruptHostedTurn(hostedSwarmId, activeTurnId);
      // Don't clear activeTurnId here — the provider emits turn.completed
      // once the interrupt lands, which clears it for every tab.
    } catch (err) {
      toast.error('Stop failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setInterrupting(false);
    }
  };

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
            className="ml-2 rounded px-1.5 py-0.5 text-2xs font-semibold uppercase"
            style={{
              color: 'var(--color-accent)',
              backgroundColor: 'var(--color-accent-bg)',
            }}
            title="Chat transport: hosted RPC"
          >
            hosted
          </span>
          <span
            className="ml-2 text-2xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {providerLabel ? `· ${providerLabel}` : ''}
            {channel.status !== 'ready' && channel.status !== 'streaming' ? ` · ${channel.status}` : ''}
          </span>
          {channel.statusDetail && (
            <span className="ml-2 text-2xs text-red-400">{channel.statusDetail}</span>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ChatMessageList channel={channel} emptyMessage="No messages yet." />
      </div>
      <PermissionDialog
        channel={channel}
        variant="sticky-external"
        descriptionAs="code"
        approveLabel="Allow"
      />
      {activeTurnId && (
        <div
          className="px-3 py-1.5 border-t flex items-center justify-between gap-2"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <span className="text-2xs flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
            <Loader2 className="w-3 h-3 animate-spin" />
            Agent is responding…
          </span>
          <button
            onClick={() => void handleStop()}
            disabled={interrupting}
            className="flex items-center gap-1 text-2xs font-medium px-2 py-1 rounded cursor-pointer bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-colors"
            title="Stop the current turn (session stays usable)"
          >
            <Square className="w-3 h-3" />
            Stop
          </button>
        </div>
      )}
      <div className="border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <ChatInput channel={channel} placeholder="Send a message…" />
      </div>
    </div>
  );
}
