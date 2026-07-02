import { MessageSquare } from 'lucide-react';
import { useSpecThread, useCreateSpecThread } from '../../hooks/useSpecs';
import { MailThreadView } from '../sessions/MailThreadView';
import { InviteAgentButton } from '../sessions/InviteAgentButton';
import { LoadingSpinner } from '../common/LoadingSpinner';

/**
 * Discussion tab body for SpecDetail (P3.3). Resolves the spec's mail
 * conversation:
 *   - loading → spinner
 *   - thread exists → mount MailThreadView (handles realtime, roster, input)
 *   - no thread → "Start discussion" CTA that POSTs and swaps in the view
 */
export function SpecDiscussionPanel({
  resourceId,
  specId,
}: {
  resourceId: string;
  specId: string;
}) {
  const { data, isLoading, isError, error } = useSpecThread(resourceId, specId);
  const createThread = useCreateSpecThread(resourceId, specId);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm" style={{ color: 'var(--color-danger)' }}>
          Failed to load discussion{error instanceof Error ? `: ${error.message}` : '.'}
        </p>
      </div>
    );
  }

  if (data?.conversation_id) {
    return (
      <MailThreadView
        conversationId={data.conversation_id}
        headerAction={
          <InviteAgentButton
            conversationId={data.conversation_id}
            existingParticipantIds={(data.participants ?? []).map((p) => p.agent_id)}
          />
        }
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <MessageSquare className="h-8 w-8 opacity-40" style={{ color: 'var(--color-text-muted)' }} />
      <div>
        <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
          No discussion yet
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Start a thread to discuss this spec with your team and agents before dispatch.
        </p>
      </div>
      <button
        type="button"
        onClick={() => createThread.mutate()}
        disabled={createThread.isPending}
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
        style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-accent-fg, #fff)' }}
      >
        <MessageSquare className="h-4 w-4" />
        {createThread.isPending ? 'Starting…' : 'Start discussion'}
      </button>
      {createThread.isError && (
        <p className="text-xs" style={{ color: 'var(--color-danger)' }}>
          {createThread.error instanceof Error
            ? createThread.error.message
            : 'Failed to start discussion'}
        </p>
      )}
    </div>
  );
}
