/**
 * Attempts Timeline — per-attempt retry/success/failure history.
 *
 * Rendered on DispatchDetail. Replaces the flat "Attempts: N / Turns: M"
 * row with a stacked list of attempt records plus a live "next retry in
 * Xs" countdown when the orchestrator has scheduled a retry.
 *
 * The data is driven by `attempts_history` on the Dispatch record, which
 * the orchestrator event bridge writes on `dispatched`, `retrying`,
 * `completed`, and `dead` events.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, Clock, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { TimeAgo } from '../common/TimeAgo';
import type { DispatchAttempt } from '../../hooks/useDispatch';

interface AttemptsTimelineProps {
  attempts: DispatchAttempt[];
  turnCount?: number;
}

function StatusIcon({ status }: { status: DispatchAttempt['status'] }) {
  const base = 'h-4 w-4 shrink-0';
  switch (status) {
    case 'completed':
      return <CheckCircle2 className={clsx(base, 'text-emerald-400')} />;
    case 'failed':
      return <AlertTriangle className={clsx(base, 'text-red-400')} />;
    case 'retrying':
      return <RefreshCw className={clsx(base, 'text-amber-400')} />;
    case 'running':
    default:
      return <Loader2 className={clsx(base, 'animate-spin text-honey-400')} />;
  }
}

function durationBetween(start: string, end?: string): string | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function NextRetryCountdown({ nextRetryAt }: { nextRetryAt: string }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.round((new Date(nextRetryAt).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const tick = () => {
      setRemaining(
        Math.max(0, Math.round((new Date(nextRetryAt).getTime() - Date.now()) / 1000)),
      );
    };
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [nextRetryAt]);

  if (remaining <= 0) {
    return <span>retry scheduled</span>;
  }
  return <span>next retry in {remaining}s</span>;
}

export function AttemptsTimeline({ attempts, turnCount }: AttemptsTimelineProps) {
  if (attempts.length === 0) {
    return null;
  }

  return (
    <div
      className="rounded-md border p-4 mb-6"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Orchestrator progress
        </div>
        {turnCount != null && turnCount > 0 && (
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {turnCount} turn{turnCount === 1 ? '' : 's'}
          </div>
        )}
      </div>

      <ol className="space-y-2">
        {attempts.map((a) => {
          const duration = durationBetween(a.started_at, a.ended_at);
          return (
            <li
              key={a.attempt}
              className="flex items-start gap-3 text-sm"
              style={{ color: 'var(--color-text)' }}
            >
              <StatusIcon status={a.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">Attempt {a.attempt}</span>
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    · <TimeAgo date={a.started_at} />
                  </span>
                  {duration && (
                    <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      · {duration}
                    </span>
                  )}
                </div>
                {a.error && (
                  <div
                    className="mt-1 text-xs font-mono whitespace-pre-wrap break-words"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {a.error}
                  </div>
                )}
                {a.status === 'retrying' && a.next_retry_at && (
                  <div
                    className="mt-1 inline-flex items-center gap-1 text-xs"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <Clock className="h-3 w-3" />
                    <NextRetryCountdown nextRetryAt={a.next_retry_at} />
                  </div>
                )}
                {a.session_id && (
                  <div className="mt-1 text-xs font-mono" style={{ color: 'var(--color-text-secondary)' }}>
                    session {a.session_id}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
