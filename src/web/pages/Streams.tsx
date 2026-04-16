/**
 * Streams Page — visualize and manage git-cascade streams.
 *
 * Three views selectable via toolbar toggle:
 * - DAG: sigma.js graph of stream parent/child + merge relationships
 * - Stack: Graphite-style vertical stack from a selected root
 * - List: table view for simple scanning
 *
 * Clicking a stream in any view opens the StreamDetailSidebar with a
 * vertical timeline of commits, merges, conflicts, and status changes.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequestDraft,
  Layers,
  List,
  Network,
  Clock,
  AlertTriangle,
  FileText,
  Users,
  X,
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  Trash2,
  Wrench,
  Upload,
  Save,
  ExternalLink,
  Edit3,
  Github,
} from 'lucide-react';
import {
  useCascadeDAG,
  useCascadeStreamTimeline,
  useCascadeStreamAction,
  useCascadeStreamPR,
  useCreatePR,
  useUpdatePR,
  useClosePR,
  useUpdatePublishBranch,
  useGitHubStatus,
  type StreamDAGNode,
  type StreamDAGEdge,
  type StreamTimelineEvent,
  type CascadeAction,
  type CascadePullRequest,
} from '../hooks/useApi';
import { useCascadeStreamsRealtime } from '../hooks/useRealtimeInvalidation';
import { useMapSwarms } from '../hooks/useApi';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import { StreamDAGView } from '../components/streams/StreamDAGView';

type ViewMode = 'dag' | 'stack' | 'list' | 'conflicts';

const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e',
  paused: '#f59e0b',
  merged: '#6b7280',
  abandoned: '#6b7280',
  conflicted: 'var(--color-danger)',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  merged: 'Merged',
  abandoned: 'Abandoned',
  conflicted: 'Conflicted',
};

export function Streams() {
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedSwarmId, setSelectedSwarmId] = useState<string | undefined>();
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const [stackRootId, setStackRootId] = useState<string | null>(null);

  const { data: dagResponse, isLoading } = useCascadeDAG({
    source_swarm_id: selectedSwarmId,
  });
  const { data: swarmsResponse } = useMapSwarms();

  useCascadeStreamsRealtime();

  const dag = dagResponse?.data;
  const swarms = swarmsResponse?.data ?? [];

  const stats = useMemo(() => {
    if (!dag) return null;
    const nodes = dag.nodes;
    return {
      total: nodes.length,
      active: nodes.filter((n) => n.status === 'active').length,
      conflicted: nodes.filter((n) => n.status === 'conflicted').length,
      merged: nodes.filter((n) => n.status === 'merged').length,
      totalCommits: nodes.reduce((s, n) => s + n.commit_count, 0),
    };
  }, [dag]);

  // Build stack from a root node
  const stack = useMemo(() => {
    if (!dag || !stackRootId) return null;
    const nodeMap = new Map(dag.nodes.map((n) => [n.id, n]));
    // Find children by walking parent_stream_id edges
    const childrenOf = new Map<string, string[]>();
    for (const edge of dag.edges) {
      if (edge.type === 'parent') {
        const existing = childrenOf.get(edge.source) ?? [];
        existing.push(edge.target);
        childrenOf.set(edge.source, existing);
      }
    }

    const ordered: StreamDAGNode[] = [];
    const visited = new Set<string>();
    function walk(id: string, depth: number) {
      if (visited.has(id)) return;
      visited.add(id);
      const node = nodeMap.get(id);
      if (node) ordered.push(node);
      for (const childId of childrenOf.get(id) ?? []) {
        walk(childId, depth + 1);
      }
    }
    walk(stackRootId, 0);
    return ordered;
  }, [dag, stackRootId]);

  if (isLoading) return <PageLoader />;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-honey-500" />
            Streams
          </h1>

          {/* Swarm filter */}
          <select
            className="input text-xs py-1"
            value={selectedSwarmId ?? ''}
            onChange={(e) => setSelectedSwarmId(e.target.value || undefined)}
          >
            <option value="">All swarms</option>
            {swarms.map((s: { id: string; name?: string }) => (
              <option key={s.id} value={s.id}>{s.name ?? s.id}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1">
          {/* Stats pills */}
          {stats && (
            <div className="flex items-center gap-3 mr-4 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              <span>{stats.total} streams</span>
              <span>{stats.totalCommits} commits</span>
              {stats.conflicted > 0 && (
                <span style={{ color: 'var(--color-danger)' }}>
                  {stats.conflicted} conflicted
                </span>
              )}
            </div>
          )}

          {/* View toggle */}
          <ViewToggle mode={viewMode} onChange={setViewMode} />
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        <div className={`flex-1 ${viewMode === 'dag' ? 'overflow-hidden' : 'overflow-auto'}`}>
          {!dag || dag.nodes.length === 0 ? (
            <EmptyState />
          ) : viewMode === 'list' ? (
            <StreamListView
              nodes={dag.nodes}
              onSelect={setSelectedStreamId}
              onViewStack={(id) => { setStackRootId(id); setViewMode('stack'); }}
              selectedId={selectedStreamId}
            />
          ) : viewMode === 'stack' ? (
            <StreamStackView
              stack={stack}
              dag={dag}
              rootId={stackRootId}
              onSelectRoot={setStackRootId}
              onSelect={setSelectedStreamId}
              selectedId={selectedStreamId}
            />
          ) : viewMode === 'conflicts' ? (
            <ConflictTriageView
              nodes={dag.nodes}
              onSelect={setSelectedStreamId}
              selectedId={selectedStreamId}
            />
          ) : (
            <StreamDAGView
              nodes={dag.nodes}
              edges={dag.edges}
              selectedId={selectedStreamId}
              onSelect={setSelectedStreamId}
            />
          )}
        </div>

        {/* Sidebar */}
        {selectedStreamId && (
          <StreamDetailSidebar
            streamRowId={selectedStreamId}
            node={dag?.nodes.find((n) => n.id === selectedStreamId) ?? null}
            onClose={() => setSelectedStreamId(null)}
          />
        )}
      </div>
    </div>
  );
}

// ─── View Toggle ──────────────────────────────────────────────────────

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const items: Array<{ value: ViewMode; icon: JSX.Element; label: string }> = [
    { value: 'list', icon: <List className="w-3.5 h-3.5" />, label: 'List' },
    { value: 'stack', icon: <Layers className="w-3.5 h-3.5" />, label: 'Stack' },
    { value: 'dag', icon: <Network className="w-3.5 h-3.5" />, label: 'DAG' },
    { value: 'conflicts', icon: <AlertTriangle className="w-3.5 h-3.5" />, label: 'Conflicts' },
  ];

  return (
    <div className="flex rounded-md border" style={{ borderColor: 'var(--color-border)' }}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`px-2.5 py-1 text-2xs flex items-center gap-1.5 transition-colors
            ${mode === item.value ? 'text-honey-500' : ''}
            focus:outline-none focus-visible:ring-2 focus-visible:ring-honey-500/60`}
          style={{
            backgroundColor: mode === item.value ? 'var(--color-elevated)' : 'transparent',
            color: mode === item.value ? undefined : 'var(--color-text-muted)',
          }}
          onClick={() => onChange(item.value)}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <GitBranch className="w-8 h-8 mb-3" style={{ color: 'var(--color-text-muted)' }} />
      <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        No cascade streams yet. Streams appear when a cascade-aware agent
        creates a stream and emits events to this hub.
      </p>
    </div>
  );
}

// ─── List View ────────────────────────────────────────────────────────

function StreamListView({
  nodes,
  onSelect,
  onViewStack,
  selectedId,
}: {
  nodes: StreamDAGNode[];
  onSelect: (id: string) => void;
  onViewStack: (id: string) => void;
  selectedId: string | null;
}) {
  return (
    <div className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          className="w-full text-left px-4 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-honey-500/60"
          style={{
            backgroundColor: selectedId === node.id ? 'var(--color-elevated)' : undefined,
          }}
          onClick={() => onSelect(node.id)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <StreamStatusDot status={node.status} />
              <span className="text-sm font-medium truncate">{node.name || node.stream_id}</span>
              <code className="text-2xs font-mono px-1 py-0.5 rounded shrink-0" style={{ backgroundColor: 'var(--color-elevated)' }}>
                {node.stream_id.slice(0, 8)}
              </code>
            </div>
            <div className="flex items-center gap-3 text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
              <span className="flex items-center gap-1">
                <GitCommit className="w-3 h-3" />
                {node.commit_count}
              </span>
              {node.open_conflict_count > 0 && (
                <span className="flex items-center gap-1" style={{ color: 'var(--color-danger)' }}>
                  <AlertTriangle className="w-3 h-3" />
                  {node.open_conflict_count}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Users className="w-3 h-3" />
                {node.source_agent_id}
              </span>
              <TimeAgo date={node.last_event_at} />
              {!node.parent_stream_id && (
                <button
                  type="button"
                  className="btn-ghost px-1.5 py-0.5 text-2xs"
                  onClick={(e) => { e.stopPropagation(); onViewStack(node.id); }}
                  title="View as stack"
                >
                  <Layers className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Stack View (Graphite-style) ──────────────────────────────────────

function StreamStackView({
  stack,
  dag,
  rootId,
  onSelectRoot,
  onSelect,
  selectedId,
}: {
  stack: StreamDAGNode[] | null;
  dag: { nodes: StreamDAGNode[]; edges: StreamDAGEdge[] };
  rootId: string | null;
  onSelectRoot: (id: string | null) => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  // Find root streams (no parent)
  const roots = dag.nodes.filter((n) => !n.parent_stream_id);

  if (!rootId || !stack) {
    return (
      <div className="p-4">
        <p className="text-sm mb-3" style={{ color: 'var(--color-text-muted)' }}>
          Select a root stream to view its stack:
        </p>
        <div className="space-y-2">
          {roots.map((root) => (
            <button
              key={root.id}
              type="button"
              className="w-full text-left card p-3 hover:border-honey-500/40 transition-colors
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-honey-500/60"
              onClick={() => onSelectRoot(root.id)}
            >
              <div className="flex items-center gap-2">
                <StreamStatusDot status={root.status} />
                <span className="text-sm font-medium">{root.name || root.stream_id}</span>
                <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                  {root.commit_count} commits
                </span>
              </div>
            </button>
          ))}
          {roots.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              No root streams found.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <button
        type="button"
        className="btn-ghost text-2xs mb-3 flex items-center gap-1"
        onClick={() => onSelectRoot(null)}
      >
        Back to roots
      </button>

      <div className="space-y-0">
        {stack.map((node, idx) => (
          <StackLevel
            key={node.id}
            node={node}
            isFirst={idx === 0}
            isLast={idx === stack.length - 1}
            isSelected={selectedId === node.id}
            onSelect={() => onSelect(node.id)}
          />
        ))}
      </div>
    </div>
  );
}

function StackLevel({
  node,
  isFirst,
  isLast,
  isSelected,
  onSelect,
}: {
  node: StreamDAGNode;
  isFirst: boolean;
  isLast: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data: timelineResp } = useCascadeStreamTimeline(expanded ? node.id : null);
  const commits = timelineResp?.data?.filter((e) => e.type === 'commit') ?? [];

  return (
    <div className="relative">
      {/* Vertical connector line */}
      {!isFirst && (
        <div
          className="absolute left-5 -top-0 w-px h-3"
          style={{ backgroundColor: 'var(--color-border)' }}
        />
      )}
      {!isLast && (
        <div
          className="absolute left-5 bottom-0 w-px h-3"
          style={{ backgroundColor: 'var(--color-border)' }}
        />
      )}

      <button
        type="button"
        className="w-full text-left card p-3 my-1 transition-colors
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-honey-500/60"
        style={{
          borderColor: isSelected ? 'var(--color-accent)' : node.status === 'conflicted' ? 'var(--color-danger-border)' : undefined,
        }}
        onClick={onSelect}
      >
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <StreamStatusDot status={node.status} />
            <span className="text-sm font-medium">{node.name || node.stream_id}</span>
            <span
              className="text-2xs px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: 'var(--color-elevated)',
                color: STATUS_COLORS[node.status] ?? 'var(--color-text-muted)',
              }}
            >
              {STATUS_LABELS[node.status] ?? node.status}
            </span>
          </div>
          <div className="flex items-center gap-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <span>{node.commit_count} commits</span>
            <span>{node.source_agent_id}</span>
            {node.open_conflict_count > 0 && (
              <span style={{ color: 'var(--color-danger)' }}>
                {node.open_conflict_count} conflicts
              </span>
            )}
          </div>
        </div>

        {/* Expandable commit list */}
        {node.commit_count > 0 && (
          <button
            type="button"
            className="flex items-center gap-1 text-2xs mt-1 focus:outline-none
                       focus-visible:ring-2 focus-visible:ring-honey-500/60 rounded px-1 -mx-1"
            style={{ color: 'var(--color-text-muted)' }}
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {expanded ? 'Hide' : 'Show'} commits
          </button>
        )}

        {expanded && commits.length > 0 && (
          <div className="mt-2 ml-4 space-y-1 border-l pl-3" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {commits.slice(0, 10).map((c, i) => (
              <div key={i} className="text-2xs flex items-start gap-2">
                <code className="font-mono shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                  {(c.data.commit_hash as string)?.slice(0, 7)}
                </code>
                <span className="truncate">{c.data.message_summary as string}</span>
              </div>
            ))}
            {commits.length > 10 && (
              <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                +{commits.length - 10} more
              </div>
            )}
          </div>
        )}
      </button>
    </div>
  );
}

// ─── Conflict Triage View ─────────────────────────────────────────────

function ConflictTriageView({
  nodes,
  onSelect,
  selectedId,
}: {
  nodes: StreamDAGNode[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const conflicted = nodes.filter((n) => n.status === 'conflicted' || n.open_conflict_count > 0);

  if (conflicted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <AlertTriangle className="w-8 h-8 mb-3" style={{ color: 'var(--color-text-muted)' }} />
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          No conflicts detected across any streams.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4" style={{ color: 'var(--color-danger)' }} />
        <h3 className="text-sm font-semibold">
          {conflicted.length} stream{conflicted.length === 1 ? '' : 's'} with conflicts
        </h3>
      </div>
      <div className="space-y-2">
        {conflicted.map((node) => (
          <ConflictStreamCard
            key={node.id}
            node={node}
            isSelected={selectedId === node.id}
            onSelect={() => onSelect(node.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ConflictStreamCard({
  node,
  isSelected,
  onSelect,
}: {
  node: StreamDAGNode;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { data: timelineResp } = useCascadeStreamTimeline(node.id);
  const conflicts = timelineResp?.data?.filter((e) => e.type === 'conflict_detected') ?? [];
  const pendingConflicts = conflicts.filter(
    (c) => (c.data.status as string) === 'pending',
  );

  return (
    <button
      type="button"
      className="w-full text-left card p-3 transition-colors
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-honey-500/60"
      style={{
        borderColor: isSelected ? 'var(--color-danger)' : 'var(--color-danger-border)',
      }}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <StreamStatusDot status={node.status} />
          <span className="text-sm font-medium">{node.name || node.stream_id}</span>
          <code
            className="text-2xs font-mono px-1 py-0.5 rounded"
            style={{ backgroundColor: 'var(--color-elevated)' }}
          >
            {node.stream_id.slice(0, 8)}
          </code>
        </div>
        <span className="text-2xs flex items-center gap-1" style={{ color: 'var(--color-danger)' }}>
          <AlertTriangle className="w-3 h-3" />
          {node.open_conflict_count} open
        </span>
      </div>

      {/* Conflict details */}
      {pendingConflicts.length > 0 && (
        <div className="space-y-1 mt-1">
          {pendingConflicts.map((cf, idx) => (
            <div
              key={idx}
              className="text-2xs px-2 py-1 rounded"
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
            >
              <div className="flex items-center justify-between">
                <span>
                  Files: {(cf.data.conflicted_files as string[])?.join(', ')}
                </span>
                {cf.data.source && (
                  <span
                    className="uppercase tracking-wider"
                    style={{ color: 'var(--color-text-muted)', fontSize: '0.6rem' }}
                  >
                    {cf.data.source as string}
                  </span>
                )}
              </div>
              <div className="mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                <TimeAgo date={cf.timestamp} />
                {cf.data.agent_id && <span className="ml-2">{cf.data.agent_id as string}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 mt-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
        <span>{node.commit_count} commits</span>
        <span>{node.source_agent_id}</span>
        <TimeAgo date={node.last_event_at} />
      </div>
    </button>
  );
}

// ─── Detail Sidebar ───────────────────────────────────────────────────

function StreamDetailSidebar({
  streamRowId,
  node,
  onClose,
}: {
  streamRowId: string;
  node: StreamDAGNode | null;
  onClose: () => void;
}) {
  const { data: timelineResp, isLoading } = useCascadeStreamTimeline(streamRowId);
  const timeline = timelineResp?.data ?? [];

  return (
    <div
      className="w-80 border-l flex flex-col shrink-0 overflow-hidden"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <div className="flex items-center gap-2 min-w-0">
          {node && <StreamStatusDot status={node.status} />}
          <h3 className="text-sm font-semibold truncate">
            {node?.name ?? node?.stream_id ?? streamRowId.slice(0, 8)}
          </h3>
        </div>
        <button
          type="button"
          className="btn-ghost p-1 shrink-0"
          onClick={onClose}
          aria-label="Close stream detail"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Meta */}
      {node && (
        <div className="px-3 py-2 text-2xs space-y-1 border-b" style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-muted)' }}>
          <div className="flex justify-between">
            <span>Status</span>
            <span style={{ color: STATUS_COLORS[node.status] }}>{STATUS_LABELS[node.status] ?? node.status}</span>
          </div>
          <div className="flex justify-between">
            <span>Agent</span>
            <span>{node.source_agent_id}</span>
          </div>
          <div className="flex justify-between">
            <span>Commits</span>
            <span>{node.commit_count}</span>
          </div>
          {node.open_conflict_count > 0 && (
            <div className="flex justify-between">
              <span>Open conflicts</span>
              <span style={{ color: 'var(--color-danger)' }}>{node.open_conflict_count}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Opened</span>
            <TimeAgo date={node.opened_at} />
          </div>
          <div className="flex justify-between">
            <span>Last activity</span>
            <TimeAgo date={node.last_event_at} />
          </div>
          <div className="flex justify-between">
            <span>Stream ID</span>
            <code className="font-mono">{node.stream_id}</code>
          </div>
        </div>
      )}

      {/* Actions */}
      {node && (
        <StreamActions streamRowId={streamRowId} node={node} />
      )}

      {/* Branch + PR + Commit */}
      {node && node.status !== 'merged' && node.status !== 'abandoned' && (
        <>
          <StreamBranchSection streamRowId={streamRowId} node={node} />
          <StreamPRSection streamRowId={streamRowId} node={node} />
          <StreamCommitSection streamRowId={streamRowId} node={node} />
        </>
      )}

      {/* Timeline */}
      <div className="flex-1 overflow-auto p-3">
        <h4 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          Timeline
        </h4>
        {isLoading ? (
          <div className="text-2xs animate-pulse" style={{ color: 'var(--color-text-muted)' }}>Loading...</div>
        ) : timeline.length === 0 ? (
          <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>No events yet.</div>
        ) : (
          <div className="space-y-0">
            {timeline.map((event, idx) => (
              <TimelineEntry key={idx} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Branch Management ────────────────────────────────────────────────

function StreamBranchSection({
  streamRowId,
  node,
}: {
  streamRowId: string;
  node: StreamDAGNode;
}) {
  const [editing, setEditing] = useState(false);
  const [branchName, setBranchName] = useState(node.publish_branch ?? '');
  const updateBranch = useUpdatePublishBranch();
  const pushAction = useCascadeStreamAction();

  const saveBranch = useCallback(() => {
    if (branchName.trim()) {
      updateBranch.mutate({ streamRowId, publish_branch: branchName.trim() });
    }
    setEditing(false);
  }, [branchName, streamRowId, updateBranch]);

  const displayBranch = node.publish_branch || `cascade/${node.name.replace(/[^a-zA-Z0-9_/-]/g, '-')}`;

  return (
    <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-2xs font-semibold flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          <GitBranch className="w-3 h-3" />
          Branch
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn-ghost p-0.5"
            onClick={() => { setEditing(!editing); setBranchName(node.publish_branch ?? displayBranch); }}
            title="Edit branch name"
          >
            <Edit3 className="w-3 h-3" />
          </button>
          <button
            type="button"
            className="btn-ghost p-0.5 text-2xs flex items-center gap-1"
            onClick={() => pushAction.mutate({
              streamRowId,
              action: 'push',
              params: { target_ref: node.publish_branch ?? displayBranch },
            })}
            disabled={pushAction.isPending}
            title="Push to remote"
          >
            <Upload className="w-3 h-3" />
          </button>
        </div>
      </div>
      {editing ? (
        <div className="flex gap-1">
          <input
            className="input text-2xs py-0.5 flex-1"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveBranch(); if (e.key === 'Escape') setEditing(false); }}
            autoFocus
          />
          <button type="button" className="btn-ghost text-2xs px-1.5" onClick={saveBranch}>Save</button>
        </div>
      ) : (
        <code className="text-2xs font-mono block truncate" style={{ color: 'var(--color-text-secondary)' }}>
          {displayBranch}
        </code>
      )}
      {pushAction.isPending && (
        <span className="text-2xs animate-pulse block mt-1" style={{ color: 'var(--color-text-muted)' }}>Pushing...</span>
      )}
    </div>
  );
}

// ─── PR Management ────────────────────────────────────────────────────

function StreamPRSection({
  streamRowId,
  node,
}: {
  streamRowId: string;
  node: StreamDAGNode;
}) {
  const { data: prRaw } = useCascadeStreamPR(streamRowId);
  const { data: ghRaw } = useGitHubStatus();
  const createPR = useCreatePR();
  const updatePRMutation = useUpdatePR();
  const closePR = useClosePR();

  // api.get returns raw JSON → React Query .data = { data: PR|null }.
  const pr = ((prRaw as any)?.data ?? null) as CascadePullRequest | null;
  const isGitHubConnected = ((ghRaw as any)?.data?.connected) ?? false;

  return (
    <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-2xs font-semibold flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          <GitPullRequestDraft className="w-3 h-3" />
          Pull Request
        </span>
        {!isGitHubConnected && (
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            No GitHub token
          </span>
        )}
      </div>

      {pr ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span
              className="text-2xs px-1.5 py-0.5 rounded font-medium"
              style={{
                backgroundColor: pr.state === 'open' ? '#22c55e20' : pr.state === 'merged' ? '#8b5cf620' : 'var(--color-elevated)',
                color: pr.state === 'open' ? '#22c55e' : pr.state === 'merged' ? '#8b5cf6' : 'var(--color-text-muted)',
              }}
            >
              {pr.state === 'merged' ? 'Merged' : pr.state === 'open' ? 'Open' : pr.state === 'draft' ? 'Draft' : 'Closed'}
            </span>
            <span className="text-2xs truncate" style={{ color: 'var(--color-text-secondary)' }}>
              #{pr.remote_pr_number} {pr.title}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {pr.remote_pr_url && (
              <a
                href={pr.remote_pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-ghost text-2xs flex items-center gap-1 px-1.5 py-0.5"
              >
                <ExternalLink className="w-3 h-3" />
                View
              </a>
            )}
            {(pr.state === 'open' || pr.state === 'draft') && (
              <>
                <button
                  type="button"
                  className="btn-ghost text-2xs px-1.5 py-0.5"
                  onClick={() => updatePRMutation.mutate({ streamRowId })}
                  disabled={updatePRMutation.isPending}
                >
                  Update
                </button>
                <button
                  type="button"
                  className="btn-ghost text-2xs px-1.5 py-0.5"
                  style={{ color: 'var(--color-text-muted)' }}
                  onClick={() => closePR.mutate({ streamRowId })}
                  disabled={closePR.isPending}
                >
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1 px-1.5 py-0.5 w-full justify-center"
          style={{ color: isGitHubConnected ? undefined : 'var(--color-text-muted)' }}
          onClick={() => createPR.mutate({ streamRowId, title: node.name })}
          disabled={createPR.isPending || !isGitHubConnected}
          title={isGitHubConnected ? 'Create pull request on GitHub' : 'GitHub token not configured'}
        >
          <GitPullRequestDraft className="w-3 h-3" />
          {createPR.isPending ? 'Creating...' : 'Create PR'}
        </button>
      )}
    </div>
  );
}

// ─── Commit Uncommitted Changes ───────────────────────────────────────

function StreamCommitSection({
  streamRowId,
  node,
}: {
  streamRowId: string;
  node: StreamDAGNode;
}) {
  const [message, setMessage] = useState('');
  const [showInput, setShowInput] = useState(false);
  const commitAction = useCascadeStreamAction();

  const doCommit = useCallback(() => {
    if (!message.trim()) return;
    commitAction.mutate({
      streamRowId,
      action: 'commit',
      params: { message: message.trim() },
    });
    setMessage('');
    setShowInput(false);
  }, [message, streamRowId, commitAction]);

  if (node.status !== 'active') return null;

  return (
    <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
      {showInput ? (
        <div className="space-y-1.5">
          <input
            className="input text-2xs py-1 w-full"
            placeholder="Commit message..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doCommit(); if (e.key === 'Escape') setShowInput(false); }}
            autoFocus
          />
          <div className="flex gap-1">
            <button
              type="button"
              className="btn-ghost text-2xs px-2 py-0.5 flex items-center gap-1"
              onClick={doCommit}
              disabled={commitAction.isPending || !message.trim()}
            >
              <Save className="w-3 h-3" />
              {commitAction.isPending ? 'Committing...' : 'Commit'}
            </button>
            <button
              type="button"
              className="btn-ghost text-2xs px-2 py-0.5"
              style={{ color: 'var(--color-text-muted)' }}
              onClick={() => setShowInput(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1 px-1.5 py-0.5 w-full justify-center"
          onClick={() => setShowInput(true)}
        >
          <GitCommit className="w-3 h-3" />
          Commit changes
        </button>
      )}
    </div>
  );
}

// ─── Stream Actions ───────────────────────────────────────────────────

function StreamActions({
  streamRowId,
  node,
}: {
  streamRowId: string;
  node: StreamDAGNode;
}) {
  const action = useCascadeStreamAction();
  const isPending = action.isPending;

  const fire = useCallback(
    (act: CascadeAction, params?: Record<string, string>) => {
      action.mutate({ streamRowId, action: act, params });
    },
    [action, streamRowId],
  );

  // Determine which actions are available based on stream status
  const isActive = node.status === 'active';
  const isPaused = node.status === 'paused';
  const isConflicted = node.status === 'conflicted';
  const isTerminal = node.status === 'merged' || node.status === 'abandoned';

  if (isTerminal) return null;

  return (
    <div className="px-3 py-2 border-b flex flex-wrap gap-1.5" style={{ borderColor: 'var(--color-border-subtle)' }}>
      {/* Merge — available when active and has a parent */}
      {isActive && node.parent_stream_id && (
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
          onClick={() => fire('merge')}
          disabled={isPending}
          title="Request merge into parent stream"
        >
          <GitMerge className="w-3 h-3" />
          Merge
        </button>
      )}

      {/* Pause/Resume toggle */}
      {isActive && (
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
          onClick={() => fire('pause', { reason: 'operator-paused' })}
          disabled={isPending}
          title="Pause this stream"
        >
          <Pause className="w-3 h-3" />
          Pause
        </button>
      )}
      {isPaused && (
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
          onClick={() => fire('resume')}
          disabled={isPending}
          title="Resume this stream"
        >
          <Play className="w-3 h-3" />
          Resume
        </button>
      )}

      {/* Resolve — available when conflicted */}
      {isConflicted && node.open_conflict_count > 0 && (
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
          style={{ color: 'var(--color-danger)' }}
          onClick={() => fire('resolve', { strategy: 'ours' })}
          disabled={isPending}
          title="Request conflict resolution (strategy: ours)"
        >
          <Wrench className="w-3 h-3" />
          Resolve
        </button>
      )}

      {/* Abandon — available when not terminal */}
      <button
        type="button"
        className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
        style={{ color: 'var(--color-text-muted)' }}
        onClick={() => fire('abandon', { reason: 'operator-abandoned' })}
        disabled={isPending}
        title="Abandon this stream"
      >
        <Trash2 className="w-3 h-3" />
        Abandon
      </button>

      {/* Pending indicator */}
      {isPending && (
        <span className="text-2xs animate-pulse" style={{ color: 'var(--color-text-muted)' }}>
          Sending...
        </span>
      )}
    </div>
  );
}

function TimelineEntry({ event }: { event: StreamTimelineEvent }) {
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

// ─── Shared ───────────────────────────────────────────────────────────

function StreamStatusDot({ status }: { status: string }) {
  return (
    <div
      className="w-2 h-2 rounded-full shrink-0"
      style={{ backgroundColor: STATUS_COLORS[status] ?? 'var(--color-text-muted)' }}
      title={STATUS_LABELS[status] ?? status}
    />
  );
}
