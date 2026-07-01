/**
 * TaskHierarchyView — path B. Layered top-to-bottom dependency view.
 *
 * Companion to the existing Network/Graph view (path A). Uses React Flow +
 * ELK so cards render as proper HTML nodes with a deterministic structured
 * layout. Default scope is "active work only" + upstream blockers; large
 * fan-outs collapse via leaf clustering (click to expand).
 *
 * Selection lifts to `TaskGraph.tsx` so switching between Network / Hierarchy
 * keeps the same sidebar target.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import ReactFlow, {
  Background,
  MiniMap,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './taskHierarchy.css';
import { Network, ListTree } from 'lucide-react';

import type {
  OpenTasksGraphNode,
  OpenTasksGraphEdge,
  MapSwarm,
} from '../../lib/api';
import { useMapSwarms } from '../../hooks/useApi';
import { resolveAssigneeSwarm } from '../swarm/SwarmChip';
import { STATUS_COLORS } from './useTaskGraph';
import { scopeActiveWork } from './layout/scopeActiveWork';
import { clusterLeaves, CLUSTER_NODE_TYPE } from './layout/leafClustering';
import {
  summarizeHierarchyView,
  formatHierarchySummarySuffix,
} from './layout/viewSummary';
import {
  layoutHierarchy,
  HIERARCHY_CARD_WIDTH,
  HIERARCHY_CARD_HEIGHT,
  HIERARCHY_CLUSTER_HEIGHT,
} from './layout/elkHierarchyLayout';
import {
  TaskHierarchyCard,
  swarmColorFor,
  SWARM_UNASSIGNED_COLOR,
  type TaskHierarchyCardData,
} from './TaskHierarchyCard';
import { TaskGraphSidebar } from './TaskGraphSidebar';
import { StatusLegend, GraphSourcesLegend } from './MapLegends';
import { MapControls } from './MapControls';
import { useThemeStore } from '../../stores/theme';

const NODE_TYPES = { taskCard: TaskHierarchyCard };

interface TaskHierarchyViewProps {
  /** Full unscoped node list (raw from useTaskGraph / multi-graph merge). */
  allNodes: OpenTasksGraphNode[];
  /** Full unscoped edge list. */
  allEdges: OpenTasksGraphEdge[];
  /** Owning task resource id — needed for the shared sidebar's mutations. */
  resourceId: string;
  /** Honey accent for the toolbar toggle / link. */
  colorMode: 'status' | 'swarm';
  /** Multi-graph source legend — same shape that Network view receives.
   *  When present and size > 1, the Graphs legend renders top-right.
   *  Undefined in single-graph mode. */
  graphSources?: Map<string, { name: string; color: string }>;
  /** Lifted selection — owned by TaskGraph.tsx so view-switch keeps target. */
  selectedTaskId?: string | null;
  onSelectTask?: (node: OpenTasksGraphNode | null) => void;
}

type ResolvedTokens = {
  accent: string;
  border: string;
  borderSubtle: string;
  surface: string;
  /** Page background — used as the MiniMap mask base color so it adapts to
   *  the active theme (dark = near-black mask, light = near-white). */
  bg: string;
};

function resolveToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

function useTokens(): ResolvedTokens {
  // Subscribe to the resolved theme so a runtime light/dark flip recomputes
  // every hex used in React Flow's SVG layer (edges, markers, MiniMap mask),
  // which can't accept `var(...)` references.
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  return useMemo(
    () => ({
      accent: resolveToken('--color-accent', '#f59e0b'),
      border: resolveToken('--color-border', '#35373b'),
      borderSubtle: resolveToken('--color-border-subtle', '#2c2d31'),
      surface: resolveToken('--color-surface', '#1c1d20'),
      bg: resolveToken('--color-bg', '#0f1011'),
    }),
    // resolvedTheme drives the recompute — its value is the key for staleness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedTheme],
  );
}

interface ScopeKnobs {
  includeTerminal: boolean;
  includeAuxTypes: boolean;
}

function TaskHierarchyViewInner({
  allNodes,
  allEdges,
  resourceId,
  colorMode,
  graphSources,
  selectedTaskId,
  onSelectTask,
}: TaskHierarchyViewProps) {
  const tokens = useTokens();
  const { data: swarmsRaw } = useMapSwarms();
  const swarms: MapSwarm[] | undefined = swarmsRaw?.data;
  const rf = useReactFlow();

  // Lifted selection — TaskGraph.tsx owns the id; we look up the full node
  // from `allNodes` so the sidebar / handlers don't need the parent to
  // hydrate a node every time.
  const selectedNodeId = selectedTaskId ?? null;
  const selectedNode = useMemo(
    () =>
      selectedNodeId
        ? allNodes.find((n) => n.id === selectedNodeId) ?? null
        : null,
    [selectedNodeId, allNodes],
  );
  const onSelectNode = useCallback(
    (n: OpenTasksGraphNode | null) => onSelectTask?.(n),
    [onSelectTask],
  );

  // Persist scope knobs across reloads (view + card mode are already
  // persisted elsewhere; keeping this consistent stops users from re-dialling
  // their filters every time).
  const [scopeKnobs, setScopeKnobs] = useState<ScopeKnobs>(() => {
    try {
      const raw = localStorage.getItem('openhive-task-hierarchy-scope');
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ScopeKnobs>;
        return {
          includeTerminal: !!parsed.includeTerminal,
          includeAuxTypes: !!parsed.includeAuxTypes,
        };
      }
    } catch {
      /* ignore */
    }
    return { includeTerminal: false, includeAuxTypes: false };
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        'openhive-task-hierarchy-scope',
        JSON.stringify(scopeKnobs),
      );
    } catch {
      /* ignore */
    }
  }, [scopeKnobs]);
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleCluster = useCallback((clusterId: string) => {
    setExpandedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });
  }, []);

  // Pipe nodes/edges through scope → cluster, then ELK. ELK is async, so the
  // result is held in state and updates when the pipeline shape changes.
  const scoped = useMemo(
    () => scopeActiveWork(allNodes, allEdges, scopeKnobs),
    [allNodes, allEdges, scopeKnobs],
  );
  const clustered = useMemo(
    () =>
      clusterLeaves(scoped.nodes, scoped.edges, {
        expanded: expandedClusters,
      }),
    [scoped.nodes, scoped.edges, expandedClusters],
  );

  // Prune cluster ids whose parent has *left the graph entirely* (deleted /
  // archived / out of multi-graph selection). Keyed on `allNodes` (graph
  // membership), NOT `scoped.nodes` (scope filter) — otherwise toggling
  // "active only" silently collapses a cluster the user had expanded, which
  // reads as a state-loss bug.
  useEffect(() => {
    setExpandedClusters((prev) => {
      let dirty = false;
      const next = new Set<string>();
      for (const id of prev) {
        const parentId = id.replace(/^leaf-cluster:/, '');
        if (allNodes.some((n) => n.id === parentId)) next.add(id);
        else dirty = true;
      }
      return dirty ? next : prev;
    });
  }, [allNodes]);

  // Fingerprint pinned to node ids + edge keys + expanded cluster ids — only
  // re-run ELK when the laid-out shape changes.
  const fingerprint = useMemo(() => {
    const nids = clustered.nodes
      .map((n) => n.id)
      .sort()
      .join(',');
    const eids = clustered.edges
      .map((e) => `${e.type}:${e.from_id}->${e.to_id}`)
      .sort()
      .join(',');
    return `${nids}|${eids}`;
  }, [clustered.nodes, clustered.edges]);

  const [layoutState, setLayoutState] = useState<{
    fingerprint: string;
    positions: Map<string, { x: number; y: number }>;
    ranking: { from: string; to: string; type: string }[];
    decoration: { from: string; to: string; type: string }[];
    pending: boolean;
    error: string | null;
  }>({
    fingerprint: '',
    positions: new Map(),
    ranking: [],
    decoration: [],
    pending: false,
    error: null,
  });

  useEffect(() => {
    if (clustered.nodes.length === 0) {
      setLayoutState({
        fingerprint,
        positions: new Map(),
        ranking: [],
        decoration: [],
        pending: false,
        error: null,
      });
      return;
    }
    let cancelled = false;
    // Clear positions on fingerprint change so rfNodes doesn't silently
    // drop new nodes (rfNodes skips nodes without a position). Without this,
    // a graph swap leaves the user staring at fewer cards than the scope
    // bar reports until ELK B resolves.
    setLayoutState((prev) =>
      prev.fingerprint === fingerprint
        ? { ...prev, pending: true, error: null }
        : {
            fingerprint,
            positions: new Map(),
            ranking: [],
            decoration: [],
            pending: true,
            error: null,
          },
    );
    layoutHierarchy(clustered.nodes, clustered.edges)
      .then((res) => {
        if (cancelled) return;
        setLayoutState({
          fingerprint,
          positions: res.positions,
          ranking: res.rankingEdges,
          decoration: res.decorationEdges,
          pending: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setLayoutState((prev) => ({
          ...prev,
          pending: false,
          error: msg,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [fingerprint, clustered.nodes, clustered.edges]);

  // React Flow nodes — wrap each node + lookup swarm/source for the card.
  const rfNodes = useMemo<Node<TaskHierarchyCardData>[]>(() => {
    const out: Node<TaskHierarchyCardData>[] = [];
    for (const node of clustered.nodes) {
      const pos = layoutState.positions.get(node.id);
      if (!pos) continue;
      const resolvedSwarm = resolveAssigneeSwarm(
        node.assignee ?? null,
        swarms,
      );
      const swarm = resolvedSwarm
        ? {
            id: resolvedSwarm.id,
            name: resolvedSwarm.name,
            color: swarmColorFor(resolvedSwarm.id),
          }
        : node.assignee
          ? {
              id: '__unassigned__',
              name: 'unassigned',
              color: SWARM_UNASSIGNED_COLOR,
            }
          : null;
      const sourceColor =
        ((node as { _sourceColor?: string })._sourceColor) ?? null;
      // A node is "ancestor-only" if it isn't a seed (didn't pass the active
      // filter on its own) and isn't a synthetic cluster. The visual tag +
      // muted opacity in TaskNodeCard explains why a `completed` task is
      // appearing in an "active only" scope.
      const isAncestor =
        node.type !== CLUSTER_NODE_TYPE && !scoped.seedIds.has(node.id);
      out.push({
        id: node.id,
        type: 'taskCard',
        position: pos,
        data: {
          node,
          swarm,
          sourceColor,
          colorMode,
          isAncestor,
          onToggleCluster: toggleCluster,
        },
        selected: node.id === selectedNodeId,
        draggable: false,
        width:
          node.type === CLUSTER_NODE_TYPE
            ? HIERARCHY_CARD_WIDTH
            : HIERARCHY_CARD_WIDTH,
        height:
          node.type === CLUSTER_NODE_TYPE
            ? HIERARCHY_CLUSTER_HEIGHT
            : HIERARCHY_CARD_HEIGHT,
      });
    }
    return out;
  }, [
    clustered.nodes,
    layoutState.positions,
    swarms,
    colorMode,
    selectedNodeId,
    toggleCluster,
    scoped.seedIds,
  ]);

  // React Flow edges — ranking = solid, decoration (related, etc.) = dashed.
  const rfEdges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    for (const e of layoutState.ranking) {
      out.push({
        id: `r:${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        type: 'smoothstep',
        style: { stroke: tokens.border, strokeWidth: 1.5 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: tokens.border,
          width: 16,
          height: 16,
        },
      });
    }
    for (const e of layoutState.decoration) {
      out.push({
        id: `d:${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        type: 'smoothstep',
        style: {
          stroke: tokens.accent,
          strokeWidth: 1.2,
          strokeDasharray: '4 4',
          opacity: 0.7,
        },
      });
    }
    return out;
  }, [layoutState.ranking, layoutState.decoration, tokens]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      const data = node.data as TaskHierarchyCardData | undefined;
      if (!data || data.node.type === CLUSTER_NODE_TYPE) return;
      onSelectNode(data.node);
      const pos = node.position;
      rf.setCenter(
        pos.x + HIERARCHY_CARD_WIDTH / 2,
        pos.y + HIERARCHY_CARD_HEIGHT / 2,
        { zoom: Math.max(rf.getZoom(), 1), duration: 300 },
      );
    },
    [onSelectNode, rf],
  );

  // Empty/loading/error states share the same overlay frame as the canvas.
  let overlay: ReactNode = null;
  if (layoutState.pending && rfNodes.length === 0) {
    overlay = <HierarchyMessage>Laying out…</HierarchyMessage>;
  } else if (layoutState.error) {
    overlay = (
      <HierarchyMessage tone="danger">
        Layout failed — {layoutState.error}
      </HierarchyMessage>
    );
  } else if (clustered.nodes.length === 0) {
    // Count what the user would gain by relaxing the active-only filter, so
    // the empty state doesn't read as "your graph is empty" when it's just
    // "all your tasks are completed/failed".
    const hiddenByActiveFilter = allNodes.filter(
      (n) =>
        n.type === 'task' &&
        !n.archived &&
        !['open', 'in_progress', 'blocked'].includes(n.status ?? 'open'),
    ).length;
    overlay = (
      <HierarchyEmpty
        scopeKnobs={scopeKnobs}
        hiddenByActiveFilter={hiddenByActiveFilter}
        onIncludeTerminal={() =>
          setScopeKnobs((p) => ({ ...p, includeTerminal: true }))
        }
      />
    );
  }

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>
    <div
      style={{
        position: 'relative',
        flex: 1,
        minWidth: 0,
        height: '100%',
        background: 'var(--color-bg)',
      }}
    >
      {/* Scope bar */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          zIndex: 5,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: tokens.surface,
          border: `1px solid ${tokens.borderSubtle}`,
          borderRadius: 8,
          fontSize: 11,
          color: 'var(--color-text-muted)',
        }}
      >
        <ListTree size={14} />
        <span>Scope:</span>
        <ScopePill
          label="Active only"
          // ON when we're hiding terminal statuses (the filter is engaged).
          on={!scopeKnobs.includeTerminal}
          tokens={tokens}
          onToggle={() =>
            setScopeKnobs((p) => ({ ...p, includeTerminal: !p.includeTerminal }))
          }
          title="When on, hide completed and failed tasks (their upstream blockers still show)."
        />
        <ScopePill
          label="Tasks only"
          on={!scopeKnobs.includeAuxTypes}
          tokens={tokens}
          onToggle={() =>
            setScopeKnobs((p) => ({ ...p, includeAuxTypes: !p.includeAuxTypes }))
          }
          title="When on, hide notes / context / feedback / external nodes."
        />
        <span
          style={{
            marginLeft: 8,
            color: 'var(--color-text-muted)',
            fontSize: 10.5,
          }}
        >
          {clustered.nodes.length} in view
          {formatHierarchySummarySuffix(
            summarizeHierarchyView(
              clustered.nodes,
              clustered.clusters,
              scoped.seedIds,
            ),
          )}
        </span>
        {expandedClusters.size > 0 && (
          <button
            type="button"
            onClick={() => setExpandedClusters(new Set())}
            style={{
              marginLeft: 6,
              padding: '2px 8px',
              borderRadius: 12,
              border: `1px solid ${tokens.borderSubtle}`,
              background: 'transparent',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              fontSize: 10.5,
            }}
            title="Re-collapse all expanded leaf clusters"
          >
            Reset clusters
          </button>
        )}
        <span
          style={{
            marginLeft: 6,
            color: 'var(--color-text-muted)',
            fontSize: 10.5,
            opacity: 0.7,
            borderLeft: `1px solid ${tokens.borderSubtle}`,
            paddingLeft: 8,
          }}
          title="Wiring dependencies needs the Network view's link mode"
        >
          To wire dependencies, switch to Network ↗
        </span>
      </div>

      {/* Legends — mirror Network view's top-left layout. Placed top-right
          here so they don't collide with the scope bar. */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 5,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <StatusLegend />
        {graphSources && graphSources.size > 1 && (
          <GraphSourcesLegend graphSources={graphSources} />
        )}
      </div>

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        onNodeClick={handleNodeClick}
        onPaneClick={() => onSelectNode(null)}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1, minZoom: 0.2 }}
        minZoom={0.15}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} color={tokens.borderSubtle} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const data = n.data as TaskHierarchyCardData | undefined;
            if (!data) return '#6b7280';
            // In swarm color-mode, use the resolved swarm color so the
            // MiniMap decodes the same way as the cards. Falls back to
            // status colour for cluster nodes and the unassigned case.
            if (colorMode === 'swarm') {
              return data.swarm?.color ?? '#6b7280';
            }
            const status = data.node.status ?? 'open';
            return STATUS_COLORS[status] ?? '#6b7280';
          }}
          // Mask base color = page bg with ~60% alpha. Adapts to theme via
          // the bg token, so the MiniMap doesn't look like a black puddle on
          // a light canvas.
          maskColor={`${tokens.bg}99`}
          style={{
            background: tokens.surface,
            border: `1px solid ${tokens.borderSubtle}`,
          }}
        />
      </ReactFlow>

      {/* Shared zoom controls — matches the Network view's chrome. */}
      <MapControls
        onZoomIn={() => rf.zoomIn({ duration: 200 })}
        onZoomOut={() => rf.zoomOut({ duration: 200 })}
        onFitView={() => rf.fitView({ duration: 300, padding: 0.2 })}
      />

      {overlay}
    </div>

    {/* Shared sidebar — same TaskGraphSidebar the Network view uses. */}
    <TaskGraphSidebar
      node={selectedNode}
      resourceId={resourceId}
      selectedEdge={null}
      onClose={() => onSelectNode(null)}
      onSelectNode={(n) => onSelectNode(n)}
      edges={allEdges}
      allNodes={allNodes}
    />
    </div>
  );
}

/**
 * ScopePill — boolean filter chip with aria-pressed + a clearly filled
 * "active" state. Replaces the earlier two-label toggle whose styling
 * inverted what a user typically reads as on/off.
 */
function ScopePill({
  label,
  on,
  onToggle,
  tokens,
  title,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  tokens: ResolvedTokens;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={title}
      style={{
        padding: '2px 8px 2px 6px',
        borderRadius: 12,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        border: `1px solid ${on ? tokens.accent : tokens.borderSubtle}`,
        background: on ? `${tokens.accent}1f` : 'transparent',
        color: on ? tokens.accent : 'var(--color-text-muted)',
        cursor: 'pointer',
        fontSize: 10.5,
        fontWeight: on ? 600 : 400,
        transition: 'background 120ms, border-color 120ms, color 120ms',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: on ? tokens.accent : 'transparent',
          border: `1px solid ${on ? tokens.accent : tokens.border}`,
          color: 'var(--color-bg)',
          fontSize: 8,
          lineHeight: 1,
        }}
        aria-hidden
      >
        {on ? '✓' : ''}
      </span>
      {label}
    </button>
  );
}

function HierarchyMessage({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'danger';
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        color:
          tone === 'danger'
            ? 'var(--color-danger)'
            : 'var(--color-text-muted)',
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}

function HierarchyEmpty({
  scopeKnobs,
  hiddenByActiveFilter,
  onIncludeTerminal,
}: {
  scopeKnobs: ScopeKnobs;
  hiddenByActiveFilter: number;
  onIncludeTerminal: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
      }}
    >
      <Network
        size={28}
        style={{ color: 'var(--color-text-muted)' }}
      />
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 13, margin: 0 }}>
          No active work in scope.
        </p>
        {!scopeKnobs.includeTerminal && hiddenByActiveFilter > 0 && (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 11, margin: 0, opacity: 0.8 }}>
            {hiddenByActiveFilter} completed / failed task
            {hiddenByActiveFilter === 1 ? '' : 's'} hidden by the active-only filter.
          </p>
        )}
      </div>
      {!scopeKnobs.includeTerminal && hiddenByActiveFilter > 0 && (
        <button
          type="button"
          onClick={onIncludeTerminal}
          style={{
            padding: '4px 10px',
            borderRadius: 4,
            border: '1px solid var(--color-border)',
            background: 'var(--color-elevated)',
            color: 'var(--color-text)',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Show all statuses
        </button>
      )}
    </div>
  );
}

const TaskHierarchyViewMemo = memo(TaskHierarchyViewInner);

export function TaskHierarchyView(props: TaskHierarchyViewProps) {
  // ReactFlowProvider required so children can call useReactFlow() for
  // camera panning on click.
  return (
    <ReactFlowProvider>
      <TaskHierarchyViewMemo {...props} />
    </ReactFlowProvider>
  );
}
