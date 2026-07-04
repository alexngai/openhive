import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ShieldCheck, Undo2, Loader2 } from 'lucide-react';
import { useUpdateOpenTaskStatus } from '../../hooks/useApi';
import { toast } from '../../stores/toast';
import type { DispatchLinkedTaskRef } from '../../hooks/useDispatch';

interface OutcomeActionBarProps {
  specResourceId: string;
  specId: string;
  linkedTasks: DispatchLinkedTaskRef[];
  /** Opens the dispatch-validation preset (P5.3). */
  onDispatchValidation: () => void;
}

/**
 * Flow 5 action bar on a completed dispatch's outcome (P5.1). Three inline
 * actions so the user can close the loop without leaving the page:
 *  - Accept & close  → closes every linked opentask
 *  - Dispatch validation → opens the reviewer-role preset (P5.3)
 *  - Send back → jumps to the spec discussion thread to reply / re-dispatch
 */
export function OutcomeActionBar({
  specResourceId,
  specId,
  linkedTasks,
  onDispatchValidation,
}: OutcomeActionBarProps) {
  const navigate = useNavigate();
  const updateTask = useUpdateOpenTaskStatus(specResourceId);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState(false);

  const closeableTasks = linkedTasks.filter((t) => t.resource_id === specResourceId);

  const handleAcceptClose = async () => {
    setClosing(true);
    try {
      await Promise.all(
        closeableTasks.map((t) =>
          updateTask.mutateAsync({ nodeId: t.node_id, status: 'closed' }),
        ),
      );
      setClosed(true);
      setConfirmClose(false);
      toast.success(
        'Accepted & closed',
        closeableTasks.length > 0
          ? `Closed ${closeableTasks.length} linked task${closeableTasks.length === 1 ? '' : 's'}.`
          : 'Marked as accepted.',
      );
    } catch (err) {
      toast.error('Close failed', err instanceof Error ? err.message : String(err));
    } finally {
      setClosing(false);
    }
  };

  const handleSendBack = () => {
    navigate(`/specs/${specResourceId}/${specId}?tab=discussion`);
  };

  return (
    <div
      className="rounded-md border p-3 mb-6"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
        Next step
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* Accept & close */}
        {closed ? (
          <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            Accepted
          </span>
        ) : confirmClose ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {closeableTasks.length > 0
                ? `Close ${closeableTasks.length} linked task${closeableTasks.length === 1 ? '' : 's'}?`
                : 'Accept this outcome?'}
            </span>
            <button
              type="button"
              onClick={handleAcceptClose}
              disabled={closing}
              className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {closing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmClose(false)}
              disabled={closing}
              className="text-xs px-2 py-1 rounded hover:bg-white/5"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmClose(true)}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
          >
            <CheckCircle2 className="h-4 w-4" />
            Accept &amp; close
          </button>
        )}

        {/* Dispatch validation (P5.3 preset) */}
        <button
          type="button"
          onClick={onDispatchValidation}
          className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border hover:bg-white/5"
          style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}
        >
          <ShieldCheck className="h-4 w-4 text-honey-500" />
          Dispatch validation
        </button>

        {/* Send back */}
        <button
          type="button"
          onClick={handleSendBack}
          className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border hover:bg-white/5"
          style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}
        >
          <Undo2 className="h-4 w-4" />
          Send back
        </button>
      </div>
    </div>
  );
}
