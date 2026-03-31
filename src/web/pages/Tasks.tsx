/**
 * Tasks Page — Lists all OpenTasks resources with summaries.
 */

import { Link } from 'react-router-dom';
import {
  ListTodo, Network, ChevronRight, Clock, AlertTriangle,
  CheckCircle2, Activity, XCircle, Zap,
} from 'lucide-react';
import { useResourcesByType, useOpenTasksSummary } from '../hooks/useApi';
import { useTasksRealtime } from '../hooks/useMapTasks';
import { useResourcesRealtime } from '../hooks/useRealtimeInvalidation';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import type { SyncableResource } from '../lib/api';

// ============================================================================
// Status styling
// ============================================================================

const TASK_STATUS_STYLES: Record<string, { bg: string; text: string; icon: React.ElementType }> = {
  open:        { bg: 'bg-blue-500/10',    text: 'text-blue-400',    icon: ListTodo },
  in_progress: { bg: 'bg-amber-500/10',   text: 'text-amber-400',   icon: Activity },
  blocked:     { bg: 'bg-red-500/10',      text: 'text-red-400',     icon: AlertTriangle },
  completed:   { bg: 'bg-emerald-500/10',  text: 'text-emerald-400', icon: CheckCircle2 },
  closed:      { bg: 'bg-emerald-500/10',  text: 'text-emerald-400', icon: CheckCircle2 },
  failed:      { bg: 'bg-red-500/10',      text: 'text-red-400',     icon: XCircle },
};

// ============================================================================
// Task Resource Card (persistent OpenTasks graphs)
// ============================================================================

function TaskResourceCard({ resource }: { resource: SyncableResource }) {
  const { data: summary } = useOpenTasksSummary(resource.id);
  const meta = resource.metadata as Record<string, unknown> | null;
  const counts = summary?.task_counts;

  return (
    <Link
      to={`/tasks/${resource.id}`}
      className="card card-hover p-4 flex items-start gap-4 group"
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Network className="w-5 h-5 text-honey-500" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
            {resource.name}
          </h3>
          {summary?.daemon_connected && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Daemon connected" />
          )}
        </div>

        {resource.description && (
          <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {resource.description}
          </p>
        )}

        {/* Status counts row */}
        {counts && (
          <div className="flex items-center gap-3 mt-2">
            {Object.entries(counts).map(([status, count]) => {
              if (!count) return null;
              const style = TASK_STATUS_STYLES[status] ?? TASK_STATUS_STYLES.open;
              const Icon = style.icon;
              return (
                <span
                  key={status}
                  className={`text-2xs px-1.5 py-0.5 rounded flex items-center gap-1 ${style.bg} ${style.text}`}
                >
                  <Icon className="w-3 h-3" />
                  {count} {status.replace('_', ' ')}
                </span>
              );
            })}
          </div>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-3 mt-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {typeof meta?.node_count === 'number' && (
            <span className="flex items-center gap-1">
              <Network className="w-3 h-3" />
              {meta.node_count} nodes
            </span>
          )}
          {typeof meta?.edge_count === 'number' && (
            <span className="flex items-center gap-1">
              <Zap className="w-3 h-3" />
              {meta.edge_count} edges
            </span>
          )}
          {resource.last_push_at && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <TimeAgo date={resource.last_push_at} />
            </span>
          )}
        </div>
      </div>

      <ChevronRight
        className="w-4 h-4 shrink-0 mt-1 opacity-0 group-hover:opacity-50 transition-opacity"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </Link>
  );
}

// ============================================================================
// Tasks Page
// ============================================================================

export function Tasks() {
  // Persistent OpenTasks resources
  const { data: resourcesData, isLoading: resourcesLoading } = useResourcesByType('task');
  useResourcesRealtime();
  useTasksRealtime();

  const resources = resourcesData?.data || [];

  if (resourcesLoading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-lg font-bold">Tasks</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
          Task graphs from OpenTasks resources.
        </p>
      </div>

      {/* OpenTasks resources section */}
      <section>
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Network className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          Task Graphs
          {resources.length > 0 && (
            <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
              {resources.length} resource{resources.length !== 1 ? 's' : ''}
            </span>
          )}
        </h2>

        {resources.length === 0 ? (
          <div className="card p-8 text-center">
            <Network className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              No task graphs yet
            </p>
            <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              OpenTasks resources will appear here when discovered or registered by connected swarms.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {resources.map((resource) => (
              <TaskResourceCard key={resource.id} resource={resource} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
