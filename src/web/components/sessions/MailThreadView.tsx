import { useMemo, useCallback } from 'react';
import { MessageSquare, Users } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMailConversation } from '../../hooks/useApi';
import { useSubscribe, useWSEvent } from '../../hooks/useWebSocket';
import { TimeAgo } from '../common/TimeAgo';
import { LoadingSpinner } from '../common/LoadingSpinner';
import {
  useChatChannel,
  ChatMessageList,
  ChatInput,
  PermissionDialog,
} from 'swarmcraft/ui/embed';
import { useConversationCapabilityResolver, conversationTarget } from '../../lib/chat/resolvers';
import { useOpenHiveAdapters } from '../../adapters/openhive-adapters';

/**
 * Mail conversation detail, rendered inside the unified Threads page.
 * Mirrors the chat surface from SessionDetail's trajectory tab — same
 * ChatMessageList + ChatInput + PermissionDialog components, mail-only
 * adapter. Extracted from the legacy Conversation.tsx so mail threads can
 * be viewed without a separate top-level route.
 */
export function MailThreadView({ conversationId }: { conversationId: string }) {
  const { data, isLoading } = useMailConversation(conversationId);
  const queryClient = useQueryClient();

  useSubscribe([`mail:conversation:${conversationId}`]);
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['mail-conversation', conversationId] });
  }, [queryClient, conversationId]);
  useWSEvent('mail.turn.added', invalidate);
  useWSEvent('mail.participant.joined', invalidate);
  useWSEvent('mail.closed', invalidate);

  const adapters = useOpenHiveAdapters();
  const resolveCapabilities = useConversationCapabilityResolver(conversationId);
  const target = useMemo(() => conversationTarget(conversationId), [conversationId]);
  const channel = useChatChannel({ target, adapters, resolveCapabilities });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <LoadingSpinner />
      </div>
    );
  }

  const conversation = data?.conversation;
  const threads = data?.threads ?? [];

  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Conversation not found.
        </p>
      </div>
    );
  }

  const isGroup = conversation.participants.length > 2;

  return (
    <div className="flex flex-col h-full">
      {/* Header — mirrors SessionDetail's sticky header but with group-chat
          participant stack when N > 2. */}
      <div
        className="px-4 py-3 border-b flex items-center gap-3 shrink-0"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <MessageSquare className="w-4 h-4 text-honey-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-bold truncate flex items-center gap-2">
            {conversation.subject || 'Untitled conversation'}
            {isGroup && (
              <span
                className="text-2xs font-normal px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor: 'var(--color-accent-bg)',
                  color: 'var(--color-accent)',
                }}
              >
                group · {conversation.participants.length}
              </span>
            )}
          </h1>
          <div className="flex items-center gap-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <span
              className={`px-1.5 py-0.5 rounded ${
                conversation.status === 'active'
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'bg-gray-500/10 text-gray-400'
              }`}
            >
              {conversation.status}
            </span>
            <span>{data?.turn_count ?? 0} turn{(data?.turn_count ?? 0) !== 1 ? 's' : ''}</span>
            {threads.length > 0 && (
              <span>{threads.length} sub-thread{threads.length !== 1 ? 's' : ''}</span>
            )}
            <span>
              <TimeAgo date={conversation.updated_at} />
            </span>
          </div>
        </div>

        {/* Participant stack (group-thread affordance: shows who's here) */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Users className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          <div className="flex -space-x-1.5">
            {conversation.participants.slice(0, 5).map((p) => (
              <div
                key={p.agent_id}
                className="w-6 h-6 rounded-full flex items-center justify-center text-2xs font-medium border-2"
                style={{
                  backgroundColor: 'var(--color-elevated)',
                  borderColor: 'var(--color-bg)',
                  color: 'var(--color-text-secondary)',
                }}
                title={`${p.agent_id}${p.role ? ` (${p.role})` : ''}`}
              >
                {p.agent_id.charAt(0).toUpperCase()}
              </div>
            ))}
            {conversation.participants.length > 5 && (
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-2xs border-2"
                style={{
                  backgroundColor: 'var(--color-elevated)',
                  borderColor: 'var(--color-bg)',
                  color: 'var(--color-text-muted)',
                }}
              >
                +{conversation.participants.length - 5}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Chat surface */}
      <div className="flex-1 min-h-0 flex flex-col">
        <ChatMessageList
          channel={channel}
          continuationHeaders
          emptyMessage="No messages in this conversation yet."
        />
      </div>
      <PermissionDialog
        channel={channel}
        variant="sticky-external"
        descriptionAs="code"
        approveLabel="Allow"
      />
      <ChatInput channel={channel} showModeBadge />
    </div>
  );
}
