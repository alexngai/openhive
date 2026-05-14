import type { ElementType } from 'react';
import clsx from 'clsx';

/**
 * Semantic tone for a status chip. Each tone maps to a fixed bg+text palette
 * so all status indicators across the app share one visual vocabulary.
 *
 * Map your domain status to a tone in a small typed function next to the data
 * (e.g. `dispatchStatusToTone(status)`) — don't add domain enums here.
 */
export type StatusTone =
  | 'success'  // green   — running healthy, complete, online, live
  | 'warning'  // amber   — running in-progress, recent, paused-recoverable
  | 'danger'   // red     — failed, blocked, error
  | 'info'     // blue    — open, queued, scheduled
  | 'neutral'  // gray    — idle, closed, stale, cancelled
  | 'accent';  // honey   — featured / primary highlight

const TONE_CLS: Record<StatusTone, string> = {
  success: 'bg-emerald-500/10 text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-400',
  danger:  'bg-red-500/10 text-red-400',
  info:    'bg-blue-500/10 text-blue-400',
  neutral: 'bg-gray-500/10 text-gray-400',
  accent:  'bg-honey-500/15 text-honey-500',
};

interface StatusChipProps {
  label: string;
  tone: StatusTone;
  icon?: ElementType;
  /** Spin the icon (useful for in-flight states). */
  spin?: boolean;
  /** `pill` (rounded-full, default) or `square` (rounded). */
  shape?: 'pill' | 'square';
  /** Visual density. */
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
}

const SIZE_CLS: Record<NonNullable<StatusChipProps['size']>, string> = {
  sm: 'text-2xs px-1.5 py-0.5 gap-1',
  md: 'text-xs px-2 py-0.5 gap-1',
};

const ICON_SIZE: Record<NonNullable<StatusChipProps['size']>, string> = {
  sm: 'w-3 h-3',
  md: 'w-3.5 h-3.5',
};

export function StatusChip({
  label,
  tone,
  icon: Icon,
  spin,
  shape = 'pill',
  size = 'sm',
  className,
  title,
}: StatusChipProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center font-medium',
        shape === 'pill' ? 'rounded-full' : 'rounded',
        SIZE_CLS[size],
        TONE_CLS[tone],
        className,
      )}
      title={title}
    >
      {Icon && <Icon className={clsx(ICON_SIZE[size], spin && 'animate-spin')} />}
      {label}
    </span>
  );
}

/**
 * A small colored dot — for when you want presence indication without a label.
 * Use the same tone vocabulary so dots and chips stay in sync.
 */
const DOT_TONE: Record<StatusTone, string> = {
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  danger:  'bg-red-400',
  info:    'bg-blue-400',
  neutral: 'bg-gray-500',
  accent:  'bg-honey-500',
};

interface StatusDotProps {
  tone: StatusTone;
  size?: 'xs' | 'sm';
  pulse?: boolean;
  title?: string;
  className?: string;
}

export function StatusDot({ tone, size = 'sm', pulse, title, className }: StatusDotProps) {
  return (
    <span
      className={clsx(
        'inline-block shrink-0 rounded-full',
        size === 'xs' ? 'w-1.5 h-1.5' : 'w-2 h-2',
        DOT_TONE[tone],
        pulse && 'animate-pulse',
        className,
      )}
      title={title}
    />
  );
}
