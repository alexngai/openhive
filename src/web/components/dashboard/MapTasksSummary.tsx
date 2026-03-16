import { ListTodo, CheckCircle2, Clock, AlertTriangle, XCircle } from 'lucide-react';
import { useMapTasks, useMapTasksSummary, useMapTasksRealtime } from '../../hooks/useMapTasks';
import type { MAPTask } from '../../hooks/useMapTasks';

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  open: { label: 'Open', color: 'text-blue-400', icon: ListTodo },
  in_progress: { label: 'In Progress', color: 'text-amber-400', icon: Clock },
  blocked: { label: 'Blocked', color: 'text-red-400', icon: AlertTriangle },
  completed: { label: 'Completed', color: 'text-emerald-400', icon: CheckCircle2 },
  failed: { label: 'Failed', color: 'text-red-500', icon: XCircle },
};

function StatusBadge({ status }: { status?: string }) {
  const config = STATUS_CONFIG[status ?? 'open'] ?? STATUS_CONFIG.open;
  return (
    <span className={`text-2xs px-1.5 py-0.5 rounded ${config.color}`} style={{ backgroundColor: 'var(--color-elevated)' }}>
      {config.label}
    </span>
  );
}

function TaskRow({ task }: { task: MAPTask }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md">
      <ListTodo className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
      <span className="text-xs truncate flex-1">{task.title || task.id}</span>
      {task.assignee && (
        <span className="text-2xs truncate max-w-[80px]" style={{ color: 'var(--color-text-muted)' }}>
          {task.assignee}
        </span>
      )}
      <StatusBadge status={task.status} />
    </div>
  );
}

export function MapTasksSummary() {
  useMapTasksRealtime();
  const { data: summary } = useMapTasksSummary();
  const { data: tasksData } = useMapTasks({ status: 'open,in_progress,blocked', limit: 8 });

  const tasks = tasksData?.tasks || [];
  const total = summary?.total ?? 0;
  const byStatus = summary?.byStatus ?? {};
  const swarmCount = summary ? Object.keys(summary.bySwarm).length : 0;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>MAP Tasks</h2>
        {total > 0 && (
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {total} total across {swarmCount} swarm{swarmCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Status summary bar */}
      {total > 0 && (
        <div className="flex items-center gap-3 mb-3">
          {Object.entries(byStatus).map(([status, count]) => {
            const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.open;
            const Icon = config.icon;
            return (
              <div key={status} className="flex items-center gap-1">
                <Icon className={`w-3 h-3 ${config.color}`} />
                <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                  {count}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Active tasks list */}
      {tasks.length === 0 ? (
        <p className="text-xs text-center py-4" style={{ color: 'var(--color-text-muted)' }}>
          No active MAP tasks
        </p>
      ) : (
        <div className="space-y-1">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}
