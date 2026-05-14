import { Loader2, CheckCircle2, XCircle, Clock, Ban } from 'lucide-react';
import type { DispatchStatus } from '../../hooks/useDispatch';
import { StatusChip, type StatusTone } from '../common/StatusChip';

const STATUS_MAP: Record<DispatchStatus, { tone: StatusTone; label: string; Icon: React.ElementType; spin?: boolean }> = {
  queued:    { tone: 'neutral', label: 'Queued',    Icon: Clock },
  running:   { tone: 'warning', label: 'Running',   Icon: Loader2, spin: true },
  complete:  { tone: 'success', label: 'Complete',  Icon: CheckCircle2 },
  failed:    { tone: 'danger',  label: 'Failed',    Icon: XCircle },
  cancelled: { tone: 'neutral', label: 'Cancelled', Icon: Ban },
};

interface DispatchStatusChipProps {
  status: DispatchStatus;
  className?: string;
}

export function DispatchStatusChip({ status, className }: DispatchStatusChipProps) {
  const s = STATUS_MAP[status];
  return (
    <StatusChip
      label={s.label}
      tone={s.tone}
      icon={s.Icon}
      spin={s.spin}
      className={className}
    />
  );
}
