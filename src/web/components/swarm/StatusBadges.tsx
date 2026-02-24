import clsx from 'clsx';
import type { HostedSwarm } from '../../lib/api';

export const HOSTED_STATE_STYLES: Record<HostedSwarm['state'], { label: string; bg: string; text: string }> = {
  running:      { label: 'Running',      bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  starting:     { label: 'Starting',     bg: 'bg-amber-500/10',   text: 'text-amber-400' },
  provisioning: { label: 'Provisioning', bg: 'bg-amber-500/10',   text: 'text-amber-400' },
  unhealthy:    { label: 'Unhealthy',    bg: 'bg-orange-500/10',  text: 'text-orange-400' },
  stopping:     { label: 'Stopping',     bg: 'bg-gray-500/10',    text: 'text-gray-400' },
  stopped:      { label: 'Stopped',      bg: 'bg-gray-500/10',    text: 'text-gray-400' },
  failed:       { label: 'Failed',       bg: 'bg-red-500/10',     text: 'text-red-400' },
};

export const MAP_STATUS_STYLES: Record<string, { label: string; bg: string; text: string }> = {
  online:      { label: 'Online',      bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  offline:     { label: 'Offline',     bg: 'bg-gray-500/10',    text: 'text-gray-400' },
  unreachable: { label: 'Unreachable', bg: 'bg-red-500/10',     text: 'text-red-400' },
};

export function HostedStateBadge({ state }: { state: HostedSwarm['state'] }) {
  const style = HOSTED_STATE_STYLES[state] || HOSTED_STATE_STYLES.stopped;
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium', style.bg, style.text)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', state === 'running' ? 'bg-emerald-400 animate-pulse' : 'bg-current opacity-50')} />
      {style.label}
    </span>
  );
}

export function MapStatusBadge({ status }: { status: string }) {
  const style = MAP_STATUS_STYLES[status] || MAP_STATUS_STYLES.offline;
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium', style.bg, style.text)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', status === 'online' ? 'bg-emerald-400 animate-pulse' : 'bg-current opacity-50')} />
      {style.label}
    </span>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
      {children}
    </label>
  );
}
