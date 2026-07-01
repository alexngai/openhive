/**
 * ChatPanel — message rendering + input for the ChatFab
 *
 * Wraps useChatChannel from swarmcraft with the OpenHive adapters.
 * Renders messages via ChatMessageList + ChatInput from swarmcraft/ui/embed.
 *
 * Composer path branches on the `CHAT_CONTEXT_CHIPS` module constant (§7.0):
 * - ON (default): ChipStrip + ChipsComposer; context-menu clicks stage chips,
 *   Send composes chips + text into a single turn.
 * - OFF (escape hatch, `VITE_CHAT_CONTEXT_CHIPS=false`): plain `ChatInput`,
 *   no context menu — chip UI is the only context surface.
 */

import { useMemo, useCallback, useEffect, useRef } from 'react';
import {
  useChatChannel,
  ChatMessageList,
  ChatInput,
  PermissionDialog,
} from 'swarmcraft/ui/embed';
import { useOpenHiveAdapters } from '../../adapters/openhive-adapters';
import { useSessionCapabilityResolver, sessionTarget } from '../../lib/chat/resolvers';
import { useChatFabStore } from './ChatFabStore';
import { ContextMenu, type ContextMenuHandle } from './ContextMenu';
import { setAcpStreamAgentName } from '../../adapters/openhive-acp-service';
import { useMapSwarm } from '../../hooks/useApi';
import { useEnrichedUserTurns } from '../../hooks/useEnrichedUserTurns';
import { CHAT_CONTEXT_CHIPS } from './feature-flags';
import { ChipStrip } from './ChipStrip';
import { ChipsComposer } from './ChipsComposer';

/**
 * Backfill the acp-service's agent display name on resumed streams.
 * `createStream()` captures it on first connect, but a page reload (or
 * docked-floating toggle) routes through `loadSession()` instead, where
 * the name isn't available. Look it up from the live MAP registry and
 * push it into the stream subscription so chat bubbles get the avatar.
 */
function useBackfillAcpAgentName() {
  const { agentRef, sessionLabel, resume } = useChatFabStore();
  const { data: swarm } = useMapSwarm(agentRef?.swarmId ?? '');
  useEffect(() => {
    const streamId = resume?.acpStreamId;
    if (!streamId || !agentRef) return;
    const agents = (swarm as { registered_agents?: Array<{
      id: string; name?: string; metadata?: Record<string, unknown> | null;
    }> } | undefined)?.registered_agents ?? [];
    const match = agents.find((a) => {
      if (a.id === agentRef.agentId) return true;
      const peerId = (a.metadata as { peerMapId?: string } | null | undefined)?.peerMapId;
      return peerId === agentRef.agentId;
    });
    const name = match?.name ?? sessionLabel ?? null;
    setAcpStreamAgentName(streamId, name);
  }, [resume?.acpStreamId, agentRef, swarm, sessionLabel]);
}

export function ChatPanel() {
  const { sessionId, swarmId, resume } = useChatFabStore();
  const adapters = useOpenHiveAdapters();
  const resolveCapabilities = useSessionCapabilityResolver(swarmId ?? undefined);
  const contextMenuRef = useRef<ContextMenuHandle>(null);
  useBackfillAcpAgentName();

  // Passing `resume` into the target steers the ACP adapter into
  // `loadSession()` on the existing stream instead of `createStream()` —
  // critical across ChatPanel re-mounts (FAB ↔ sidebar mode toggle,
  // route changes) so the server-side stream + chat history are reused.
  // Deps pick the resume fields individually so a new-but-equal `resume`
  // object doesn't churn the channel.
  const target = useMemo(
    () =>
      sessionId && swarmId
        ? sessionTarget(
            sessionId,
            swarmId,
            resume?.acpStreamId && resume?.acpSessionId
              ? {
                  acpStreamId: resume.acpStreamId,
                  acpSessionId: resume.acpSessionId,
                  providerSessionId: resume.providerSessionId,
                }
              : undefined,
          )
        : null,
    [sessionId, swarmId, resume?.acpStreamId, resume?.acpSessionId, resume?.providerSessionId],
  );

  const channel = useChatChannel({
    target,
    adapters,
    resolveCapabilities,
    enabled: !!target,
  });

  // Decorate user/supervisor turns with openhive Agent identity (name +
  // avatar). Shared helper used by MailThreadView, SessionDetail, and the
  // coordination adapter so the same user shows the same way everywhere.
  const messages = useEnrichedUserTurns(channel.messages);

  const onAtKey = useCallback((): boolean => {
    return contextMenuRef.current?.openWithPrimary() ?? false;
  }, []);

  if (!target) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-xs"
        style={{ color: 'var(--color-text-muted)' }}
      >
        No session active
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <ChatMessageList
          channel={channel}
          messages={messages}
          loading={channel.status === 'connecting'}
          compact
        />
      </div>

      {/* Permission dialog (ACP tool approval). Sticky-external matches the
          variant used on SessionDetail + MailThreadView — consistent Allow/
          Deny surface across every openhive chat and it doesn't consume
          vertical space inside the scrollable message list. */}
      <PermissionDialog
        channel={channel}
        variant="sticky-external"
        descriptionAs="code"
        approveLabel="Allow"
      />

      {/* Context menu + input */}
      <div
        className="border-t px-3 py-2 space-y-1"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        {CHAT_CONTEXT_CHIPS ? (
          <>
            <ContextMenu ref={contextMenuRef} />
            <ChipStrip />
            <ChipsComposer channel={channel} onAtKey={onAtKey} compact />
          </>
        ) : (
          <ChatInput channel={channel} compact showModeBadge />
        )}
      </div>
    </div>
  );
}
