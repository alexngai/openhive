/**
 * TaskDetail Page — full-page view of a single OpenTasks task node.
 *
 * Loads the task graph for the resource (same data source as TaskGraph) and
 * selects the node by id. Shows header (title, status, meta), description,
 * and a CascadeBlock with the commit range + changelog bound to this task.
 */

import { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  ClipboardList,
  Clock,
  User,
  Tag,
  AlertCircle,
} from 'lucide-react';
import {
  useResource,
  useOpenTasksGraph,
} from '../hooks/useApi';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { CascadeBlock } from '../components/CascadeBlock';

export function TaskDetail() {
  const { resourceId, nodeId } = useParams<{ resourceId: string; nodeId: string }>();
  const { data: resource, isLoading: resourceLoading } = useResource(resourceId!);
  const { data: graph, isLoading: graphLoading, error: graphError } = useOpenTasksGraph(
    resourceId!,
  );

  // Resolve the target node from the graph (lightweight — opentasks doesn't
  // expose a direct single-node fetch today, and graphs are typically small)
  const node = useMemo(() => {
    if (!graph || !nodeId) return undefined;
    return graph.nodes.find((n) => n.id === nodeId);
  }, [graph, nodeId]);

  const isLoading = resourceLoading || graphLoading;

  if (isLoading) return <PageLoader />;

  if (!resource || !resourceId || !nodeId) {
    return <TaskNotFound resourceId={resourceId} />;
  }

  if (graphError) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <TaskBackLink resourceId={resourceId} />
        <div className="card p-6 text-center">
          <AlertCircle
            className="w-6 h-6 mx-auto mb-2"
            style={{ color: 'var(--color-text-muted)' }}
          />
          <p
            className="text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Failed to load task graph: {(graphError as Error).message}
          </p>
          {/* Cascade data may still be available even if the graph isn't */}
          <div className="mt-6 text-left">
            <CascadeBlock resourceId={resourceId} nodeId={nodeId} />
          </div>
        </div>
      </div>
    );
  }

  const taskTitle = node?.title ?? nodeId;
  const taskSubtitle = node?.description ?? undefined;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      {/* Header */}
      <div>
        <TaskBackLink resourceId={resourceId} />

        <div className="flex items-start gap-3 mt-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'var(--color-elevated)' }}
          >
            <ClipboardList className="w-5 h-5 text-honey-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold">{taskTitle}</h1>
            {!node && (
              <p
                className="text-xs mt-0.5"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Task node <code>{nodeId}</code> not found in graph — showing cascade data only.
              </p>
            )}
            {node?.description && (
              <p
                className="text-xs mt-1 whitespace-pre-wrap"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {node.description}
              </p>
            )}
          </div>
        </div>

        {/* Meta pills */}
        {node && (
          <div
            className="flex items-center gap-3 mt-3 text-2xs flex-wrap"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {node.status && (
              <span className="flex items-center gap-1">
                <Tag className="w-3 h-3" />
                {node.status}
              </span>
            )}
            {node.assignee && (
              <span className="flex items-center gap-1">
                <User className="w-3 h-3" />
                {node.assignee}
              </span>
            )}
            {node.updated_at && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                updated <TimeAgo date={node.updated_at} />
              </span>
            )}
            <span className="flex items-center gap-1" title="OpenTasks graph resource">
              in <Link to={`/tasks?resource=${resourceId}`} className="hover:text-honey-500 transition-colors">{resource.name}</Link>
            </span>
          </div>
        )}
      </div>

      {/* Cascade: commit range + changelog bound to this task */}
      <CascadeBlock
        resourceId={resourceId}
        nodeId={nodeId}
        taskTitle={taskTitle}
        taskSubtitle={taskSubtitle}
      />
    </div>
  );
}

function TaskBackLink({ resourceId }: { resourceId: string }) {
  return (
    <Link
      to={`/tasks?resource=${resourceId}`}
      className="flex items-center gap-1 text-xs hover:text-honey-500 transition-colors"
      style={{ color: 'var(--color-text-muted)' }}
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      Back to tasks
    </Link>
  );
}

function TaskNotFound({ resourceId }: { resourceId: string | undefined }) {
  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <Link
        to={resourceId ? `/tasks?resource=${resourceId}` : '/tasks'}
        className="flex items-center gap-1 text-xs mb-4 hover:text-honey-500 transition-colors"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to tasks
      </Link>
      <div className="card p-8 text-center">
        <p
          className="text-sm"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Task resource not found
        </p>
      </div>
    </div>
  );
}
