import clsx from 'clsx';
import { Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useMapSwarms } from '../../hooks/useApi';
import type { MapSwarm } from '../../lib/api';

export type SwarmChipSize = 'sm' | 'md';

const STATUS_RING: Record<MapSwarm['status'], string> = {
  online:      'bg-emerald-400 animate-pulse',
  offline:     'bg-gray-500 opacity-60',
  unreachable: 'bg-amber-400',
};

const STATUS_TEXT: Record<MapSwarm['status'], string> = {
  online:      'text-emerald-400',
  offline:     'text-gray-400',
  unreachable: 'text-amber-400',
};

const SIZE_STYLES: Record<SwarmChipSize, { chip: string; dot: string; icon: string }> = {
  sm: { chip: 'text-2xs px-1.5 py-0.5 gap-1',    dot: 'w-1.5 h-1.5', icon: 'w-2.5 h-2.5' },
  md: { chip: 'text-xs px-2 py-0.5 gap-1.5',     dot: 'w-2 h-2',     icon: 'w-3 h-3' },
};

/**
 * Resolve an assignee string to a known MapSwarm.
 * Matches by id first (exact), then by name (case-insensitive).
 */
export function resolveAssigneeSwarm(
  assignee: string | null | undefined,
  swarms: MapSwarm[] | undefined,
): MapSwarm | null {
  if (!assignee || !swarms?.length) return null;
  const needle = assignee.trim();
  if (!needle) return null;
  const byId = swarms.find(s => s.id === needle);
  if (byId) return byId;
  const lower = needle.toLowerCase();
  const byName = swarms.find(s => s.name.toLowerCase() === lower);
  return byName ?? null;
}

interface SwarmChipProps {
  assignee: string | null | undefined;
  size?: SwarmChipSize;
  /** When true, renders as a link to the swarm detail page. */
  linkToSwarm?: boolean;
  /** Show nothing when the assignee is empty (default: true). */
  hideEmpty?: boolean;
  className?: string;
}

/**
 * Badge that resolves an assignee string to a known swarm and shows
 * its online status. Falls back to a plain `@handle` badge for non-swarm
 * assignees (humans, external agents).
 */
export function SwarmChip({
  assignee,
  size = 'sm',
  linkToSwarm = false,
  hideEmpty = true,
  className,
}: SwarmChipProps) {
  const { data: swarms } = useMapSwarms();
  const swarm = resolveAssigneeSwarm(assignee, swarms);
  const sizeStyle = SIZE_STYLES[size];

  if (!assignee?.trim()) {
    if (hideEmpty) return null;
    return (
      <span
        className={clsx('inline-flex items-center rounded font-medium', sizeStyle.chip, className)}
        style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
      >
        Unassigned
      </span>
    );
  }

  if (!swarm) {
    return (
      <span
        className={clsx('inline-flex items-center rounded font-medium', sizeStyle.chip, className)}
        style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
        title={`Assignee: ${assignee}`}
      >
        @{assignee}
      </span>
    );
  }

  const content = (
    <>
      <Zap className={clsx(sizeStyle.icon, STATUS_TEXT[swarm.status])} />
      <span className={clsx('truncate max-w-[120px]', STATUS_TEXT[swarm.status])}>
        {swarm.name}
      </span>
      <span className={clsx('rounded-full shrink-0', sizeStyle.dot, STATUS_RING[swarm.status])} />
    </>
  );

  const titleText = `${swarm.name} · ${swarm.status}`;
  const chipClass = clsx(
    'inline-flex items-center rounded font-medium',
    sizeStyle.chip,
    className,
  );

  if (linkToSwarm) {
    return (
      <Link
        to={`/swarms/${swarm.id}`}
        className={clsx(chipClass, 'transition-colors')}
        style={{ backgroundColor: 'var(--color-elevated)' }}
        title={titleText}
      >
        {content}
      </Link>
    );
  }

  return (
    <span className={chipClass} style={{ backgroundColor: 'var(--color-elevated)' }} title={titleText}>
      {content}
    </span>
  );
}
