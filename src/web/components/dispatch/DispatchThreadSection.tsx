/**
 * Dispatch coordination thread section.
 *
 * Renders the per-dispatch coordination conversation inline on the dispatch
 * detail page. Shows turns from agents and users with importance badges on
 * agent-initiated turns. Users can reply via the input at the bottom.
 *
 * If no conversation exists yet, shows a muted placeholder.
 * If the dispatch is in a terminal state, the input is hidden.
 */

import { useState, useRef, useEffect } from 'react';
import { MessageCircle, Send, Settings, ArrowUpCircle, AlertTriangle } from 'lucide-react';
import { useMailConversation } from '../../hooks/useApi';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { TimeAgo } from '../common/TimeAgo';
import type { MailTurn } from '../../lib/api';
import type { DispatchStatus } from '../../hooks/useDispatch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DispatchThreadSectionProps {
  dispatchId: string;
  conversationId: string | null;
  dispatchStatus: DispatchStatus;
}

// ---------------------------------------------------------------------------
// Importance badge — only shown on non-user turns
// ---------------------------------------------------------------------------

const IMPORTANCE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  urgent: { bg: 'rgba(239, 68, 68, 0.15)', text: 'rgb(239, 68, 68)', label: 'urgent' },
  high: { bg: 'rgba(245, 158, 11, 0.15)', text: 'rgb(245, 158, 11)', label: 'high' },
  normal: { bg: 'rgba(148, 163, 184, 0.15)', text: 'rgb(148, 163, 184)', label: 'normal' },
  low: { bg: 'rgba(100, 116, 139, 0.1)', text: 'rgb(100, 116, 139)', label: 'low' },
};

function ImportanceBadge({ importance }: { importance: string }) {
  const style = IMPORTANCE_STYLES[importance];
  if (!style || importance === 'normal') return null;
  return (
    <span
      className="inline-flex items-center text-2xs px-1.5 py-0.5 rounded-full font-medium"
      style={{ backgroundColor: style.bg, color: style.text }}
    >
      {importance === 'urgent' && <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />}
      {style.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// System turn (orchestrator retries, status changes)
// ---------------------------------------------------------------------------

function isSystemTurn(turn: MailTurn): boolean {
  return turn.participant_id.startsWith('system:');
}

function SystemTurnRow({ turn }: { turn: MailTurn }) {
  const text =
    typeof turn.content === 'string'
      ? turn.content
      : (turn.content as { text?: string })?.text ?? '';
  return (
    <div className="flex items-start gap-2 py-1.5 px-3">
      <Settings className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
      <div className="min-w-0 flex-1">
        <span className="text-xs italic" style={{ color: 'var(--color-text-muted)' }}>
          {text}
        </span>
        <span className="text-2xs ml-2" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
          <TimeAgo date={turn.created_at} />
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Regular turn bubble
// ---------------------------------------------------------------------------

function TurnBubble({ turn, isUser }: { turn: MailTurn; isUser: boolean }) {
  const text =
    typeof turn.content === 'string'
      ? turn.content
      : (turn.content as { text?: string })?.text ?? '';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`}>
      <div
        className="max-w-[80%] rounded-lg px-3 py-2"
        style={{
          backgroundColor: isUser
            ? 'var(--color-honey-500, #f59e0b)'
            : 'var(--color-elevated)',
          color: isUser ? '#000' : 'var(--color-text)',
        }}
      >
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-2xs font-medium" style={{ opacity: 0.7 }}>
            {turn.participant_id}
          </span>
          {!isUser && turn.importance && (
            <ImportanceBadge importance={turn.importance} />
          )}
        </div>
        <p className="text-sm whitespace-pre-wrap break-words">{text}</p>
        <div
          className="text-2xs mt-1"
          style={{ opacity: 0.5 }}
        >
          <TimeAgo date={turn.created_at} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['complete', 'failed', 'cancelled']);

export function DispatchThreadSection({
  dispatchId,
  conversationId,
  dispatchStatus,
}: DispatchThreadSectionProps) {
  const { data, isLoading } = useMailConversation(conversationId ?? '');
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isTerminal = TERMINAL_STATUSES.has(dispatchStatus);
  const turns: MailTurn[] = data?.turns ?? [];

  // Auto-scroll to bottom on new turns
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns.length]);

  // Poll for new turns when conversation exists and dispatch is active
  useEffect(() => {
    if (!conversationId || isTerminal) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['mail-conversation', conversationId] });
    }, 5000);
    return () => clearInterval(interval);
  }, [conversationId, isTerminal, queryClient]);

  const handleSend = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await api.post(`/dispatches/${dispatchId}/thread/turns`, {
        content: message.trim(),
        importance: 'high',
      });
      setMessage('');
      // Refresh turns
      queryClient.invalidateQueries({ queryKey: ['mail-conversation', conversationId] });
      // Also refresh the dispatch itself (conversation_id might have been set)
      queryClient.invalidateQueries({ queryKey: ['dispatch', dispatchId] });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // No conversation yet
  if (!conversationId) {
    return null;
  }

  return (
    <div
      className="rounded-md border mb-6 flex flex-col"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <MessageCircle className="h-3.5 w-3.5 text-honey-500" />
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Coordination thread
        </span>
        <span className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
          {turns.length} {turns.length === 1 ? 'message' : 'messages'}
        </span>
        {isTerminal && data?.conversation?.status === 'completed' && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded-full ml-auto"
            style={{ backgroundColor: 'rgba(148, 163, 184, 0.15)', color: 'var(--color-text-muted)' }}
          >
            closed
          </span>
        )}
      </div>

      {/* Messages */}
      {isLoading ? (
        <div className="p-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Loading thread...
        </div>
      ) : turns.length === 0 ? (
        <div className="p-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
          No messages yet.
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="p-3 overflow-y-auto"
          style={{ maxHeight: '400px' }}
        >
          {turns.map((turn) =>
            isSystemTurn(turn) ? (
              <SystemTurnRow key={turn.id} turn={turn} />
            ) : (
              <TurnBubble
                key={turn.id}
                turn={turn}
                isUser={!turn.participant_id.startsWith('agent:') && !turn.participant_id.startsWith('executor')}
              />
            ),
          )}
        </div>
      )}

      {/* Input — hidden when dispatch is terminal */}
      {!isTerminal && (
        <div className="border-t px-3 py-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
          {sendError && (
            <div className="text-xs text-red-400 mb-1.5 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {sendError}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Send a message to the agent..."
              rows={1}
              className="flex-1 text-sm rounded-md border px-3 py-1.5 resize-none bg-transparent focus:outline-none focus:ring-1"
              style={{
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text)',
                // @ts-expect-error css var
                '--tw-ring-color': 'var(--color-honey-500, #f59e0b)',
              }}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!message.trim() || sending}
              className="p-1.5 rounded-md hover:opacity-80 disabled:opacity-30 transition-opacity"
              title="Send (Enter)"
            >
              {sending ? (
                <ArrowUpCircle className="h-5 w-5 animate-spin text-honey-500" />
              ) : (
                <Send className="h-5 w-5 text-honey-500" />
              )}
            </button>
          </div>
        </div>
      )}

      {/* Closed state footer */}
      {isTerminal && (
        <div
          className="px-4 py-2 text-xs text-center border-t"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text-muted)',
          }}
        >
          Thread closed — dispatch {dispatchStatus}.
        </div>
      )}
    </div>
  );
}
