/**
 * TaskGraph Page — Full-screen task workspace.
 *
 * Supports multiple task graphs simultaneously (merged view).
 * Graph selector with checkboxes to toggle which graphs are visible.
 * Board (kanban) and Graph (sigma.js DAG) views.
 */

import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ChevronDown, Network, LayoutGrid, Check, Settings, ArrowDownToLine, ArrowUpFromLine, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useResource, useResourcesByType, useGitSyncStatus, useGitPull, useGitPush } from '../hooks/useApi';
import { GitSyncToggle } from '../components/git-sync/GitSyncToggle';
import { useQueries } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useTaskGraph, buildGraphologyGraph, STATUS_COLORS } from '../components/task-graph/useTaskGraph';
import { TaskGraphViewer } from '../components/task-graph/TaskGraphViewer';
import { TaskKanban } from '../components/task-graph/TaskKanban';
import { CreateTaskForm } from '../components/task-graph/CreateTaskForm';
import { TaskFilterBar, DEFAULT_FILTERS, type TaskFilters } from '../components/task-graph/TaskFilterBar';
import { useTasksRealtime } from '../hooks/useMapTasks';
import type { OpenTasksGraphNode, OpenTasksGraphEdge } from '../lib/api';

type ViewMode = 'graph' | 'board';

const LAST_GRAPHS_KEY = 'openhive-last-task-graphs';

// Short color palette for graph source tags
const GRAPH_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4'];

export function TaskGraph() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [view, setViewState] = useState<ViewMode>(
    () => (localStorage.getItem('openhive-task-view') as ViewMode) || 'board',
  );
  const setView = (v: ViewMode) => { setViewState(v); localStorage.setItem('openhive-task-view', v); };
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_FILTERS);
  const [showGraphPicker, setShowGraphPicker] = useState(false);

  // All available task graphs (including federated MAP-backed graphs — full CRUD
  // is wired through to the owning swarm via opentasks/graph.* MAP methods).
  const { data: allGraphsData, isLoading: graphsListLoading } = useResourcesByType('task');
  const allGraphs = useMemo(
    () => allGraphsData?.data || [],
    [allGraphsData],
  );

  // Selected graph IDs from ?g= query param, falling back to localStorage
  const selectedIds = useMemo(() => {
    const param = searchParams.get('g');
    if (param) return param.split(',').filter(Boolean);
    // Fallback: load from localStorage
    try {
      const stored = localStorage.getItem(LAST_GRAPHS_KEY);
      if (stored) { const ids = JSON.parse(stored); if (ids.length > 0) return ids; }
    } catch { /* ignore */ }
    // Last fallback: first available graph
    if (allGraphs.length > 0) return [allGraphs[0].id];
    return [];
  }, [searchParams, allGraphs]);

  // The primary resource is the first selected
  const resourceId = selectedIds[0] || null;

  // Sync URL when selection changes (but not on initial load from localStorage)
  const updateSelection = (ids: string[]) => {
    if (ids.length === 0) return;
    setSearchParams({ g: ids.join(',') }, { replace: true });
    localStorage.setItem(LAST_GRAPHS_KEY, JSON.stringify(ids));
  };

  // Auto-redirect: if no ?g= param but we have graphs, set it
  useEffect(() => {
    if (graphsListLoading || allGraphs.length === 0) return;
    if (!searchParams.get('g') && selectedIds.length > 0) {
      setSearchParams({ g: selectedIds.join(',') }, { replace: true });
    }
  }, [graphsListLoading, allGraphs]);

  const toggleGraph = (id: string) => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((p) => p !== id)
      : [...selectedIds, id];
    if (next.length === 0) return; // must have at least one
    updateSelection(next);
  };

  // Fetch graph data for the primary resource (for sigma.js graph object)
  const { data: resource, isLoading: resourceLoading } = useResource(resourceId || '');
  const { graph, isLoading: graphLoading, summary } = useTaskGraph(resourceId || '');
  useTasksRealtime();

  // Git sync status for the primary resource
  const isRemoteResource = resource && (
    resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror' ||
    !!(resource.metadata as Record<string, unknown> | null)?.opentasks_config
  );
  const autoPullEnabled = (() => {
    const meta = resource?.metadata as Record<string, unknown> | null;
    const otConfig = meta?.opentasks_config as Record<string, unknown> | undefined;
    const syncConfig = otConfig?.sync as Record<string, unknown> | undefined;
    const gitConfig = syncConfig?.git as Record<string, unknown> | undefined;
    return !!(gitConfig?.autoPull);
  })();

  // Poll every 30s when auto-pull is enabled, otherwise only on demand
  const { data: gitStatus } = useGitSyncStatus(
    resourceId || '', !!isRemoteResource, autoPullEnabled ? 30_000 : undefined,
  );
  const gitPull = useGitPull(resourceId || '');
  const gitPush = useGitPush(resourceId || '');
  const hasUnpulled = gitStatus && gitStatus.unpulledCommits > 0;
  const hasUnpushed = gitStatus && (gitStatus.unpushedCommits > 0 || gitStatus.hasUncommittedChanges);

  // Auto-pull: trigger pull when unpulled commits detected
  useEffect(() => {
    if (autoPullEnabled && hasUnpulled && !gitPull.isPending) {
      gitPull.mutate();
    }
  }, [autoPullEnabled, hasUnpulled, gitPull.isPending]);

  // Fetch graph data for ALL selected resources using useQueries (hook-safe)
  const graphQueryResults = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ['opentasks-graph', id],
      queryFn: () => api.get<{ nodes: OpenTasksGraphNode[]; edges: OpenTasksGraphEdge[] }>(
        `/resources/${id}/content/opentasks/graph`,
      ),
      enabled: !!id,
      staleTime: 30_000,
    })),
  });

  const isMultiGraph = selectedIds.length > 1;

  // Stabilize dependency: React Query returns stable data refs per query when
  // the data hasn't changed, but useQueries returns a new array each render.
  // Extract individual data objects — they ARE referentially stable from React Query.
  const graphQueryData = graphQueryResults.map((r) => r.data);

  const { mergedNodes, mergedEdges, graphColorMap } = useMemo(() => {
    const nodes: (OpenTasksGraphNode & { _sourceGraphId?: string; _sourceGraphName?: string; _sourceColor?: string })[] = [];
    const edges: OpenTasksGraphEdge[] = [];
    const colorMap = new Map<string, string>();

    for (let i = 0; i < selectedIds.length; i++) {
      const id = selectedIds[i];
      const result = graphQueryData[i];
      const color = GRAPH_COLORS[i % GRAPH_COLORS.length];
      const graphResource = allGraphs.find((g) => g.id === id);
      const graphName = graphResource?.name || id;
      colorMap.set(id, color);

      for (const node of result?.nodes || []) {
        nodes.push({
          ...node,
          id: selectedIds.length > 1 ? `${id}:${node.id}` : node.id,
          _sourceGraphId: id,
          _sourceGraphName: graphName,
          _sourceColor: color,
        });
      }
      for (const edge of result?.edges || []) {
        edges.push({
          ...edge,
          id: selectedIds.length > 1 ? `${id}:${edge.id}` : edge.id,
          from_id: selectedIds.length > 1 ? `${id}:${edge.from_id}` : edge.from_id,
          to_id: selectedIds.length > 1 ? `${id}:${edge.to_id}` : edge.to_id,
        });
      }
    }

    return { mergedNodes: nodes, mergedEdges: edges, graphColorMap: colorMap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphQueryData, selectedIds, allGraphs]);

  // Build merged graphology graph for multi-graph sigma.js rendering
  const mergedGraph = useMemo(() => {
    if (!isMultiGraph || mergedNodes.length === 0) return null;
    return buildGraphologyGraph(mergedNodes, mergedEdges, graphColorMap);
  }, [isMultiGraph, mergedNodes, mergedEdges, graphColorMap]);

  // Graph sources legend data for multi-graph mode
  const graphSources = useMemo(() => {
    if (!isMultiGraph) return undefined;
    const sources = new Map<string, { name: string; color: string }>();
    for (const id of selectedIds) {
      const g = allGraphs.find((r) => r.id === id);
      sources.set(id, { name: g?.name || id, color: graphColorMap.get(id) || '#6b7280' });
    }
    return sources;
  }, [isMultiGraph, selectedIds, allGraphs, graphColorMap]);

  // For multi-graph, compute merged summary (must be before early returns)
  const mergedSummary = useMemo(() => {
    if (selectedIds.length <= 1 && summary) return summary;
    const counts: Record<string, number> = {};
    for (const node of mergedNodes) {
      if (node.type === 'task' && !node.archived) {
        const s = node.status || 'open';
        counts[s] = (counts[s] ?? 0) + 1;
      }
    }
    return { task_counts: counts };
  }, [mergedNodes, summary, selectedIds]);

  const isLoading = graphsListLoading || (resourceId && (resourceLoading || graphLoading));

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center" style={{ backgroundColor: 'var(--color-bg)' }}>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-gray-500/30 animate-pulse" />
          <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading tasks...</span>
        </div>
      </div>
    );
  }

  if (!resourceId || (!resource && !resourceLoading)) {
    return (
      <div className="h-full flex items-center justify-center" style={{ backgroundColor: 'var(--color-bg)' }}>
        <div className="text-center space-y-3">
          <Network className="w-8 h-8 mx-auto" style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>No task graphs selected</p>
          <Link to="/tasks/list" className="btn btn-primary text-xs inline-flex items-center gap-1.5">
            Manage Task Graphs
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--color-bg)' }}>
      {/* Header bar */}
      <div
        className="flex items-center gap-3 px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}
      >
        {/* Graph multi-selector */}
        <div className="relative">
          <button
            onClick={() => setShowGraphPicker(!showGraphPicker)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/5 transition-colors"
          >
            {selectedIds.length === 1 ? (
              <>
                <Network className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                <span className="text-sm font-semibold truncate max-w-[200px]">{resource.name}</span>
              </>
            ) : (
              <>
                <div className="flex items-center -space-x-1">
                  {selectedIds.slice(0, 3).map((id) => (
                    <div
                      key={id}
                      className="w-3.5 h-3.5 rounded-full border-2"
                      style={{ backgroundColor: graphColorMap.get(id), borderColor: 'var(--color-surface)' }}
                    />
                  ))}
                </div>
                <span className="text-sm font-semibold">{selectedIds.length} graphs</span>
              </>
            )}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showGraphPicker ? 'rotate-180' : ''}`} style={{ color: 'var(--color-text-muted)' }} />
          </button>

          {showGraphPicker && (
            <div
              className="absolute top-full left-0 mt-1 w-72 rounded-lg shadow-xl border overflow-hidden z-50"
              style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
            >
              <div className="max-h-64 overflow-y-auto py-1">
                {allGraphs.map((g, i) => {
                  const isSelected = selectedIds.includes(g.id);
                  const color = GRAPH_COLORS[selectedIds.indexOf(g.id) % GRAPH_COLORS.length] || GRAPH_COLORS[i % GRAPH_COLORS.length];
                  return (
                    <button
                      key={g.id}
                      onClick={() => toggleGraph(g.id)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-white/5 flex items-center gap-2 transition-colors"
                    >
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${isSelected ? 'border-transparent' : ''}`}
                        style={isSelected ? { backgroundColor: color } : { borderColor: 'var(--color-border)' }}
                      >
                        {isSelected && <Check className="w-3 h-3 text-black" />}
                      </div>
                      <span className="truncate flex-1">{g.name}</span>
                      <span className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
                        {g.id.slice(-6)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

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
        {mergedSummary && (
          <div className="ml-auto flex items-center gap-2">
            {Object.entries(mergedSummary.task_counts).map(([status, count]) => (
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
            <TaskFilterBar filters={filters} onChange={setFilters} />
            <CreateTaskForm resourceId={resourceId!} />

            {/* Git sync controls */}
            {isRemoteResource && (
              <div className="flex items-center gap-1 ml-1">
                {hasUnpulled && (
                  <button
                    onClick={() => gitPull.mutate()}
                    disabled={gitPull.isPending}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium transition-colors hover:bg-blue-500/15"
                    style={{ color: '#60a5fa', backgroundColor: 'rgba(59, 130, 246, 0.08)' }}
                    title={`${gitStatus!.unpulledCommits} commit${gitStatus!.unpulledCommits > 1 ? 's' : ''} to pull`}
                  >
                    {gitPull.isPending ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <ArrowDownToLine className="w-3 h-3" />
                    )}
                    Pull {gitStatus!.unpulledCommits}
                  </button>
                )}
                {hasUnpushed && (
                  <button
                    onClick={() => gitPush.mutate()}
                    disabled={gitPush.isPending}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium transition-colors hover:bg-amber-500/15"
                    style={{ color: '#fbbf24', backgroundColor: 'rgba(245, 158, 11, 0.08)' }}
                    title={`${gitStatus!.unpushedCommits} commit${gitStatus!.unpushedCommits > 1 ? 's' : ''} to push`}
                  >
                    {gitPush.isPending ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <ArrowUpFromLine className="w-3 h-3" />
                    )}
                    Push
                  </button>
                )}
                {!hasUnpulled && !hasUnpushed && gitStatus && (
                  <span className="text-2xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    Synced
                  </span>
                )}
              </div>
            )}

            {/* Auto git-sync toggle (flips the daemon's autoCommit/autoPush flags) */}
            <GitSyncToggle resource={resource} className="ml-1" />

            <Link
              to="/tasks/list"
              className="btn btn-ghost p-1.5"
              title="Manage task graphs"
            >
              <Settings className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
            </Link>
          </div>
        )}
      </div>

      {/* View content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === 'board' ? (
          <TaskKanban
            resourceId={resourceId!}
            filters={filters}
            mergedNodes={selectedIds.length > 1 ? mergedNodes : undefined}
          />
        ) : (isMultiGraph ? mergedGraph : graph) ? (
          <TaskGraphViewer
            graph={(isMultiGraph ? mergedGraph : graph)!}
            resourceId={resourceId!}
            edges={isMultiGraph ? mergedEdges : undefined}
            allNodes={isMultiGraph ? mergedNodes : undefined}
            graphSources={graphSources}
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center space-y-2">
              <Network className="w-8 h-8 mx-auto" style={{ color: 'var(--color-text-muted)' }} />
              <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                No task graph data available
              </p>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
