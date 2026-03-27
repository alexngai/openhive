/**
 * TaskGraphSidebar — Node detail panel shown when a graph node is clicked.
 */

import { X, CheckCircle2, PlayCircle, AlertTriangle, XCircle, Circle } from 'lucide-react';
import clsx from 'clsx';
import type { OpenTasksGraphNode } from '../../lib/api';

const STATUS_ICONS: Record<string, React.ElementType> = {
  open: Circle,
  in_progress: PlayCircle,
  blocked: AlertTriangle,
  completed: CheckCircle2,
  failed: XCircle,
};

const STATUS_STYLES: Record<string, string> = {
  open: 'text-gray-400',
  in_progress: 'text-blue-400',
  blocked: 'text-red-400',
  completed: 'text-emerald-400',
  failed: 'text-red-400',
};

interface Props {
  node: OpenTasksGraphNode | null;
  onClose: () => void;
}

export function TaskGraphSidebar({ node, onClose }: Props) {
  if (!node) return null;

  const status = node.status || 'open';
  const StatusIcon = STATUS_ICONS[status] || Circle;

  return (
    <div
      className="w-80 shrink-0 overflow-y-auto border-l"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}
    >
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-tight">{node.title || node.id}</h3>
          <button onClick={onClose} className="btn-ghost p-1 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Status badge */}
        <div className="flex items-center gap-2">
          <StatusIcon className={clsx('w-4 h-4', STATUS_STYLES[status])} />
          <span className="text-xs capitalize">{status.replace('_', ' ')}</span>
          {node.priority != null && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
              P{node.priority}
            </span>
          )}
        </div>

        {/* Description */}
        {node.description && (
          <div>
            <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Description
            </div>
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              {node.description}
            </p>
          </div>
        )}

        {/* Metadata */}
        <div>
          <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
            Details
          </div>
          <div className="space-y-1">
            <DetailRow label="ID" value={node.id} mono />
            <DetailRow label="Type" value={node.type} />
            {node.created_at && (
              <DetailRow label="Created" value={new Date(node.created_at).toLocaleString()} />
            )}
            {node.updated_at && (
              <DetailRow label="Updated" value={new Date(node.updated_at).toLocaleString()} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span className={clsx('truncate', mono && 'font-mono text-2xs')}>{value}</span>
    </div>
  );
}
