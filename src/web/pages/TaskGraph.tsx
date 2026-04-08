/**
 * TaskGraph Page — Full-screen task viewer for OpenTasks resources.
 *
 * Supports two views:
 * - Graph: sigma.js DAG visualization
 * - Board: Kanban column layout by status
 */

import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Network, LayoutGrid } from 'lucide-react';
import clsx from 'clsx';
import { useResource } from '../hooks/useApi';
import { useTaskGraph, STATUS_COLORS } from '../components/task-graph/useTaskGraph';
import { TaskGraphViewer } from '../components/task-graph/TaskGraphViewer';
import { TaskKanban } from '../components/task-graph/TaskKanban';
import { CreateTaskForm } from '../components/task-graph/CreateTaskForm';
import { CreateContextForm } from '../components/task-graph/CreateContextForm';
import { TaskFilterBar, DEFAULT_FILTERS, type TaskFilters } from '../components/task-graph/TaskFilterBar';
import { useTasksRealtime } from '../hooks/useMapTasks';

type ViewMode = 'graph' | 'board';

export function TaskGraph() {
  const { resourceId } = useParams<{ resourceId: string }>();
  const [view, setView] = useState<ViewMode>('board');
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_FILTERS);
  const { data: resource, isLoading: resourceLoading } = useResource(resourceId!);
  const { graph, isLoading: graphLoading, summary, nodes: rawNodes, edges: rawEdges } = useTaskGraph(resourceId!);
  useTasksRealtime();

  if (resourceLoading || graphLoading) {
    return (
      <div className="h-full flex items-center justify-center" style={{ backgroundColor: 'var(--color-bg)' }}>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-gray-500/30 animate-pulse" />
          <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading tasks...</span>
        </div>
      </div>
    );
  }

  if (!resource) {
    return (
      <div className="h-full flex items-center justify-center" style={{ backgroundColor: 'var(--color-bg)' }}>
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Resource not found</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--color-bg)' }}>
      {/* Header bar */}
      <div
        className="flex items-center gap-3 px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}
      >
        <Link to="/tasks" className="btn-ghost p-1">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <span className="text-sm font-semibold truncate">{resource.name}</span>

        {/* View toggle */}
        <div
          className="flex items-center rounded-md border overflow-hidden"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <button
            onClick={() => setView('board')}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1 text-2xs transition-colors',
              view === 'board'
                ? 'bg-honey-500/15 text-honey-500'
                : 'hover:bg-white/5',
            )}
            style={view !== 'board' ? { color: 'var(--color-text-muted)' } : undefined}
          >
            <LayoutGrid className="w-3 h-3" />
            Board
          </button>
          <button
            onClick={() => setView('graph')}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1 text-2xs transition-colors border-l',
              view === 'graph'
                ? 'bg-honey-500/15 text-honey-500'
                : 'hover:bg-white/5',
            )}
            style={{
              borderColor: 'var(--color-border)',
              ...(view !== 'graph' ? { color: 'var(--color-text-muted)' } : {}),
            }}
          >
            <Network className="w-3 h-3" />
            Graph
          </button>
        </div>

        {/* Summary pills */}
        {summary && (
          <div className="ml-auto flex items-center gap-2">
            {Object.entries(summary.task_counts).map(([status, count]) => (
              <span
                key={status}
                className="text-2xs px-1.5 py-0.5 rounded-full flex items-center gap-1"
                style={{ backgroundColor: `${STATUS_COLORS[status] || '#6b7280'}20` }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: STATUS_COLORS[status] || '#6b7280' }}
                />
                {count}
              </span>
            ))}
            <CreateTaskForm resourceId={resourceId!} />
            <CreateContextForm resourceId={resourceId!} />
          </div>
        )}
      </div>

      {/* Filter bar */}
      <TaskFilterBar filters={filters} onChange={setFilters} />

      {/* View content */}
      <div className="flex-1 min-h-0">
        {view === 'board' ? (
          <TaskKanban resourceId={resourceId!} filters={filters} />
        ) : graph ? (
          <TaskGraphViewer graph={graph} resourceId={resourceId!} edges={rawEdges} allNodes={rawNodes} />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center space-y-2">
              <Network className="w-8 h-8 mx-auto" style={{ color: 'var(--color-text-muted)' }} />
              <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                No task graph data available
              </p>
              <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                Tasks will appear here once added to the OpenTasks graph
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
