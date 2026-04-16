/**
 * Shared stream UI primitives used across List, Stack, DAG, and Sidebar views.
 */

import type { StreamTimelineEvent } from '../../hooks/useApi';
import { TimeAgo } from '../common/TimeAgo';
import {
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequestDraft,
  AlertTriangle,
  FileText,
} from 'lucide-react';

export const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e',
  paused: '#f59e0b',
  merged: '#6b7280',
  abandoned: '#6b7280',
  conflicted: 'var(--color-danger)',
};

export const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  merged: 'Merged',
  abandoned: 'Abandoned',
  conflicted: 'Conflicted',
};

export function StreamStatusDot({ status }: { status: string }) {
  return (
    <div
      className="w-2 h-2 rounded-full shrink-0"
      style={{ backgroundColor: STATUS_COLORS[status] ?? 'var(--color-text-muted)' }}
      title={STATUS_LABELS[status] ?? status}
    />
  );
}

export function TimelineEntry({ event }: { event: StreamTimelineEvent }) {
  const d = event.data;
  const iconProps = { className: 'w-3 h-3 shrink-0 mt-0.5' };

  switch (event.type) {
    case 'commit':
      return (
        <div className="flex gap-2 py-1.5 border-l-2 pl-2 ml-1" style={{ borderColor: '#22c55e' }}>
          <GitCommit {...iconProps} style={{ color: '#22c55e' }} />
          <div className="min-w-0 text-2xs">
            <div className="truncate">{d.message_summary as string}</div>
            <div className="flex items-center gap-2 mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              <code className="font-mono">{(d.commit_hash as string)?.slice(0, 7)}</code>
              {d.author_agent_id && <span>{d.author_agent_id as string}</span>}
              <TimeAgo date={event.timestamp} />
            </div>
          </div>
        </div>
      );

    case 'merge':
      return (
        <div className="flex gap-2 py-1.5 border-l-2 pl-2 ml-1" style={{ borderColor: '#8b5cf6' }}>
          <GitMerge {...iconProps} style={{ color: '#8b5cf6' }} />
          <div className="min-w-0 text-2xs">
            <div>
              <span style={{ color: 'var(--color-text-muted)' }}>Merged </span>
              <code className="font-mono">{(d.source_stream_id as string)?.slice(0, 8)}</code>
              <span style={{ color: 'var(--color-text-muted)' }}> into </span>
              <code className="font-mono">{(d.target_stream_id as string)?.slice(0, 8)}</code>
            </div>
            <div className="mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              <TimeAgo date={event.timestamp} />
            </div>
          </div>
        </div>
      );

    case 'conflict_detected':
      return (
        <div className="flex gap-2 py-1.5 border-l-2 pl-2 ml-1" style={{ borderColor: 'var(--color-danger)' }}>
          <AlertTriangle {...iconProps} style={{ color: 'var(--color-danger)' }} />
          <div className="min-w-0 text-2xs">
            <div style={{ color: 'var(--color-danger)' }}>Conflict detected</div>
            <div className="mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              Files: {(d.conflicted_files as string[])?.join(', ')}
            </div>
            <div className="mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              <TimeAgo date={event.timestamp} />
            </div>
          </div>
        </div>
      );

    case 'conflict_resolved':
      return (
        <div className="flex gap-2 py-1.5 border-l-2 pl-2 ml-1" style={{ borderColor: '#22c55e' }}>
          <GitPullRequestDraft {...iconProps} style={{ color: '#22c55e' }} />
          <div className="min-w-0 text-2xs">
            <div>Conflict resolved</div>
            <div className="mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              <TimeAgo date={event.timestamp} />
            </div>
          </div>
        </div>
      );

    case 'push':
      return (
        <div className="flex gap-2 py-1.5 border-l-2 pl-2 ml-1" style={{ borderColor: '#3b82f6' }}>
          <GitBranch {...iconProps} style={{ color: '#3b82f6' }} />
          <div className="min-w-0 text-2xs">
            <div>
              <span style={{ color: 'var(--color-text-muted)' }}>Pushed to </span>
              {d.remote_ref as string}
            </div>
            <div className="mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              <TimeAgo date={event.timestamp} />
            </div>
          </div>
        </div>
      );

    default:
      return (
        <div className="flex gap-2 py-1.5 border-l-2 pl-2 ml-1" style={{ borderColor: 'var(--color-border)' }}>
          <FileText {...iconProps} style={{ color: 'var(--color-text-muted)' }} />
          <div className="min-w-0 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <div>{event.type}</div>
            <TimeAgo date={event.timestamp} />
          </div>
        </div>
      );
  }
}
