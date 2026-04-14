import { useParams, Link } from 'react-router-dom';
import { MessageSquare, ArrowLeft, Users } from 'lucide-react';
import { useMemo, useCallback } from 'react';
import { useMailConversation } from '../hooks/useApi';
import { useSubscribe, useWSEvent } from '../hooks/useWebSocket';
import { useQueryClient } from '@tanstack/react-query';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import { useChatChannel } from 'swarmcraft/ui/embed';
import { useConversationCapabilityResolver, conversationTarget } from '../lib/chat/resolvers';
import { useOpenHiveAdapters } from '../adapters/openhive-adapters';
import { EventStream } from '../components/events/EventStream';
import { SessionChatInput } from '../components/events/SessionChatInput';
import { PermissionDialog } from '../components/events/PermissionDialog';

export function Conversation() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useMailConversation(id!);
  const queryClient = useQueryClient();

  // Live updates via WebSocket — invalidate React Query cache on new turns
  useSubscribe(id ? [`mail:conversation:${id}`] : []);
  const invalidate = useCallback(() => {
    if (id) {
      queryClient.invalidateQueries({ queryKey: ['mail-conversation', id] });
    }
  }, [queryClient, id]);
  useWSEvent('mail.turn.added', invalidate);
  useWSEvent('mail.participant.joined', invalidate);
  useWSEvent('mail.closed', invalidate);

  // Chat channel — mail-only for conversations
  const adapters = useOpenHiveAdapters();
  const resolveCapabilities = useConversationCapabilityResolver(id);
  const target = useMemo(
    () => id ? conversationTarget(id) : null,
    [id],
  );
  const channel = useChatChannel({
    target,
    adapters,
    resolveCapabilities,
  });

  const conversation = data?.conversation;
  const threads = data?.threads ?? [];

  if (isLoading) return <PageLoader />;

  if (!conversation) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <p style={{ color: 'var(--color-text-muted)' }}>Conversation not found.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full max-w-5xl mx-auto">
      {/* Header */}
      <div
        className="px-4 py-3 border-b flex items-center gap-3 shrink-0"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <Link to="/messages" className="hover:text-honey-500 transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <MessageSquare className="w-4 h-4 text-honey-500" />
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-bold truncate">
            {conversation.subject || 'Untitled conversation'}
          </h1>
          <div className="flex items-center gap-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <span className={`px-1.5 py-0.5 rounded ${
              conversation.status === 'active' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-gray-500/10 text-gray-400'
            }`}>
              {conversation.status}
            </span>
            <span>{data?.turn_count ?? 0} turn{(data?.turn_count ?? 0) !== 1 ? 's' : ''}</span>
            {threads.length > 0 && <span>{threads.length} thread{threads.length !== 1 ? 's' : ''}</span>}
            <span><TimeAgo date={conversation.updated_at} /></span>
          </div>
        </div>

        {/* Participant list */}
        <div className="flex items-center gap-1.5">
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

      {/* Chat — channel-driven: EventStream + PermissionDialog + SessionChatInput */}
      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
        <EventStream
          events={[]}
          channel={channel}
          emptyMessage="No messages in this conversation yet."
          emptyIcon={MessageSquare}
        />
      </div>
      <PermissionDialog channel={channel} />
      <SessionChatInput channel={channel} />
    </div>
  );
}
