/**
 * Changes Page — review and manage in-flight agent changes (git-cascade streams).
 *
 * Default view is a triage-first list grouping rows by state:
 *   1. Needs attention — streams with open conflicts
 *   2. In progress — active + paused streams with no conflicts
 *   3. Recently landed — merged/abandoned in the last 7 days (collapsible)
 *
 * Stack + Graph are secondary power-user views, reachable from the toolbar
 * switcher or from the per-row detail sidebar. Conflicts is a filter chip,
 * not a separate view. Clicking any row opens StreamDetailSidebar with a
 * vertical timeline, actions, branch / PR / commit controls.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequestDraft,
  Layers,
  ListTree,
  GitPullRequest,
  Network,
  Clock,
  AlertTriangle,
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
  Search,
  Inbox,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
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
  useMapSwarm,
  type StreamDAGNode,
  type StreamDAGEdge,
  type CascadeAction,
  type CascadePullRequest,
} from '../hooks/useApi';
import { useCascadeStreamsRealtime } from '../hooks/useRealtimeInvalidation';
import { useMapSwarms } from '../hooks/useApi';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import { EmptyState } from '../components/common/EmptyState';
import { useDebouncedValue, matchesSearch } from '../components/common/ListFilters';
import { StreamCascadeMap } from '../components/streams/StreamCascadeMap';
import { StreamStatusDot, STATUS_COLORS, STATUS_LABELS, TimelineEntry } from '../components/streams/shared';
import { DiffView } from '../components/cascade/DiffView';
import { StackDiffView } from '../components/cascade/StackDiffView';
import { PRStackDrawer } from '../components/cascade/PRStackDrawer';
import { usePageContext } from '../components/chat-fab/usePageContext';
import {
  streamContextItem,
  taskContextItem,
} from '../components/chat-fab/context-types';
import type { ChatFabContextItem } from '../components/chat-fab/chat-fab-item';
import { LineageRail } from '../components/pipeline/LineageRail';

type ViewMode = 'list' | 'stack' | 'map';

const RECENTLY_LANDED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type TriageBucket = 'needs-attention' | 'in-progress' | 'recently-landed';

/**
 * Per-stream cascade capability gate. The "All swarms" view mixes streams
 * from multiple swarms, so action availability must be resolved per-stream
 * keyed on `node.source_swarm_id` — never a single page-level value.
 *
 * Reads the owning swarm's aggregate `capabilities.cascade` block (a
 * `CascadeCapability` shape declared by the runtime at MAP registration):
 *   - `canAct`         — can drive merge/pause/resume/abandon/resolve + push/commit.
 *   - `emitsConflicts` — emits conflict lifecycle events.
 *
 * Conservative by default: a swarm that declares no `cascade` block, or
 * leaves a flag undefined, is treated as not-capable. Mirrors the chat
 * surface's "Unavailable + reason" precedent (see src/web/CLAUDE.md).
 */
const CASCADE_ACT_DISABLED_REASON =
  "This swarm reports cascade activity but doesn't accept cascade actions (observe-only).";

function useCascadeCapability(node: StreamDAGNode): {
  canAct: boolean;
  emitsConflicts: boolean;
} {
  const { data: swarm } = useMapSwarm(node.source_swarm_id);
  const cascade = (swarm?.capabilities as { cascade?: { canAct?: boolean; emitsConflicts?: boolean } } | null)?.cascade;
  return {
    canAct: cascade?.canAct === true,
    emitsConflicts: cascade?.emitsConflicts === true,
  };
}

function bucketForNode(node: StreamDAGNode): TriageBucket | null {
  if (node.status === 'conflicted' || node.open_conflict_count > 0) {
    return 'needs-attention';
  }
  if (node.status === 'active' || node.status === 'paused') {
    return 'in-progress';
  }
  if (node.status === 'merged' || node.status === 'abandoned') {
    const ageMs = Date.now() - new Date(node.last_event_at).getTime();
    return ageMs <= RECENTLY_LANDED_WINDOW_MS ? 'recently-landed' : null;
  }
  return null;
}

export function Changes() {
  const [routeSearchParams, setRouteSearchParams] = useSearchParams();
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedSwarmId, setSelectedSwarmId] = useState<string | undefined>();
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const [stackRootId, setStackRootId] = useState<string | null>(null);
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebouncedValue(searchRaw, 180);
  // Diff drawer target — set when the user clicks a commit row.
  const [diffTarget, setDiffTarget] = useState<{
    streamRowId: string;
    commitHash: string;
  } | null>(null);
  // Range diff drawer — fires when the user clicks "View stream diff" /
  // "View stack diff". `mode` discriminates which resolver fires.
  const [rangeDiffTarget, setRangeDiffTarget] = useState<{
    mode: 'stream' | 'stack';
    rowId: string;
  } | null>(null);
  // PR-stack drawer — fires when "Open PR stack" is clicked in the stack
  // view header. Per D22, only mounted from stack-view context.
  const [prStackTarget, setPRStackTarget] = useState<{
    rowId: string;
    rootName?: string;
  } | null>(null);

  const { data: dagResponse, isLoading } = useCascadeDAG({
    source_swarm_id: selectedSwarmId,
  });
  const { data: swarmsResponse } = useMapSwarms();

  useCascadeStreamsRealtime();

  const dag = dagResponse?.data;
  const swarms = swarmsResponse?.data ?? [];
  const streamParam = routeSearchParams.get('stream');

  useEffect(() => {
    if (!streamParam || !dag?.nodes.some((n) => n.id === streamParam)) return;
    setSelectedStreamId(streamParam);
  }, [dag, streamParam]);

  const selectStream = useCallback((streamRowId: string) => {
    setSelectedStreamId(streamRowId);
    setRouteSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('stream', streamRowId);
      return next;
    }, { replace: true });
  }, [setRouteSearchParams]);

  const closeStream = useCallback(() => {
    setSelectedStreamId(null);
    setRouteSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('stream');
      return next;
    }, { replace: true });
  }, [setRouteSearchParams]);

  const { buckets, filteredCount, totalCount } = useMemo(() => {
    const all = dag?.nodes ?? [];
    const filtered = all.filter((n) => {
      if (conflictsOnly && !(n.status === 'conflicted' || n.open_conflict_count > 0)) {
        return false;
      }
      if (search && !matchesSearch(search, n.name, n.stream_id, n.source_agent_id)) {
        return false;
      }
      return true;
    });
    const groups: Record<TriageBucket, StreamDAGNode[]> = {
      'needs-attention': [],
      'in-progress': [],
      'recently-landed': [],
    };
    for (const node of filtered) {
      const bucket = bucketForNode(node);
      if (bucket) groups[bucket].push(node);
    }
    const sortByActivity = (a: StreamDAGNode, b: StreamDAGNode) =>
      new Date(b.last_event_at).getTime() - new Date(a.last_event_at).getTime();
    groups['needs-attention'].sort(sortByActivity);
    groups['in-progress'].sort(sortByActivity);
    groups['recently-landed'].sort(sortByActivity);
    return { buckets: groups, filteredCount: filtered.length, totalCount: all.length };
  }, [dag, conflictsOnly, search]);

  const stack = useMemo(() => {
    if (!dag || !stackRootId) return null;
    const nodeMap = new Map(dag.nodes.map((n) => [n.id, n]));
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
    function walk(id: string) {
      if (visited.has(id)) return;
      visited.add(id);
      const node = nodeMap.get(id);
      if (node) ordered.push(node);
      for (const childId of childrenOf.get(id) ?? []) walk(childId);
    }
    walk(stackRootId);
    return ordered;
  }, [dag, stackRootId]);

  const openStackFrom = useCallback((streamRowId: string) => {
    if (!dag) return;
    const byStreamId = new Map(dag.nodes.map((n) => [n.stream_id, n]));
    let cursor = dag.nodes.find((n) => n.id === streamRowId);
    while (cursor?.parent_stream_id) {
      const parent = byStreamId.get(cursor.parent_stream_id);
      if (!parent) break;
      cursor = parent;
    }
    if (cursor) {
      setStackRootId(cursor.id);
      setViewMode('stack');
    }
  }, [dag]);

  // Declare the chat context for the currently-selected stream (if any).
  // Stream is the primary item; a linked task ref rides as a secondary when
  // the stream carries one. Cleared on unmount / when no stream is selected.
  const selectedNode = useMemo(
    () =>
      selectedStreamId
        ? dag?.nodes.find((n) => n.id === selectedStreamId) ?? null
        : null,
    [dag, selectedStreamId],
  );
  usePageContext(
    () => {
      if (!selectedNode) return [];
      const items: ChatFabContextItem[] = [
        streamContextItem(
          {
            id: selectedNode.id,
            stream_id: selectedNode.stream_id,
            source_swarm_id: selectedNode.source_swarm_id,
            source_agent_id: selectedNode.source_agent_id,
            name: selectedNode.name,
            status: selectedNode.status,
            publish_branch: selectedNode.publish_branch ?? undefined,
            task_resource_id: selectedNode.task_resource_id ?? undefined,
            task_node_id: selectedNode.task_node_id ?? undefined,
            commit_count: selectedNode.commit_count,
            open_conflict_count: selectedNode.open_conflict_count,
            last_event_at: selectedNode.last_event_at,
            parent_stream_id: selectedNode.parent_stream_id ?? undefined,
          },
          { primary: true },
        ),
      ];
      if (selectedNode.task_resource_id && selectedNode.task_node_id) {
        items.push(
          taskContextItem({
            id: selectedNode.task_node_id,
            resource_id: selectedNode.task_resource_id,
          }),
        );
      }
      return items;
    },
    [selectedNode],
  );

  if (isLoading) return <PageLoader />;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b flex-wrap" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-base font-semibold flex items-center gap-2 shrink-0">
            <GitBranch className="w-4 h-4 text-honey-500" />
            Changes
          </h1>

          {/* Search */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
            <input
              type="text"
              placeholder="Search by name, id, or agent..."
              className="input text-xs py-1 pl-7 pr-2 w-56"
              value={searchRaw}
              onChange={(e) => setSearchRaw(e.target.value)}
            />
          </div>

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

          {/* Conflicts filter chip */}
          <button
            type="button"
            className={`text-2xs flex items-center gap-1 px-2 py-1 rounded-md border transition-colors${conflictsOnly ? ' bg-red-500/10' : ''}`}
            style={{
              borderColor: conflictsOnly ? 'var(--color-danger)' : 'var(--color-border)',
              color: conflictsOnly ? 'var(--color-danger)' : 'var(--color-text-muted)',
            }}
            onClick={() => setConflictsOnly((v) => !v)}
            aria-pressed={conflictsOnly}
          >
            <AlertTriangle className="w-3 h-3" />
            Conflicts only
          </button>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {filteredCount === totalCount
              ? `${totalCount} ${totalCount === 1 ? 'change' : 'changes'}`
              : `${filteredCount} of ${totalCount}`}
          </span>

          <ViewToggle mode={viewMode} onChange={setViewMode} />
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        <div className={`flex-1 ${viewMode === 'map' ? 'overflow-hidden' : 'overflow-auto'}`}>
          {!dag || dag.nodes.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No changes yet"
              description="A change appears here when a cascade-aware agent opens a stream and emits events to this hub."
            />
          ) : viewMode === 'list' ? (
            <ChangesList
              buckets={buckets}
              filteredCount={filteredCount}
              onSelect={selectStream}
              onViewStack={openStackFrom}
              onShowDiff={(streamRowId, commitHash) =>
                setDiffTarget({ streamRowId, commitHash })
              }
              selectedId={selectedStreamId}
            />
          ) : viewMode === 'stack' ? (
            <StreamStackView
              stack={stack}
              dag={dag}
              rootId={stackRootId}
              onSelectRoot={setStackRootId}
              onBackToList={() => { setStackRootId(null); setViewMode('list'); }}
              onSelect={selectStream}
              selectedId={selectedStreamId}
              onShowStackDiff={(rootRowId) =>
                setRangeDiffTarget({ mode: 'stack', rowId: rootRowId })
              }
              onOpenPRStack={(rootRowId, rootName) =>
                setPRStackTarget({ rowId: rootRowId, rootName })
              }
            />
          ) : (
            <StreamCascadeMap
              nodes={dag.nodes}
              edges={dag.edges}
              selectedId={selectedStreamId}
              onSelect={selectStream}
            />
          )}
        </div>

        {selectedStreamId && (
          <StreamDetailSidebar
            streamRowId={selectedStreamId}
            node={dag?.nodes.find((n) => n.id === selectedStreamId) ?? null}
            onClose={closeStream}
            onViewStack={openStackFrom}
            onViewGraph={() => setViewMode('map')}
            onShowStreamDiff={(streamRowId) =>
              setRangeDiffTarget({ mode: 'stream', rowId: streamRowId })
            }
            onShowDiff={(streamRowId, commitHash) =>
              setDiffTarget({ streamRowId, commitHash })
            }
          />
        )}
      </div>

      {/* Diff drawer — opens when the user clicks a commit row. Fixed
          right-aligned overlay; click backdrop or X to dismiss. */}
      {diffTarget && (
        <DiffDrawer
          streamRowId={diffTarget.streamRowId}
          commitHash={diffTarget.commitHash}
          onClose={() => setDiffTarget(null)}
        />
      )}

      {/* Range diff drawer — stream-level or stack-level cumulative diff.
          Wider than the per-commit drawer (two-pane file tree + content). */}
      {rangeDiffTarget && (
        <RangeDiffDrawer
          mode={rangeDiffTarget.mode}
          rowId={rangeDiffTarget.rowId}
          onClose={() => setRangeDiffTarget(null)}
        />
      )}

      {/* PR-stack drawer — "Open PR stack" workflow from stack view. */}
      {prStackTarget && (
        <PRStackDrawerOverlay
          rowId={prStackTarget.rowId}
          rootName={prStackTarget.rootName}
          onClose={() => setPRStackTarget(null)}
        />
      )}
    </div>
  );
}

// ─── PR Stack Drawer overlay ───────────────────────────────────────────

function PRStackDrawerOverlay({
  rowId,
  rootName,
  onClose,
}: {
  rowId: string;
  rootName?: string;
  onClose: () => void;
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-2xl p-3">
        <PRStackDrawer rootRowId={rowId} rootName={rootName} onClose={onClose} />
      </div>
    </>
  );
}

// ─── Diff Drawer ──────────────────────────────────────────────────────

function DiffDrawer({
  streamRowId,
  commitHash,
  onClose,
}: {
  streamRowId: string;
  commitHash: string;
  onClose: () => void;
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-3xl p-3">
        <DiffView
          streamRowId={streamRowId}
          commitHash={commitHash}
          onClose={onClose}
        />
      </div>
    </>
  );
}

// ─── Range Diff Drawer (stream-level + stack-level) ──────────────────

function RangeDiffDrawer({
  mode,
  rowId,
  onClose,
}: {
  mode: 'stream' | 'stack';
  rowId: string;
  onClose: () => void;
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      {/* Wider than DiffDrawer to host the file-tree + diff two-pane layout. */}
      <div className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-5xl p-3">
        <StackDiffView mode={mode} rowId={rowId} onClose={onClose} />
      </div>
    </>
  );
}

// ─── View Toggle ──────────────────────────────────────────────────────

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const items: Array<{ value: ViewMode; icon: JSX.Element; label: string; title: string }> = [
    { value: 'list',  icon: <Inbox   className="w-3.5 h-3.5" />, label: 'List',  title: 'Triaged list (default)' },
    { value: 'stack', icon: <Layers  className="w-3.5 h-3.5" />, label: 'Stack', title: 'Graphite-style stack from a root' },
    { value: 'map',   icon: <Network className="w-3.5 h-3.5" />, label: 'Map',   title: 'Branch map: structured DAG of parent/child + merges' },
  ];

  return (
    <div className="flex rounded-md border" style={{ borderColor: 'var(--color-border)' }}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          title={item.title}
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

// ─── Triaged List View ────────────────────────────────────────────────

type BucketConfig = {
  key: TriageBucket;
  label: string;
  Icon: typeof AlertTriangle;
  accent: string;
  defaultCollapsed: boolean;
  emptyHint?: string;
};

const BUCKET_CONFIG: BucketConfig[] = [
  {
    key: 'needs-attention',
    label: 'Needs attention',
    Icon: AlertTriangle,
    accent: 'var(--color-danger)',
    defaultCollapsed: false,
  },
  {
    key: 'in-progress',
    label: 'In progress',
    Icon: GitBranch,
    accent: 'var(--color-honey, #f59e0b)',
    defaultCollapsed: false,
  },
  {
    key: 'recently-landed',
    label: 'Recently landed',
    Icon: Clock,
    accent: 'var(--color-text-muted)',
    defaultCollapsed: true,
    emptyHint: 'Nothing landed in the last 7 days.',
  },
];

function ChangesList({
  buckets,
  filteredCount,
  onSelect,
  onViewStack,
  onShowDiff,
  selectedId,
}: {
  buckets: Record<TriageBucket, StreamDAGNode[]>;
  filteredCount: number;
  onSelect: (id: string) => void;
  onViewStack: (id: string) => void;
  onShowDiff: (streamRowId: string, commitHash: string) => void;
  selectedId: string | null;
}) {
  if (filteredCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <Inbox className="w-6 h-6 mb-2" style={{ color: 'var(--color-text-muted)' }} />
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          No changes match the current filters.
        </p>
      </div>
    );
  }

  return (
    <div className="py-1">
      {BUCKET_CONFIG.map((cfg) => (
        <BucketSection
          key={cfg.key}
          cfg={cfg}
          nodes={buckets[cfg.key]}
          onSelect={onSelect}
          onViewStack={onViewStack}
          onShowDiff={onShowDiff}
          selectedId={selectedId}
        />
      ))}
    </div>
  );
}

function BucketSection({
  cfg,
  nodes,
  onSelect,
  onViewStack,
  onShowDiff,
  selectedId,
}: {
  cfg: BucketConfig;
  nodes: StreamDAGNode[];
  onSelect: (id: string) => void;
  onViewStack: (id: string) => void;
  onShowDiff: (streamRowId: string, commitHash: string) => void;
  selectedId: string | null;
}) {
  const [collapsed, setCollapsed] = useState(cfg.defaultCollapsed);

  // Hide "recently landed" when empty to reduce chrome; always show the other
  // two so the user sees the expected triage shape.
  if (nodes.length === 0 && cfg.key === 'recently-landed') return null;

  const { Icon } = cfg;

  return (
    <section className="mb-2">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-4 py-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-honey-500/60"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        {collapsed
          ? <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
          : <ChevronDown  className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        }
        <Icon className="w-3.5 h-3.5" style={{ color: cfg.accent }} />
        <span className="text-2xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          {cfg.label}
        </span>
        <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {nodes.length}
        </span>
      </button>

      {!collapsed && (
        nodes.length === 0 ? (
          <p className="px-11 py-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {cfg.emptyHint ?? 'Nothing here.'}
          </p>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {nodes.map((node) => (
              <ChangeRow
                key={node.id}
                node={node}
                isSelected={selectedId === node.id}
                onSelect={() => onSelect(node.id)}
                onViewStack={() => onViewStack(node.id)}
                onShowDiff={(commitHash) => onShowDiff(node.id, commitHash)}
              />
            ))}
          </div>
        )
      )}
    </section>
  );
}

function ChangeRow({
  node,
  isSelected,
  onSelect,
  onViewStack,
  onShowDiff,
}: {
  node: StreamDAGNode;
  isSelected: boolean;
  onSelect: () => void;
  onViewStack: () => void;
  onShowDiff: (commitHash: string) => void;
}) {
  return (
    <button
      type="button"
      className="w-full text-left px-4 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-honey-500/60"
      style={{
        backgroundColor: isSelected ? 'var(--color-elevated)' : undefined,
      }}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <StreamStatusDot status={node.status} />
          <span className="text-sm font-medium truncate">{node.name || node.stream_id}</span>
          <code className="text-2xs font-mono px-1 py-0.5 rounded shrink-0" style={{ backgroundColor: 'var(--color-elevated)' }}>
            {node.stream_id.slice(0, 8)}
          </code>
          {node.status !== 'active' && (
            <span
              className="text-2xs px-1.5 py-0.5 rounded shrink-0"
              style={{
                backgroundColor: 'var(--color-elevated)',
                color: STATUS_COLORS[node.status] ?? 'var(--color-text-muted)',
              }}
            >
              {STATUS_LABELS[node.status] ?? node.status}
            </span>
          )}
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
          <button
            type="button"
            className="btn-ghost px-1.5 py-0.5 text-2xs"
            onClick={(e) => { e.stopPropagation(); onViewStack(); }}
            title="View as stack"
          >
            <Layers className="w-3 h-3" />
          </button>
        </div>
      </div>
    </button>
  );
}

// ─── Stack View (Graphite-style) ──────────────────────────────────────

function StreamStackView({
  stack,
  dag,
  rootId,
  onSelectRoot,
  onBackToList,
  onSelect,
  selectedId,
  onShowStackDiff,
  onOpenPRStack,
}: {
  stack: StreamDAGNode[] | null;
  dag: { nodes: StreamDAGNode[]; edges: StreamDAGEdge[] };
  rootId: string | null;
  onSelectRoot: (id: string | null) => void;
  onBackToList: () => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
  onShowStackDiff: (rootRowId: string) => void;
  onOpenPRStack: (rootRowId: string, rootName?: string) => void;
}) {
  const roots = dag.nodes.filter((n) => !n.parent_stream_id);

  if (!rootId || !stack) {
    return (
      <div className="p-4">
        <button
          type="button"
          className="btn-ghost text-2xs mb-3 flex items-center gap-1"
          onClick={onBackToList}
        >
          <ChevronRight className="w-3 h-3 rotate-180" />
          Back to list
        </button>
        <p className="text-sm mb-3" style={{ color: 'var(--color-text-muted)' }}>
          Select a root change to view its stack:
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
              No root changes found.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1"
          onClick={onBackToList}
        >
          <ChevronRight className="w-3 h-3 rotate-180" />
          Back to list
        </button>
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1"
          onClick={() => onShowStackDiff(rootId)}
          title="View cumulative diff across this stack"
        >
          <ListTree className="w-3 h-3" />
          View stack diff
        </button>
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1"
          onClick={() =>
            onOpenPRStack(rootId, stack?.[0]?.name ?? stack?.[0]?.stream_id)
          }
          title="Open one PR per unmerged stream in this stack"
        >
          <GitPullRequest className="w-3 h-3" />
          Open PR stack
        </button>
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1"
          onClick={() => onSelectRoot(null)}
        >
          Change root
        </button>
      </div>

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
            {commits.slice(0, 10).map((c, i) => {
              const hash = c.data.commit_hash as string | undefined;
              // role="button" rather than a real <button> — the change row
              // is itself a <button> for the whole-card click target; nesting
              // a real button inside trips DOM validation.
              return (
                <div
                  key={i}
                  role="button"
                  tabIndex={hash ? 0 : -1}
                  aria-disabled={!hash}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hash) onShowDiff(hash);
                  }}
                  onKeyDown={(e) => {
                    if (!hash) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      onShowDiff(hash);
                    }
                  }}
                  className={`text-2xs flex items-start gap-2 cursor-pointer
                             hover:bg-honey-500/5 transition-colors rounded px-1 -mx-1
                             focus:outline-none focus-visible:ring-1 focus-visible:ring-honey-500/60
                             ${!hash ? 'cursor-default hover:bg-transparent' : ''}`}
                  title={hash ? `View diff for ${hash}` : 'No commit hash'}
                >
                  <code className="font-mono shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    {hash?.slice(0, 7) ?? '???????'}
                  </code>
                  <span className="truncate">{c.data.message_summary as string}</span>
                </div>
              );
            })}
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

// ─── Detail Sidebar ───────────────────────────────────────────────────

type SidebarTab = 'details' | 'evolution';

function StreamDetailSidebar({
  streamRowId,
  node,
  onClose,
  onViewStack,
  onViewGraph,
  onShowDiff,
  onShowStreamDiff,
}: {
  streamRowId: string;
  node: StreamDAGNode | null;
  onClose: () => void;
  onViewStack: (streamRowId: string) => void;
  onViewGraph: () => void;
  onShowDiff: (streamRowId: string, commitHash: string) => void;
  onShowStreamDiff: (streamRowId: string) => void;
}) {
  const [tab, setTab] = useState<SidebarTab>('details');

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

      {/* Tabs */}
      <SidebarTabs tab={tab} onChange={setTab} />

      {tab === 'details' ? (
        <SidebarDetailsTab
          streamRowId={streamRowId}
          node={node}
          onViewStack={onViewStack}
          onViewGraph={onViewGraph}
          onShowStreamDiff={onShowStreamDiff}
        />
      ) : (
        <SidebarEvolutionTab
          streamRowId={streamRowId}
          node={node}
          onShowDiff={onShowDiff}
          onShowStreamDiff={onShowStreamDiff}
        />
      )}
    </div>
  );
}

// ─── Sidebar tabs ─────────────────────────────────────────────────────

function SidebarTabs({
  tab,
  onChange,
}: {
  tab: SidebarTab;
  onChange: (t: SidebarTab) => void;
}) {
  const items: Array<{ value: SidebarTab; label: string }> = [
    { value: 'details', label: 'Details' },
    { value: 'evolution', label: 'Evolution' },
  ];
  return (
    <div
      className="flex border-b shrink-0"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      {items.map((item) => {
        const active = item.value === tab;
        return (
          <button
            key={item.value}
            type="button"
            className="flex-1 text-2xs py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-honey-500/60"
            style={{
              color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
              borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent',
              marginBottom: '-1px',
              fontWeight: active ? 600 : 400,
            }}
            onClick={() => onChange(item.value)}
            aria-pressed={active}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Sidebar bodies ───────────────────────────────────────────────────

function SidebarDetailsTab({
  streamRowId,
  node,
  onViewStack,
  onViewGraph,
  onShowStreamDiff,
}: {
  streamRowId: string;
  node: StreamDAGNode | null;
  onViewStack: (streamRowId: string) => void;
  onViewGraph: () => void;
  onShowStreamDiff: (streamRowId: string) => void;
}) {
  return (
    <div className="flex-1 overflow-auto">
      {node && (
        <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <LineageRail anchor={{ kind: 'stream', node }} />
        </div>
      )}

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

      {node && <ConflictReportingNote node={node} />}

      {node && <StreamActions streamRowId={streamRowId} node={node} />}

      {node && (
        <div className="px-3 py-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <button
            type="button"
            className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
            onClick={() => onViewStack(streamRowId)}
            title="View this change within its stack"
          >
            <Layers className="w-3 h-3" />
            Stack
          </button>
          <button
            type="button"
            className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
            onClick={onViewGraph}
            title="View the full branch map centered here"
          >
            <Network className="w-3 h-3" />
            Map
          </button>
          <button
            type="button"
            className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
            onClick={() => onShowStreamDiff(streamRowId)}
            title="View cumulative diff for this stream (base..head)"
          >
            <ListTree className="w-3 h-3" />
            Stream diff
          </button>
        </div>
      )}

      {node && node.status !== 'merged' && node.status !== 'abandoned' && (
        <>
          <StreamBranchSection streamRowId={streamRowId} node={node} />
          <StreamPRSection streamRowId={streamRowId} node={node} />
          <StreamCommitSection streamRowId={streamRowId} node={node} />
        </>
      )}
    </div>
  );
}

function SidebarEvolutionTab({
  streamRowId,
  node,
  onShowDiff,
  onShowStreamDiff,
}: {
  streamRowId: string;
  node: StreamDAGNode | null;
  onShowDiff: (streamRowId: string, commitHash: string) => void;
  onShowStreamDiff: (streamRowId: string) => void;
}) {
  const { data: timelineResp, isLoading } = useCascadeStreamTimeline(streamRowId);
  const timeline = timelineResp?.data ?? [];

  // Commits first, then the full chronological event stream below them. The
  // commit-first list is the primary affordance for "trace through changes" —
  // each row jumps to its diff. Other events (merge, conflict, push, rebase)
  // stay visible underneath so the full history is one scroll away.
  const commits = useMemo(
    () => timeline.filter((e) => e.type === 'commit'),
    [timeline],
  );
  const nonCommits = useMemo(
    () => timeline.filter((e) => e.type !== 'commit'),
    [timeline],
  );

  return (
    <div className="flex-1 overflow-auto p-3">
      {/* Stream-diff CTA — the "what does this whole stream change?" answer.
          Top of the tab so it's the first thing the reader sees. */}
      {node && (
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1 w-full justify-center mb-3 border rounded"
          style={{ borderColor: 'var(--color-border-subtle)' }}
          onClick={() => onShowStreamDiff(streamRowId)}
          title="Cumulative diff across all commits in this stream"
        >
          <ListTree className="w-3 h-3" />
          View cumulative diff
        </button>
      )}

      <h4 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
        <GitCommit className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        Commits
        <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
          {commits.length}
        </span>
      </h4>
      {isLoading ? (
        <div className="text-2xs animate-pulse" style={{ color: 'var(--color-text-muted)' }}>Loading...</div>
      ) : commits.length === 0 ? (
        <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>No commits yet.</div>
      ) : (
        <div className="space-y-0 mb-4">
          {commits.map((event, idx) => {
            const hash = event.data?.commit_hash as string | undefined;
            if (!hash) return <TimelineEntry key={idx} event={event} />;
            return (
              <div
                key={idx}
                role="button"
                tabIndex={0}
                onClick={() => onShowDiff(streamRowId, hash)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onShowDiff(streamRowId, hash);
                  }
                }}
                title={`View diff for ${hash.slice(0, 7)}`}
                className="cursor-pointer rounded -mx-1 px-1 hover:bg-honey-500/5
                           focus:outline-none focus-visible:ring-1 focus-visible:ring-honey-500/60"
              >
                <TimelineEntry event={event} />
              </div>
            );
          })}
        </div>
      )}

      {nonCommits.length > 0 && (
        <>
          <h4 className="text-xs font-semibold mb-2 flex items-center gap-1.5 mt-3">
            <Clock className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
            Other events
            <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
              {nonCommits.length}
            </span>
          </h4>
          <div className="space-y-0">
            {nonCommits.map((event, idx) => (
              <TimelineEntry key={idx} event={event} />
            ))}
          </div>
        </>
      )}
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
  // Push is a cascade action — gated on the owning swarm's canAct, same as
  // merge/pause/abandon. Editing the branch *alias* is hub-local and stays
  // available regardless (it never dispatches to the runtime).
  const { canAct } = useCascadeCapability(node);

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
            disabled={pushAction.isPending || !canAct}
            title={canAct ? 'Push to remote' : CASCADE_ACT_DISABLED_REASON}
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
  // Commit dispatches an `x-cascade/request.commit` — gated on canAct like
  // the other action requests.
  const { canAct } = useCascadeCapability(node);

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
              disabled={commitAction.isPending || !message.trim() || !canAct}
              title={canAct ? undefined : CASCADE_ACT_DISABLED_REASON}
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
          disabled={!canAct}
          title={canAct ? undefined : CASCADE_ACT_DISABLED_REASON}
        >
          <GitCommit className="w-3 h-3" />
          Commit changes
        </button>
      )}
    </div>
  );
}

// ─── Conflict-reporting capability note ───────────────────────────────

function ConflictReportingNote({ node }: { node: StreamDAGNode }) {
  const { emitsConflicts } = useCascadeCapability(node);
  if (emitsConflicts) return null;
  return (
    <div
      className="px-3 py-1.5 text-2xs border-b"
      style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-muted)' }}
    >
      This swarm does not report cascade conflicts.
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
  // Per-stream gate: an observe-only swarm (cascade.canAct !== true) silently
  // no-ops any action request, so render the buttons disabled with a reason
  // rather than hide them — a vanished button reads as a bug; a disabled one
  // teaches the operator (and the model) why nothing happens.
  const { canAct } = useCascadeCapability(node);

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

  // Buttons are disabled either while a request is in flight or when the
  // owning swarm doesn't accept cascade actions. The capability tooltip
  // wins so the operator sees *why* the control is dead.
  const disabled = isPending || !canAct;
  const gateTitle = (active: string) => (canAct ? active : CASCADE_ACT_DISABLED_REASON);

  return (
    <div className="px-3 py-2 border-b flex flex-wrap gap-1.5" style={{ borderColor: 'var(--color-border-subtle)' }}>
      {/* Merge — available when active and has a parent */}
      {isActive && node.parent_stream_id && (
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
          onClick={() => fire('merge')}
          disabled={disabled}
          title={gateTitle('Request merge into parent stream')}
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
          disabled={disabled}
          title={gateTitle('Pause this change')}
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
          disabled={disabled}
          title={gateTitle('Resume this change')}
        >
          <Play className="w-3 h-3" />
          Resume
        </button>
      )}

      {/* Force-resolve — escape hatch. Agents usually handle conflicts on their
          own; this button exists for the rare case where a human has to break
          the deadlock by taking 'ours'. */}
      {isConflicted && node.open_conflict_count > 0 && (
        <button
          type="button"
          className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
          style={{ color: 'var(--color-danger)' }}
          onClick={() => fire('resolve', { strategy: 'ours' })}
          disabled={disabled}
          title={gateTitle(
            "Force-resolve with 'ours'. Agents usually handle conflicts themselves — use only if stuck.",
          )}
        >
          <Wrench className="w-3 h-3" />
          Force resolve
        </button>
      )}

      {/* Abandon — available when not terminal */}
      <button
        type="button"
        className="btn-ghost text-2xs flex items-center gap-1 px-2 py-1"
        style={{ color: 'var(--color-text-muted)' }}
        onClick={() => fire('abandon', { reason: 'operator-abandoned' })}
        disabled={disabled}
        title={gateTitle('Abandon this change')}
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

      {/* Observe-only note — surfaces the reason once for the whole group. */}
      {!canAct && (
        <span className="text-2xs w-full" style={{ color: 'var(--color-text-muted)' }}>
          {CASCADE_ACT_DISABLED_REASON}
        </span>
      )}
    </div>
  );
}

// TimelineEntry and StreamStatusDot imported from ../components/streams/shared
