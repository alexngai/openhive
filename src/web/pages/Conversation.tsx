import { useParams, Link } from 'react-router-dom';
import { MessageSquare, ArrowLeft, Send, Users, Bot, User, ChevronDown, ChevronRight } from 'lucide-react';
import { useMailConversation, useSendMailTurn } from '../hooks/useApi';
import { useSubscribe, useWSEvent } from '../hooks/useWebSocket';
import { useQueryClient } from '@tanstack/react-query';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import { useState, useRef, useEffect, useCallback } from 'react';
import type { MailTurn } from '../lib/api';

function TurnContent({ turn }: { turn: MailTurn }) {
  const content = turn.content;

  if (!content) {
    return <span className="text-xs opacity-50">(empty)</span>;
  }

  // Text content
  if (content.type === 'text' && 'text' in content) {
    return <p className="text-sm whitespace-pre-wrap break-words">{content.text}</p>;
  }

  // Event content
  if (content.type === 'event' && 'event' in content) {
    return (
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
        <span className="font-medium">{content.event}</span>
        {'data' in content && content.data != null && (
          <span className="opacity-60">{JSON.stringify(content.data)}</span>
        )}
      </div>
    );
  }

  // Reference content
  if (content.type === 'reference' && 'uri' in content) {
    return (
      <a
        href={content.uri}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-honey-500 hover:underline"
      >
        {('label' in content && content.label) || content.uri}
      </a>
    );
  }

  // Data / JSON content
  if (content.type === 'data' || typeof content === 'object') {
    return (
      <CollapsibleJson data={content} />
    );
  }

  // Fallback
  return <pre className="text-xs overflow-x-auto">{JSON.stringify(content, null, 2)}</pre>;
}

function CollapsibleJson({ data }: { data: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const json = JSON.stringify(data, null, 2);
  const isLong = json.length > 200;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-2xs cursor-pointer"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {expanded ? 'Collapse' : 'Expand'} JSON
      </button>
      {(expanded || !isLong) && (
        <pre
          className="text-xs mt-1 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          {json}
        </pre>
      )}
    </div>
  );
}

function TurnBubble({ turn, isEvent }: { turn: MailTurn; isEvent: boolean }) {
  if (isEvent) {
    return (
      <div className="flex justify-center py-1">
        <div
          className="px-3 py-1 rounded-full text-2xs"
          style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
        >
          <TurnContent turn={turn} />
        </div>
      </div>
    );
  }

  const isSupervisor = turn.participant_id?.includes('human') || turn.content_type === 'supervisor';

  return (
    <div className="flex gap-2.5 py-1.5">
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
        style={{ backgroundColor: isSupervisor ? 'var(--color-accent-bg)' : 'var(--color-elevated)' }}
      >
        {isSupervisor
          ? <User className="w-3.5 h-3.5 text-honey-500" />
          : <Bot className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        }
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium">{turn.participant_id}</span>
          {turn.thread_id && (
            <span className="text-2xs px-1 py-0.5 rounded bg-blue-500/10 text-blue-400">thread</span>
          )}
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <TimeAgo date={turn.created_at} />
          </span>
        </div>
        <TurnContent turn={turn} />
      </div>
    </div>
  );
}

export function Conversation() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useMailConversation(id!);
  const sendTurn = useSendMailTurn();
  const [message, setMessage] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Live updates via WebSocket
  useSubscribe(id ? [`mail:conversation:${id}`] : []);
  const invalidate = useCallback(() => {
    if (id) {
      queryClient.invalidateQueries({ queryKey: ['mail-conversation', id] });
    }
  }, [queryClient, id]);
  useWSEvent('mail.turn.added', invalidate);
  useWSEvent('mail.participant.joined', invalidate);
  useWSEvent('mail.closed', invalidate);

  const conversation = data?.conversation;
  const turns = data?.turns ?? [];
  const threads = data?.threads ?? [];

  // Auto-scroll to bottom on new turns
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns.length]);

  const handleSend = () => {
    if (!message.trim() || !id) return;

    sendTurn.mutate({
      conversationId: id,
      content: { type: 'text', text: message.trim() },
      content_type: 'text',
    });
    setMessage('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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
            <span>{turns.length} turn{turns.length !== 1 ? 's' : ''}</span>
            {threads.length > 0 && <span>{threads.length} thread{threads.length !== 1 ? 's' : ''}</span>}
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

      {/* Turn stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5"
      >
        {turns.length > 0 ? (
          turns.map((turn) => (
            <TurnBubble
              key={turn.id}
              turn={turn}
              isEvent={turn.content_type === 'event'}
            />
          ))
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              No turns in this conversation yet.
            </p>
          </div>
        )}
      </div>

      {/* Input area */}
      <div
        className="px-4 py-3 border-t shrink-0"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message as supervisor..."
            className="input flex-1 text-sm py-2 px-3 min-h-[38px] max-h-32 resize-none"
            rows={1}
          />
          <button
            onClick={handleSend}
            disabled={!message.trim() || sendTurn.isPending}
            className="btn btn-primary p-2 shrink-0 disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        <p className="text-2xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
          Messages are sent as a supervisor turn. Press Enter to send, Shift+Enter for new line.
        </p>
      </div>
    </div>
  );
}
