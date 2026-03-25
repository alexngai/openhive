/**
 * TaskGraph Page — Full-screen task graph viewer for OpenTasks resources.
 *
 * Renders a sigma.js DAG visualization of the task graph, with a sidebar
 * for node details on click. Follows the SwarmCraft embed pattern.
 */

import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Network } from 'lucide-react';
import { useResource } from '../hooks/useApi';
import { useTaskGraph, STATUS_COLORS } from '../components/task-graph/useTaskGraph';
import { TaskGraphViewer } from '../components/task-graph/TaskGraphViewer';
import { CreateTaskForm } from '../components/task-graph/CreateTaskForm';
import { useMapTasksRealtime } from '../hooks/useMapTasks';

export function TaskGraph() {
  const { resourceId } = useParams<{ resourceId: string }>();
  const { data: resource, isLoading: resourceLoading } = useResource(resourceId!);
  const { graph, isLoading: graphLoading, summary } = useTaskGraph(resourceId!);
  useMapTasksRealtime();

  if (resourceLoading || graphLoading) {
    return (
      <div className="h-full flex items-center justify-center" style={{ backgroundColor: 'var(--color-bg)' }}>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-gray-500/30 animate-pulse" />
          <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading task graph...</span>
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
        <Link to={`/resources/${resourceId}`} className="btn-ghost p-1">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <Network className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-sm font-semibold truncate">{resource.name}</span>
        <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Task Graph</span>

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
          </div>
        )}
      </div>

      {/* Graph canvas */}
      <div className="flex-1 min-h-0">
        {graph ? (
          <TaskGraphViewer graph={graph} resourceId={resourceId!} />
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
