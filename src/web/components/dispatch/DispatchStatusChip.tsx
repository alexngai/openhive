import clsx from 'clsx';
import { Loader2, CheckCircle2, XCircle, Clock, Ban } from 'lucide-react';
import type { DispatchStatus } from '../../hooks/useDispatch';

const STATUS_STYLE: Record<DispatchStatus, { bg: string; text: string; label: string; Icon: React.ElementType }> = {
  queued: { bg: 'bg-slate-500/10', text: 'text-slate-300', label: 'Queued', Icon: Clock },
  running: { bg: 'bg-amber-500/10', text: 'text-amber-300', label: 'Running', Icon: Loader2 },
  complete: { bg: 'bg-emerald-500/10', text: 'text-emerald-300', label: 'Complete', Icon: CheckCircle2 },
  failed: { bg: 'bg-red-500/10', text: 'text-red-300', label: 'Failed', Icon: XCircle },
  cancelled: { bg: 'bg-zinc-500/10', text: 'text-zinc-300', label: 'Cancelled', Icon: Ban },
};

interface DispatchStatusChipProps {
  status: DispatchStatus;
  className?: string;
}

export function DispatchStatusChip({ status, className }: DispatchStatusChipProps) {
  const style = STATUS_STYLE[status];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        style.bg,
        style.text,
        className,
      )}
    >
      <style.Icon className={clsx('h-3 w-3', status === 'running' && 'animate-spin')} />
      {style.label}
    </span>
  );
}
