import { Loader2, CheckCircle2, XCircle, Clock, Ban } from 'lucide-react';
import clsx from 'clsx';
import type { DispatchStatus } from '../../hooks/useDispatch';
import { StatusChip, type StatusTone } from '../common/StatusChip';

const ORDER: DispatchStatus[] = ['running', 'queued', 'complete', 'failed', 'cancelled'];

const META: Record<DispatchStatus, { tone: StatusTone; label: string; Icon: React.ElementType; spin?: boolean }> = {
  running:   { tone: 'warning', label: 'running',   Icon: Loader2, spin: true },
  queued:    { tone: 'info',    label: 'queued',    Icon: Clock },
  complete:  { tone: 'success', label: 'complete',  Icon: CheckCircle2 },
  failed:    { tone: 'danger',  label: 'failed',    Icon: XCircle },
  cancelled: { tone: 'neutral', label: 'cancelled', Icon: Ban },
};

export interface DispatchRollupCounts {
  total: number;
  active: number;
  counts: Record<DispatchStatus, number>;
  /** True when there's at least one dispatch and none are still queued/running. */
  settled: boolean;
  /** True when every dispatch is complete (the "spec is done" signal). */
  allComplete: boolean;
}

/** Pure aggregation over a list of dispatch statuses — no schema/data fetch. */
export function rollupDispatchStatuses(items: Array<{ status: DispatchStatus }>): DispatchRollupCounts {
  const counts: Record<DispatchStatus, number> = {
    queued: 0,
    running: 0,
    complete: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  const total = items.length;
  const active = counts.queued + counts.running;
  return {
    total,
    active,
    counts,
    settled: total > 0 && active === 0,
    allComplete: total > 0 && counts.complete === total,
  };
}

interface DispatchRollupProps {
  items: Array<{ status: DispatchStatus }>;
  /** `sm` (compact, default) or `md`. */
  size?: 'sm' | 'md';
  className?: string;
  /** Show a leading "N/M done" summary before the per-status chips. */
  showSummary?: boolean;
}

/**
 * Status tally chips over a spec's dispatch rows — the "is this spec done?"
 * glance surface (P4.3). Renders one chip per non-zero status.
 */
export function DispatchRollup({ items, size = 'sm', className, showSummary }: DispatchRollupProps) {
  if (items.length === 0) return null;
  const roll = rollupDispatchStatuses(items);

  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5', className)}>
      {showSummary && (
        <span
          className={clsx('font-medium', size === 'sm' ? 'text-2xs' : 'text-xs')}
          style={{ color: roll.allComplete ? 'var(--color-text)' : 'var(--color-text-muted)' }}
          title={roll.settled ? 'All dispatches settled' : `${roll.active} still in flight`}
        >
          {roll.counts.complete}/{roll.total} done
        </span>
      )}
      {ORDER.filter((s) => roll.counts[s] > 0).map((s) => {
        const m = META[s];
        return (
          <StatusChip
            key={s}
            label={`${roll.counts[s]} ${m.label}`}
            tone={m.tone}
            icon={m.Icon}
            spin={m.spin}
            size={size}
            title={`${roll.counts[s]} ${m.label}`}
          />
        );
      })}
    </div>
  );
}
