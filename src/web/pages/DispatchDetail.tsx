import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Send, Zap, FileText, User, Bot, Ban, AlertCircle,
} from 'lucide-react';
import { useDispatch, useCancelDispatch } from '../hooks/useDispatch';
import { useDispatchRealtime, useCancelAckWarnings } from '../hooks/useDispatchRealtime';
import { useMapSwarm } from '../hooks/useApi';
import { DispatchStatusChip } from '../components/dispatch/DispatchStatusChip';
import { AttemptsTimeline } from '../components/dispatch/AttemptsTimeline';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import { ChatFabContextProvider } from '../components/chat-fab/ChatFabContext';

export function DispatchDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useDispatch(id);
  const { data: swarm } = useMapSwarm(data?.dispatch.target_swarm_id ?? '');
  const cancel = useCancelDispatch();
  const [cancelError, setCancelError] = useState<string | null>(null);
  useDispatchRealtime();
  const { warned: cancelNotAcked, dismiss: dismissCancelWarning } = useCancelAckWarnings(id);

  if (isLoading) return <PageLoader />;

  if (error || !data) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link
          to="/dispatch"
          className="inline-flex items-center gap-1 text-sm mb-4"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dispatch
        </Link>
        <div
          className="rounded-md border p-4 text-sm"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
        >
          {error ? `Failed to load: ${error instanceof Error ? error.message : String(error)}` : 'Dispatch not found'}
        </div>
      </div>
    );
  }

  const d = data.dispatch;
  const InitiatorIcon = d.initiator_type === 'agent' ? Bot : User;
  const isCancellable = d.status === 'queued' || d.status === 'running';

  const handleCancel = async () => {
    if (!d.id) return;
    setCancelError(null);
    try {
      await cancel.mutateAsync(d.id);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    }
  };

  const chatFabItems = [
    { label: `Dispatch: ${d.id.slice(0, 15)}…`, type: 'dispatch' as const, data: { id: d.id, spec_id: d.spec_id, status: d.status, target_swarm_id: d.target_swarm_id } },
  ];

  return (
    <ChatFabContextProvider items={chatFabItems}>
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to="/dispatch"
        className="inline-flex items-center gap-1 text-sm mb-4 hover:opacity-80"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Dispatch
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <Send className="h-4 w-4 text-honey-500" />
          <span className="font-mono">{d.id}</span>
          <span>·</span>
          <TimeAgo date={d.created_at} />
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <DispatchStatusChip status={d.status} />
          </div>
          {isCancellable && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancel.isPending}
              className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Ban className="h-4 w-4" />
              {cancel.isPending ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </div>

        {cancelError && (
          <div
            className="mt-2 rounded-md border p-2 text-sm flex items-start gap-2"
            style={{
              borderColor: 'var(--color-border-subtle)',
              color: 'var(--color-text)',
            }}
          >
            <AlertCircle className="h-4 w-4 mt-0.5 text-red-400" />
            <div>{cancelError}</div>
          </div>
        )}

        {cancelNotAcked && (
          <div
            className="mt-2 rounded-md border p-2 text-sm flex items-start gap-2"
            style={{
              borderColor: 'rgba(245, 158, 11, 0.4)',
              backgroundColor: 'rgba(245, 158, 11, 0.05)',
              color: 'var(--color-text)',
            }}
          >
            <AlertCircle className="h-4 w-4 mt-0.5 text-amber-400" />
            <div className="flex-1">
              <div className="font-medium">Agent did not acknowledge cancel</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                The target swarm was unreachable or dropped the cancel signal. The hub
                still marked this dispatch as cancelled; the agent may have continued
                working until its stream closed.
              </div>
            </div>
            <button
              type="button"
              onClick={dismissCancelWarning}
              className="text-xs opacity-70 hover:opacity-100"
              style={{ color: 'var(--color-text-muted)' }}
            >
              dismiss
            </button>
          </div>
        )}
      </div>

      {/* Metadata grid */}
      <div
        className="grid gap-3 md:grid-cols-2 rounded-md border p-4 mb-6"
        style={{
          borderColor: 'var(--color-border-subtle)',
          backgroundColor: 'var(--color-surface)',
        }}
      >
        <div>
          <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
            Spec
          </div>
          <Link
            to={`/specs/${d.spec_resource_id}/${d.spec_id}`}
            className="inline-flex items-center gap-1 hover:opacity-80"
            style={{ color: 'var(--color-text)' }}
          >
            <FileText className="h-4 w-4 text-honey-500" />
            <span className="font-mono text-sm">{d.spec_id}</span>
          </Link>
        </div>

        <div>
          <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
            Target swarm
          </div>
          <Link
            to={`/swarms/${d.target_swarm_id}`}
            className="inline-flex items-center gap-1 hover:opacity-80"
            style={{ color: 'var(--color-text)' }}
          >
            <Zap className="h-4 w-4 text-honey-500" />
            <span className="text-sm">{swarm?.name ?? d.target_swarm_id}</span>
          </Link>
        </div>

        <div>
          <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
            Initiator
          </div>
          <span
            className="inline-flex items-center gap-1 text-sm"
            style={{ color: 'var(--color-text)' }}
          >
            <InitiatorIcon className="h-4 w-4" />
            <span>{d.initiator_type}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>·</span>
            <span className="font-mono text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              {d.initiator_id}
            </span>
          </span>
        </div>

        <div>
          <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
            Spec captured at
          </div>
          <span className="text-sm" style={{ color: 'var(--color-text)' }}>
            {d.spec_captured_at ? <TimeAgo date={d.spec_captured_at} /> : '—'}
          </span>
        </div>
      </div>

      {/* Prompt override */}
      {d.prompt_override && (
        <div
          className="rounded-md border p-4 mb-6"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
            Additional instructions
          </div>
          <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--color-text)' }}>
            {d.prompt_override}
          </p>
        </div>
      )}

      {/* Sessions */}
      {d.session_ids.length > 0 && (
        <div
          className="rounded-md border p-4 mb-6"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
            Sessions
          </div>
          <ul className="space-y-1">
            {d.session_ids.map((sid) => (
              <li key={sid}>
                <Link
                  to={`/threads/${sid}`}
                  className="text-sm font-mono hover:opacity-80"
                  style={{ color: 'var(--color-text)' }}
                >
                  {sid}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Outcome */}
      {d.outcome && (
        <div
          className="rounded-md border p-4"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
            Outcome
          </div>
          {d.outcome.summary && (
            <p className="text-sm mb-2" style={{ color: 'var(--color-text)' }}>
              {d.outcome.summary}
            </p>
          )}
          {d.outcome.error && (
            <p className="text-sm mb-2 text-red-300">{d.outcome.error}</p>
          )}
          {d.outcome.artifacts && d.outcome.artifacts.length > 0 && (
            <ul className="space-y-1 text-sm">
              {d.outcome.artifacts.map((a, i) => (
                <li key={i} style={{ color: 'var(--color-text-secondary)' }}>
                  <span className="font-mono text-xs mr-2">{a.kind}</span>
                  {a.ref}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Attempt timeline — populated by the orchestrator event bridge. */}
      {d.attempts_history && d.attempts_history.length > 0 && (
        <AttemptsTimeline attempts={d.attempts_history} turnCount={d.turn_count} />
      )}

      {d.status === 'running' && d.session_ids.length === 0 && (
        <div
          className="rounded-md border p-3 text-xs flex items-start gap-2"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text-muted)',
          }}
        >
          <AlertCircle className="h-4 w-4 mt-0.5" />
          <span>
            The dispatch orchestrator is managing this work. It will retry on failure
            and update the status automatically.
          </span>
        </div>
      )}
    </div>
    </ChatFabContextProvider>
  );
}
