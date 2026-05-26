/**
 * StreamCascadeMap — React Flow + dagre branch graph for cascade streams.
 *
 * Replaces the prior sigma.js force-directed view (`StreamDAGView`). Layout
 * is deterministic left-to-right by depth; cards render as HTML nodes via
 * `StreamNodeCard`. Selection lifts to the parent (`Changes.tsx`) so the
 * detail sidebar stays in sync across List / Stack / Map views.
 */

import { useMemo, useCallback, memo, useEffect, useState } from 'react';
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

import type { StreamDAGNode, StreamDAGEdge } from '../../hooks/useApi';
import { StreamNodeCard } from './StreamNodeCard';
import { layoutCascadeDAG } from './layout/dagreLayout';
import { STATUS_COLORS } from './shared';
import { useThemeStore } from '../../stores/theme';

/**
 * Resolve CSS custom-property values to concrete colors. React Flow renders
 * edges as SVG `stroke` (which accepts `var(...)` in modern browsers) but the
 * `markerEnd.color` prop is consumed by React Flow as a string and written
 * into a generated `<marker>` definition's fill — `var(...)` is not reliable
 * there. Resolving once at theme-switch time means every value is a real hex
 * by the time it reaches the SVG.
 */
function resolveToken(name: string): string {
  if (typeof window === 'undefined') return '#666';
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim() || '#666';
}

interface ResolvedTokens {
  accent: string;
  border: string;
  borderSubtle: string;
  surface: string;
}

function useResolvedTokens(): ResolvedTokens {
  // Re-resolve when the resolved theme flips so dark→light recoloring
  // doesn't leave stale stroke/marker fills baked into the SVG.
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const [tokens, setTokens] = useState<ResolvedTokens>(() => ({
    accent: resolveToken('--color-accent'),
    border: resolveToken('--color-border'),
    borderSubtle: resolveToken('--color-border-subtle'),
    surface: resolveToken('--color-surface'),
  }));
  useEffect(() => {
    setTokens({
      accent: resolveToken('--color-accent'),
      border: resolveToken('--color-border'),
      borderSubtle: resolveToken('--color-border-subtle'),
      surface: resolveToken('--color-surface'),
    });
  }, [resolvedTheme]);
  return tokens;
}

const NODE_TYPES = { streamCard: StreamNodeCard };

interface StreamCascadeMapProps {
  nodes: StreamDAGNode[];
  edges: StreamDAGEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function StreamCascadeMapInner({
  nodes,
  edges,
  selectedId,
  onSelect,
}: StreamCascadeMapProps) {
  const rf = useReactFlow();
  const tokens = useResolvedTokens();

  // Re-run layout only when the DAG shape changes — node id set or edge set.
  // Selection + status changes do not need a new layout.
  const fingerprint = useMemo(() => {
    const nIds = nodes.map((n) => n.id).sort().join(',');
    const eKeys = edges
      .map((e) => `${e.type}:${e.source}->${e.target}`)
      .sort()
      .join(',');
    return `${nIds}|${eKeys}`;
  }, [nodes, edges]);

  const positions = useMemo(
    () => layoutCascadeDAG(nodes, edges),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fingerprint],
  );

  const rfNodes = useMemo<Node<StreamDAGNode>[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: 'streamCard',
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: n,
        selected: n.id === selectedId,
        draggable: false,
      })),
    [nodes, positions, selectedId],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => {
        const isMerge = e.type === 'merge';
        const color = isMerge ? tokens.accent : tokens.border;
        return {
          id: `${e.type}:${e.source}->${e.target}`,
          source: e.source,
          target: e.target,
          type: 'smoothstep',
          animated: false,
          style: {
            stroke: color,
            strokeWidth: 1.5,
            strokeDasharray: isMerge ? '4 4' : undefined,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color,
            width: 16,
            height: 16,
          },
        };
      }),
    [edges, tokens.accent, tokens.border],
  );

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      onSelect(node.id);
    },
    [onSelect],
  );

  const handleNodeDoubleClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      const pos = node.position;
      // Card is anchored at top-left; aim at its visual center.
      rf.setCenter(pos.x + 120, pos.y + 48, { zoom: 1.1, duration: 350 });
    },
    [rf],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={NODE_TYPES}
      onNodeClick={handleNodeClick}
      onNodeDoubleClick={handleNodeDoubleClick}
      onPaneClick={() => onSelect(null)}
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
          const data = n.data as StreamDAGNode | undefined;
          return data ? STATUS_COLORS[data.status] ?? '#6b7280' : '#6b7280';
        }}
        maskColor="rgb(0 0 0 / 0.4)"
        style={{
          background: tokens.surface,
          border: `1px solid ${tokens.borderSubtle}`,
        }}
      />
    </ReactFlow>
  );
}

const StreamCascadeMapMemo = memo(StreamCascadeMapInner);

export function StreamCascadeMap(props: StreamCascadeMapProps) {
  // ReactFlowProvider is required so children can use `useReactFlow()` to
  // drive the camera (double-click-to-center).
  return (
    <ReactFlowProvider>
      <StreamCascadeMapMemo {...props} />
    </ReactFlowProvider>
  );
}
