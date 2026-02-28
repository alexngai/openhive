import { Circle, CheckCircle2, PlayCircle, AlertTriangle, XCircle, Network, FileText, MessageSquare, Zap } from 'lucide-react';
import { useOpenTasksSummary, useOpenTasksReady } from '../../hooks/useApi';
import clsx from 'clsx';

function StatusPill({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <span className={clsx(
      'text-2xs px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1',
      color,
    )}>
      {count} {label}
    </span>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number }) {
  return (
    <div className="card px-3 py-2 flex items-center gap-2.5">
      <div
        className="w-7 h-7 rounded flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Icon className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
      </div>
      <div>
        <div className="text-sm font-semibold">{value}</div>
        <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
      </div>
    </div>
  );
}

export function OpenTasksSummary({ resourceId }: { resourceId: string }) {
  const { data: summary, isLoading: summaryLoading } = useOpenTasksSummary(resourceId);
  const { data: readyData, isLoading: readyLoading } = useOpenTasksReady(resourceId);

  if (summaryLoading) {
    return (
      <div className="card p-4">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-gray-500/30 animate-pulse" />
          <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading OpenTasks...</span>
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="card p-4">
        <div className="flex items-center gap-2">
          <XCircle className="w-3.5 h-3.5 text-red-400" />
          <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Failed to load OpenTasks data</span>
        </div>
      </div>
    );
  }

  const readyItems = readyData?.items || [];

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Network className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          OpenTasks Graph
        </h3>
        <div className="flex items-center gap-1.5">
          <Circle className={clsx(
            'w-2.5 h-2.5',
            summary.daemon_connected ? 'text-emerald-400 fill-emerald-400' : 'text-gray-500 fill-gray-500'
          )} />
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {summary.daemon_connected ? 'Daemon connected' : 'Daemon offline'}
          </span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard icon={FileText} label="Nodes" value={summary.node_count} />
        <StatCard icon={Network} label="Edges" value={summary.edge_count} />
        <StatCard icon={MessageSquare} label="Contexts" value={summary.context_count} />
        <StatCard icon={Zap} label="Ready" value={summary.ready_count} />
      </div>

      {/* Task Status Breakdown */}
      <div className="card p-3">
        <div className="text-2xs font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
          Task Status
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label="open" count={summary.task_counts.open} color="bg-blue-500/10 text-blue-400" />
          <StatusPill label="in progress" count={summary.task_counts.in_progress} color="bg-amber-500/10 text-amber-400" />
          <StatusPill label="blocked" count={summary.task_counts.blocked} color="bg-red-500/10 text-red-400" />
          <StatusPill label="closed" count={summary.task_counts.closed} color="bg-emerald-500/10 text-emerald-400" />
        </div>
      </div>

      {/* Ready Tasks List */}
      {!readyLoading && readyItems.length > 0 && (
        <div className="card p-3">
          <div className="text-2xs font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
            Ready to Work ({readyItems.length})
          </div>
          <div className="space-y-1.5">
            {readyItems.slice(0, 10).map((task) => (
              <div key={task.id} className="flex items-center gap-2 text-xs">
                {task.status === 'open' ? (
                  <PlayCircle className="w-3 h-3 text-blue-400 shrink-0" />
                ) : task.status === 'blocked' ? (
                  <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                )}
                <span className="truncate">{task.title}</span>
                {task.priority != null && task.priority <= 1 && (
                  <span className="text-2xs px-1 py-0.5 rounded bg-red-500/10 text-red-400 shrink-0">
                    P{task.priority}
                  </span>
                )}
                <span className="text-2xs font-mono ml-auto shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                  {task.id}
                </span>
              </div>
            ))}
            {readyItems.length > 10 && (
              <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                +{readyItems.length - 10} more
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
