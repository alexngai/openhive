import { useState } from 'react';
import { AlertTriangle, Ban, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import {
  useDispatchPolicy,
  useUpdateDispatchPolicy,
} from '../../hooks/useDispatches';

interface DispatchPolicyCardProps {
  /** Hide the card entirely for non-admins. */
  isAdmin: boolean;
}

/**
 * Admin-only kill switch for autonomous (agent-initiated) dispatch.
 *
 * Backed by `GET/POST /admin/dispatch-policy` (Stream 2 D9 retrofit path).
 * When paused, agent-initiated dispatches via `map/specs/dispatch` return
 * -32004; user-initiated REST dispatches keep working. State is in-memory
 * on the hub — restarts default it back to "not paused."
 */
export function DispatchPolicyCard({ isAdmin }: DispatchPolicyCardProps) {
  const { data, isLoading, error } = useDispatchPolicy();
  const update = useUpdateDispatchPolicy();
  const [actionError, setActionError] = useState<string | null>(null);

  if (!isAdmin) return null;

  const paused = data?.autonomous_dispatch_paused ?? false;

  const toggle = async () => {
    setActionError(null);
    try {
      await update.mutateAsync(!paused);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: paused ? 'rgba(239, 68, 68, 0.4)' : 'var(--color-border-subtle)',
        backgroundColor: paused ? 'rgba(239, 68, 68, 0.05)' : 'var(--color-surface)',
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className={clsx(
            'mt-0.5 rounded-full p-1.5 shrink-0',
            paused ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/10 text-emerald-400',
          )}
        >
          {paused ? <Ban className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            Autonomous dispatch
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {paused
              ? 'Paused — agent-initiated dispatches via MAP are blocked. User dispatches via the UI still work.'
              : 'Live — any registered MAP agent can call `map/specs/dispatch`. Pause this if autonomous chains get rowdy.'}
          </p>

          {error && (
            <div
              className="mt-2 text-xs flex items-center gap-1"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <AlertTriangle className="w-3 h-3" />
              Failed to load policy: {error instanceof Error ? error.message : String(error)}
            </div>
          )}

          {actionError && (
            <div
              className="mt-2 text-xs flex items-center gap-1"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <AlertTriangle className="w-3 h-3" />
              {actionError}
            </div>
          )}

          <div className="mt-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            State is in-memory; a hub restart resets to <em>live</em>.
          </div>
        </div>

        <button
          type="button"
          onClick={toggle}
          disabled={isLoading || update.isPending}
          className={clsx(
            'shrink-0 px-3 py-1.5 rounded text-xs font-medium border transition-colors disabled:opacity-50',
            paused
              ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
              : 'border-red-500/40 text-red-300 hover:bg-red-500/10',
          )}
        >
          {update.isPending ? '…' : paused ? 'Resume' : 'Pause'}
        </button>
      </div>
    </div>
  );
}
