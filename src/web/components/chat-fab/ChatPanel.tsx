/**
 * ChatPanel — message rendering + input for the ChatFab
 *
 * Wraps useChatChannel from swarmcraft with the OpenHive adapters.
 * Renders messages via ChatMessageList + ChatInput from swarmcraft/ui/embed.
 */

import { useMemo, useState, useCallback } from 'react';
import {
  useChatChannel,
  ChatMessageList,
  ChatInput,
  PermissionDialog,
} from 'swarmcraft/ui/embed';
import { useOpenHiveAdapters } from '../../adapters/openhive-adapters';
import { useSessionCapabilityResolver, sessionTarget } from '../../lib/chat/resolvers';
import { useChatFabStore } from './ChatFabStore';
import { ContextMenu } from './ContextMenu';

export function ChatPanel() {
  const { sessionId, swarmId, resume } = useChatFabStore();
  const adapters = useOpenHiveAdapters();
  const resolveCapabilities = useSessionCapabilityResolver(swarmId ?? undefined);
  const [pendingContext, setPendingContext] = useState<string | null>(null);

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

  const handleContextInject = useCallback((text: string) => {
    if (channel.status === 'ready' || channel.status === 'streaming') {
      channel.send(text).catch(() => {});
    } else {
      setPendingContext(text);
    }
  }, [channel]);

  // Send pending context once channel is ready
  if (pendingContext && (channel.status === 'ready' || channel.status === 'streaming')) {
    channel.send(pendingContext).catch(() => {});
    setPendingContext(null);
  }

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
          messages={channel.messages}
          loading={channel.status === 'connecting'}
          compact
        />
      </div>

      {/* Permission dialog (ACP tool approval) */}
      {channel.permissions && channel.permissions.length > 0 && (
        <div className="px-3 py-2 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <PermissionDialog
            permissions={channel.permissions}
            onReply={channel.replyPermission}
            variant="inline"
          />
        </div>
      )}

      {/* Context menu + input */}
      <div
        className="border-t px-3 py-2 space-y-1"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <ContextMenu onInject={handleContextInject} />
        <ChatInput
          channel={channel}
          compact
        />
      </div>
    </div>
  );
}
