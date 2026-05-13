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
  MessageCircle,
  Send,
  GitBranch,
} from 'lucide-react';
import {
  useResource,
  useOpenTasksGraph,
  useRepo,
} from '../hooks/useApi';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { CascadeBlock } from '../components/CascadeBlock';
import { usePageContext } from '../components/chat-fab/usePageContext';
import {
  taskContextItem,
  tasksContextItem,
  type TaskRef,
} from '../components/chat-fab/context-types';
import type { ChatFabContextItem } from '../components/chat-fab/chat-fab-item';

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

  // Parents, children, and block edges for the chat-context items. The
  // task primary carries its own blocked_by/blocks inline; the plural
  // `tasks` items render the dependency subtrees as bulleted lists.
  const { parents, children, blockedBy, blocks } = useMemo(() => {
    if (!graph || !nodeId) {
      return {
        parents: [] as TaskRef[],
        children: [] as TaskRef[],
        blockedBy: [] as string[],
        blocks: [] as string[],
      };
    }
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const parentIds = new Set<string>();
    const childIds = new Set<string>();
    const blockedByIds: string[] = [];
    const blocksIds: string[] = [];
    for (const edge of graph.edges ?? []) {
      const e = edge as { type?: string; source?: string; target?: string };
      if (e.type === 'parent' && e.target === nodeId && e.source) {
        parentIds.add(e.source);
      }
      if (e.type === 'parent' && e.source === nodeId && e.target) {
        childIds.add(e.target);
      }
      if (e.type === 'blocks' && e.target === nodeId && e.source) {
        blockedByIds.push(e.source);
      }
      if (e.type === 'blocks' && e.source === nodeId && e.target) {
        blocksIds.push(e.target);
      }
    }
    const toRef = (id: string): TaskRef => {
      const n = byId.get(id);
      return {
        id,
        title: n?.title,
        status: n?.status,
      };
    };
    return {
      parents: Array.from(parentIds).map(toRef),
      children: Array.from(childIds).map(toRef),
      blockedBy: blockedByIds,
      blocks: blocksIds,
    };
  }, [graph, nodeId]);

  // Declare page context items. Runs unconditionally before the early
  // returns below so hook order is stable.
  usePageContext(
    () => {
      if (!resourceId || !nodeId || !node) return [];
      const items: ChatFabContextItem[] = [
        taskContextItem(
          {
            id: nodeId,
            resource_id: resourceId,
            title: node.title,
            description: node.description ?? undefined,
            status: node.status,
            assignee: node.assignee ?? undefined,
            blocked_by: blockedBy.length > 0 ? blockedBy : undefined,
            blocks: blocks.length > 0 ? blocks : undefined,
          },
          { primary: true },
        ),
      ];
      if (parents.length > 0) items.push(tasksContextItem(parents));
      if (children.length > 0) items.push(tasksContextItem(children));
      return items;
    },
    [resourceId, nodeId, node, parents, children, blockedBy, blocks],
  );

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
            <LinkedRepoPill resource={resource} />
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

      {/* Dispatch threads — linked coordination conversations */}
      <DispatchThreadLinks metadata={resource.metadata} />
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

/**
 * Renders linked dispatch coordination threads from the task resource's
 * `metadata.dispatch_threads[]`. Each entry links to the dispatch detail
 * page (anchored to the thread section).
 */
function DispatchThreadLinks({ metadata }: { metadata?: Record<string, unknown> | null }) {
  const threads = Array.isArray(metadata?.dispatch_threads)
    ? (metadata!.dispatch_threads as Array<{ dispatch_id: string; conversation_id: string }>)
    : [];
  if (threads.length === 0) return null;

  return (
    <div
      className="rounded-md border p-4"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      <div className="text-xs mb-2 flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
        <MessageCircle className="h-3.5 w-3.5 text-honey-500" />
        Dispatch threads
      </div>
      <ul className="space-y-1.5">
        {threads.map((t) => (
          <li key={t.dispatch_id}>
            <Link
              to={`/dispatch/${t.dispatch_id}`}
              className="flex items-center gap-2 text-sm hover:opacity-80"
              style={{ color: 'var(--color-text)' }}
            >
              <Send className="h-3.5 w-3.5 shrink-0 text-honey-500" />
              <code
                className="text-2xs font-mono px-1 py-0.5 rounded shrink-0"
                style={{ backgroundColor: 'var(--color-elevated)' }}
              >
                {t.dispatch_id.length > 16 ? t.dispatch_id.slice(0, 16) + '...' : t.dispatch_id}
              </code>
            </Link>
          </li>
        ))}
      </ul>
    </div>
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

/**
 * Small pill linking a task back to the repo it was opportunistically
 * stamped against (slice 8 — `metadata.repo_id` set by trajectory bootstrap
 * with `task_ref` or by `autoRegisterResource`'s git-remote lookup).
 * Renders nothing if the task has no `repo_id` or the repo isn't visible
 * to the viewer.
 */
function LinkedRepoPill({ resource }: { resource: { metadata: unknown } }) {
  const meta = (resource.metadata ?? {}) as { repo_id?: string };
  const { data } = useRepo(meta.repo_id);
  if (!meta.repo_id || !data?.repo) return null;
  const repoMeta = (data.repo.metadata ?? {}) as { name?: string };
  const label = repoMeta.name ?? data.repo.name;
  return (
    <span className="flex items-center gap-1" title="Repo this task is linked to">
      <GitBranch className="w-3 h-3" />
      <Link to={`/repos/${meta.repo_id}`} className="hover:text-honey-500 transition-colors">
        {label}
      </Link>
    </span>
  );
}
