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
  Controls,
  MiniMap,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from 'reactflow';
import 'reactflow/dist/style.css';
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
}

type ResolvedTokens = {
  accent: string;
  border: string;
  borderSubtle: string;
  surface: string;
};

function resolveToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

function useTokens(): ResolvedTokens {
  return useMemo(
    () => ({
      accent: resolveToken('--color-accent', '#f59e0b'),
      border: resolveToken('--color-border', '#35373b'),
      borderSubtle: resolveToken('--color-border-subtle', '#2c2d31'),
      surface: resolveToken('--color-surface', '#1c1d20'),
    }),
    [],
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
}: TaskHierarchyViewProps) {
  const tokens = useTokens();
  const { data: swarmsRaw } = useMapSwarms();
  const swarms: MapSwarm[] | undefined = swarmsRaw?.data;
  const rf = useReactFlow();

  // Self-contained selection — mirrors TaskGraphViewer's pattern. Each view
  // owns its own sidebar so switching tabs doesn't carry selection state
  // (deliberate for v1; cross-view sync can lift to TaskGraph.tsx later).
  const [selectedNode, setSelectedNode] = useState<OpenTasksGraphNode | null>(
    null,
  );
  const selectedNodeId = selectedNode?.id ?? null;
  const onSelectNode = useCallback(
    (n: OpenTasksGraphNode | null) => setSelectedNode(n),
    [],
  );

  const [scopeKnobs, setScopeKnobs] = useState<ScopeKnobs>({
    includeTerminal: false,
    includeAuxTypes: false,
  });
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
    setLayoutState((prev) => ({ ...prev, pending: true, error: null }));
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
      out.push({
        id: node.id,
        type: 'taskCard',
        position: pos,
        data: {
          node,
          swarm,
          sourceColor,
          colorMode,
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
    overlay = (
      <HierarchyEmpty
        scopeKnobs={scopeKnobs}
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
        <button
          type="button"
          onClick={() =>
            setScopeKnobs((p) => ({ ...p, includeTerminal: !p.includeTerminal }))
          }
          style={{
            padding: '2px 8px',
            borderRadius: 12,
            border: `1px solid ${scopeKnobs.includeTerminal ? tokens.accent : tokens.border}`,
            background: scopeKnobs.includeTerminal
              ? 'transparent'
              : 'var(--color-elevated)',
            color: scopeKnobs.includeTerminal
              ? tokens.accent
              : 'var(--color-text)',
            cursor: 'pointer',
            fontSize: 10.5,
          }}
        >
          {scopeKnobs.includeTerminal ? 'all statuses' : 'active only'}
        </button>
        <button
          type="button"
          onClick={() =>
            setScopeKnobs((p) => ({ ...p, includeAuxTypes: !p.includeAuxTypes }))
          }
          style={{
            padding: '2px 8px',
            borderRadius: 12,
            border: `1px solid ${scopeKnobs.includeAuxTypes ? tokens.accent : tokens.border}`,
            background: scopeKnobs.includeAuxTypes
              ? 'transparent'
              : 'var(--color-elevated)',
            color: scopeKnobs.includeAuxTypes
              ? tokens.accent
              : 'var(--color-text)',
            cursor: 'pointer',
            fontSize: 10.5,
          }}
        >
          {scopeKnobs.includeAuxTypes ? '+ notes & context' : 'tasks only'}
        </button>
        <span
          style={{
            marginLeft: 8,
            color: 'var(--color-text-muted)',
            fontSize: 10.5,
          }}
        >
          {clustered.nodes.length} in view
          {clustered.clusters.size > 0
            ? ` · ${clustered.clusters.size} cluster${clustered.clusters.size > 1 ? 's' : ''}`
            : ''}
        </span>
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
        <Controls
          showInteractive={false}
          style={{
            background: tokens.surface,
            border: `1px solid ${tokens.borderSubtle}`,
          }}
        />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const data = n.data as TaskHierarchyCardData | undefined;
            const status = data?.node.status ?? 'open';
            return STATUS_COLORS[status] ?? '#6b7280';
          }}
          maskColor="rgb(0 0 0 / 0.4)"
          style={{
            background: tokens.surface,
            border: `1px solid ${tokens.borderSubtle}`,
          }}
        />
      </ReactFlow>

      {overlay}
    </div>

    {/* Shared sidebar — same TaskGraphSidebar the Network view uses. */}
    <TaskGraphSidebar
      node={selectedNode}
      resourceId={resourceId}
      selectedEdge={null}
      onClose={() => setSelectedNode(null)}
      onSelectNode={(n) => setSelectedNode(n)}
      edges={allEdges}
      allNodes={allNodes}
    />
    </div>
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
  onIncludeTerminal,
}: {
  scopeKnobs: ScopeKnobs;
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
      <p style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
        No active work in scope.
      </p>
      {!scopeKnobs.includeTerminal && (
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
