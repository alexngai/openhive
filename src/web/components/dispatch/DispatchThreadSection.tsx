/**
 * Dispatch coordination thread section.
 *
 * Renders the per-dispatch coordination conversation inline on the dispatch
 * detail page.
 *
 * Two states (P4.4):
 *   - Conversation exists → delegate to the unified `MailThreadView` (realtime
 *     WS updates, shared agent avatars, capability-gated composer). This is the
 *     same surface used by spec discussions and the Threads page, so a
 *     coordination thread reads/behaves identically everywhere.
 *   - No conversation yet AND dispatch still active → a lightweight empty-state
 *     composer. The first send lazily creates the conversation via the turns
 *     route (`POST /dispatches/:id/thread/turns`), after which the dispatch
 *     query refetches, `conversationId` appears, and this component re-renders
 *     into the MailThreadView surface.
 *
 * If the dispatch is terminal with no thread, nothing is rendered.
 *
 * The mail send path is gated only on conversation `status === 'active'` (see
 * useConversationCapabilityResolver), NOT on agent presence — so replies remain
 * fire-and-forget for agents that pick up mail on reactivation.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Send, ArrowUpCircle, AlertTriangle, Users } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { MailThreadView } from '../sessions/MailThreadView';
import type { DispatchStatus } from '../../hooks/useDispatch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DispatchThreadSectionProps {
  dispatchId: string;
  conversationId: string | null;
  dispatchStatus: DispatchStatus;
  /** Shared coordinated-team thread id (P4.2/P4.4). When set, a pointer to the
   *  team thread is shown above the per-dispatch thread. */
  teamConversationId?: string | null;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['complete', 'failed', 'cancelled']);

// ---------------------------------------------------------------------------
// Shared team-thread pointer (P4.2/P4.4)
// ---------------------------------------------------------------------------

function TeamThreadPointer({ teamConversationId }: { teamConversationId: string }) {
  return (
    <Link
      to={`/threads/${teamConversationId}`}
      className="flex items-center gap-2 px-4 py-2 border-b text-xs hover:bg-white/5"
      style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}
    >
      <Users className="h-3.5 w-3.5 text-honey-500 shrink-0" />
      <span>Part of a coordinated team — open the shared thread</span>
      <span className="font-mono ml-auto" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
        {teamConversationId}
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DispatchThreadSection({
  dispatchId,
  conversationId,
  dispatchStatus,
  teamConversationId,
}: DispatchThreadSectionProps) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const isTerminal = TERMINAL_STATUSES.has(dispatchStatus);
  const hasConversation = !!conversationId;

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
      // Refresh the dispatch so the newly-created conversation_id surfaces and
      // this component swaps to the MailThreadView surface.
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

  // Nothing to show only when the dispatch is terminal AND never had a thread —
  // there's no history to read and no point composing to a finished dispatch.
  if (!hasConversation && isTerminal) {
    return null;
  }

  // Conversation exists → unified thread surface (realtime WS + shared avatars).
  if (hasConversation) {
    return (
      <div
        className="rounded-md border mb-6 overflow-hidden"
        style={{
          borderColor: 'var(--color-border-subtle)',
          backgroundColor: 'var(--color-surface)',
        }}
      >
        {teamConversationId && <TeamThreadPointer teamConversationId={teamConversationId} />}
        <div className="h-[520px]">
          <MailThreadView conversationId={conversationId} registerPageContext={false} />
        </div>
      </div>
    );
  }

  // No conversation yet (dispatch still active) → empty-state composer that
  // lazily creates the thread on first send.
  return (
    <div
      className="rounded-md border mb-6 flex flex-col"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-b"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <MessageCircle className="h-3.5 w-3.5 text-honey-500" />
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Coordination thread
        </span>
      </div>

      {teamConversationId && <TeamThreadPointer teamConversationId={teamConversationId} />}

      <div className="p-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
        No coordination thread yet. Send a message below to start one and nudge the agent.
      </div>

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
            placeholder="Start a coordination thread — message the agent..."
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
    </div>
  );
}
