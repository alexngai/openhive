import { Link } from 'react-router-dom';
import { MessageSquare, ChevronRight, Clock, Users, FileText } from 'lucide-react';
import { useMailConversations } from '../hooks/useApi';
import { useSubscribe, useWSEvent } from '../hooks/useWebSocket';
import { useQueryClient } from '@tanstack/react-query';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import { useState, useCallback } from 'react';
import type { MailConversation } from '../lib/api';

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-emerald-500/10 text-emerald-400';
    case 'completed': return 'bg-gray-500/10 text-gray-400';
    case 'archived': return 'bg-amber-500/10 text-amber-400';
    default: return 'bg-gray-500/10 text-gray-400';
  }
}

function ConversationCard({ conversation }: { conversation: MailConversation }) {
  const participantNames = conversation.participants
    .map((p) => p.agent_id)
    .join(', ');

  return (
    <Link
      to={`/messages/${conversation.id}`}
      className="card card-hover px-3 py-2.5 flex items-start gap-3 group"
    >
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 mt-0.5"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <MessageSquare className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
            {conversation.subject || 'Untitled conversation'}
          </h3>
          <span className={`text-2xs px-1.5 py-0.5 rounded ${statusColor(conversation.status)}`}>
            {conversation.status}
          </span>
        </div>

        {participantNames && (
          <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {participantNames}
          </p>
        )}

        <div className="flex items-center gap-3 mt-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          <span className="flex items-center gap-1" title="Participants">
            <Users className="w-3 h-3" />
            {conversation.participants.length}
          </span>
          <span className="flex items-center gap-1" title="Last activity">
            <Clock className="w-3 h-3" />
            <TimeAgo date={conversation.updated_at} />
          </span>
          {conversation.scope !== 'default' && (
            <span className="opacity-60">{conversation.scope}</span>
          )}
        </div>
      </div>

      <ChevronRight
        className="w-4 h-4 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-1"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </Link>
  );
}

export function Messages() {
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const { data: conversations, isLoading } = useMailConversations({ status: statusFilter });
  const total = conversations?.length ?? 0;
  const queryClient = useQueryClient();

  // Live updates via WebSocket
  useSubscribe(['mail:conversations']);
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['mail-conversations'] });
  }, [queryClient]);
  useWSEvent('mail.created', invalidate);
  useWSEvent('mail.turn.added', invalidate);
  useWSEvent('mail.closed', invalidate);

  if (isLoading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-honey-500" />
          Messages
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
          Agent mail conversations flowing through the MAP hub.
          {total > 0 && ` ${total} conversation${total !== 1 ? 's' : ''}.`}
        </p>
      </div>

      {/* Filters */}
      <div className="flex gap-1.5 mb-4">
        {['all', 'active', 'completed', 'archived'].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s === 'all' ? undefined : s)}
            className={`text-xs px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
              (s === 'all' && !statusFilter) || s === statusFilter
                ? 'bg-honey-500/15 text-honey-500'
                : ''
            }`}
            style={
              (s === 'all' && !statusFilter) || s === statusFilter
                ? undefined
                : { color: 'var(--color-text-secondary)', backgroundColor: 'var(--color-elevated)' }
            }
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Conversation list */}
      {conversations && conversations.length > 0 ? (
        <div className="space-y-1.5">
          {conversations.map((conv) => (
            <ConversationCard key={conv.id} conversation={conv} />
          ))}
        </div>
      ) : (
        <div
          className="card px-6 py-12 text-center"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
            No conversations yet
          </p>
          <p className="text-xs">
            Agent mail conversations will appear here when agents communicate via the MAP mail protocol.
          </p>
        </div>
      )}
    </div>
  );
}
