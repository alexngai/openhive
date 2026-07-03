import { Loader2, CheckCircle2, XCircle, Clock, Ban, ListChecks } from 'lucide-react';
import clsx from 'clsx';
import type { DispatchStatus } from '../../hooks/useDispatch';
import { StatusChip, type StatusTone } from '../common/StatusChip';

const ORDER: DispatchStatus[] = ['running', 'queued', 'complete', 'failed', 'cancelled'];

/** OpenTasks statuses that count as "done" for the linked-task rollup. */
const TASK_DONE_STATUSES = new Set(['closed', 'done', 'complete', 'completed', 'resolved']);

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

export interface TaskRollupCounts {
  total: number;
  done: number;
  /** True when there's at least one linked task and every one is done. */
  allDone: boolean;
}

/**
 * Pure aggregation over linked-task statuses (P4.3). A dispatch can complete
 * while its task stays open, so this is a distinct, complementary "done"
 * signal from the dispatch rollup. Case-insensitive; unknown statuses count as
 * not-done.
 */
export function rollupTaskStatuses(
  tasks: Array<{ status?: string | null }>,
): TaskRollupCounts {
  let done = 0;
  for (const t of tasks) {
    if (t.status && TASK_DONE_STATUSES.has(t.status.toLowerCase())) done += 1;
  }
  const total = tasks.length;
  return { total, done, allDone: total > 0 && done === total };
}

interface DispatchRollupProps {
  items: Array<{ status: DispatchStatus }>;
  /**
   * Optional linked tasks. When provided (and non-empty), a task-completion
   * chip ("N/M tasks") is appended so the rollup reflects real work-item
   * progress, not just dispatch execution status (P4.3). Dispatch status stays
   * the primary signal.
   */
  tasks?: Array<{ status?: string | null }>;
  /** `sm` (compact, default) or `md`. */
  size?: 'sm' | 'md';
  className?: string;
  /** Show a leading "N/M done" summary before the per-status chips. */
  showSummary?: boolean;
}

/**
 * Status tally chips over a spec's dispatch rows — the "is this spec done?"
 * glance surface (P4.3). Renders one chip per non-zero dispatch status, plus an
 * optional linked-task completion chip when `tasks` is supplied.
 */
export function DispatchRollup({ items, tasks, size = 'sm', className, showSummary }: DispatchRollupProps) {
  const taskRoll = tasks && tasks.length > 0 ? rollupTaskStatuses(tasks) : null;
  if (items.length === 0 && !taskRoll) return null;
  const roll = rollupDispatchStatuses(items);

  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5', className)}>
      {showSummary && roll.total > 0 && (
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
      {taskRoll && (
        <StatusChip
          label={`${taskRoll.done}/${taskRoll.total} tasks`}
          tone={taskRoll.allDone ? 'success' : 'neutral'}
          icon={ListChecks}
          size={size}
          title={
            taskRoll.allDone
              ? 'All linked tasks done'
              : `${taskRoll.total - taskRoll.done} linked task(s) still open`
          }
        />
      )}
    </div>
  );
}
