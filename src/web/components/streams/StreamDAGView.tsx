/**
 * StreamDAGView — sigma.js graph rendering of cascade stream relationships.
 *
 * Reuses the same sigma.js + graphology + ForceAtlas2 stack as TaskGraph.
 * Nodes = streams (colored by status, sized by commit count).
 * Edges = parent→child (solid arrow) + merge (dashed arrow).
 */

import { useRef, useEffect, useState, useCallback, memo } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import FA2LayoutSupervisor from 'graphology-layout-forceatlas2/worker';
import { createEdgeArrowProgram } from 'sigma/rendering';
import type { StreamDAGNode, StreamDAGEdge } from '../../hooks/useApi';

const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e',
  paused: '#f59e0b',
  merged: '#6b7280',
  abandoned: '#4b5563',
  conflicted: '#ef4444',
};

const MERGE_EDGE_COLOR = '#8b5cf6';
const PARENT_EDGE_COLOR = '#6b7280';

function hashPosition(id: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) % 10000) / 100;
}

interface StreamDAGViewProps {
  nodes: StreamDAGNode[];
  edges: StreamDAGEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function StreamDAGViewInner({ nodes, edges, selectedId, onSelect }: StreamDAGViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const supervisorRef = useRef<FA2LayoutSupervisor | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const fingerprint = (() => {
    if (nodes.length === 0) return '';
    const ids = nodes.map((n) => n.id).sort().join(',');
    return `${ids}|${edges.length}`;
  })();

  // Build graph + mount sigma
  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;

    // Cleanup previous
    if (supervisorRef.current) {
      try { supervisorRef.current.stop(); } catch { /* */ }
      supervisorRef.current = null;
    }
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }

    const graph = new Graph({ type: 'directed', multi: true });
    graphRef.current = graph;

    for (const node of nodes) {
      graph.addNode(node.id, {
        label: node.name || node.stream_id,
        size: Math.max(6, Math.min(20, 6 + Math.log2(node.commit_count + 1) * 3)),
        color: STATUS_COLORS[node.status] ?? '#6b7280',
        x: hashPosition(node.id, 0x9E37),
        y: hashPosition(node.id, 0x7F4A),
        _data: node,
      });
    }

    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const edge of edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      graph.addEdge(edge.source, edge.target, {
        type: 'arrow',
        size: edge.type === 'merge' ? 1.5 : 2.5,
        color: edge.type === 'merge' ? MERGE_EDGE_COLOR : PARENT_EDGE_COLOR,
        forceLabel: false,
      });
    }

    const BigArrowProgram = createEdgeArrowProgram({
      widenessToThicknessRatio: 3,
      lengthToThicknessRatio: 3.5,
    });

    const sigma = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: true,
      renderEdgeLabels: false,
      defaultEdgeType: 'arrow',
      edgeProgramClasses: { arrow: BigArrowProgram },
      labelFont: 'Inter, system-ui, sans-serif',
      labelSize: 11,
      labelColor: { color: '#d1d2d3' },
      labelRenderedSizeThreshold: 4,
      zoomDuration: 200,
      inertiaDuration: 500,
      stagePadding: 40,
    });
    sigmaRef.current = sigma;

    // ForceAtlas2 layout
    const supervisor = new FA2LayoutSupervisor(graph, {
      settings: {
        gravity: 1.0,
        scalingRatio: 4,
        barnesHutOptimize: graph.order > 30,
        strongGravityMode: true,
        slowDown: 10,
      },
    });
    supervisorRef.current = supervisor;
    supervisor.start();
    setTimeout(() => {
      try { supervisor.stop(); } catch { /* */ }
    }, 2500);

    // Events
    sigma.on('clickNode', ({ node }) => {
      onSelect(node);
      const attrs = graph.getNodeAttributes(node);
      sigma.getCamera().animate(
        {
          x: attrs.x,
          y: attrs.y,
          ratio: 0.5,
        },
        { duration: 400 },
      );
    });

    sigma.on('clickStage', () => {
      onSelect(null);
    });

    sigma.on('enterNode', ({ node }) => {
      setHoveredNode(node);
      sigma.refresh({ skipIndexation: true });
    });

    sigma.on('leaveNode', () => {
      setHoveredNode(null);
      sigma.refresh({ skipIndexation: true });
    });

    // Reducer: dim non-hovered non-selected nodes
    sigma.setSetting('nodeReducer', (node, data) => {
      const res = { ...data };
      if (hoveredNode && node !== hoveredNode && node !== selectedId) {
        res.color = '#333';
        res.label = '';
      }
      return res;
    });

    return () => {
      if (supervisorRef.current) {
        try { supervisorRef.current.stop(); } catch { /* */ }
        supervisorRef.current = null;
      }
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  // Update reducer when selection/hover changes
  useEffect(() => {
    const sigma = sigmaRef.current;
    const graph = graphRef.current;
    if (!sigma || !graph) return;

    sigma.setSetting('nodeReducer', (node, data) => {
      const res = { ...data };
      if (node === selectedId) {
        res.highlighted = true;
        res.zIndex = 1;
      } else if (hoveredNode && node !== hoveredNode) {
        // Check adjacency
        const isNeighbor =
          graph.hasEdge(hoveredNode, node) || graph.hasEdge(node, hoveredNode);
        if (!isNeighbor) {
          res.color = '#333';
          res.label = '';
        }
      }
      return res;
    });

    sigma.setSetting('edgeReducer', (edge, data) => {
      const res = { ...data };
      if (hoveredNode) {
        const source = graph.source(edge);
        const target = graph.target(edge);
        if (source !== hoveredNode && target !== hoveredNode) {
          res.hidden = true;
        }
      }
      return res;
    });

    sigma.refresh({ skipIndexation: true });
  }, [hoveredNode, selectedId]);

  if (nodes.length === 0) return null;

  return (
    <div className="w-full h-full relative overflow-hidden" style={{ minHeight: '400px' }}>
      <div ref={containerRef} className="absolute inset-0" />
      {/* Legend */}
      <div
        className="absolute bottom-3 left-3 flex items-center gap-3 text-2xs px-2 py-1.5 rounded"
        style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border-subtle)' }}
      >
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#22c55e' }} /> Active
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#ef4444' }} /> Conflicted
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#f59e0b' }} /> Paused
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#6b7280' }} /> Merged
        </span>
        <span className="flex items-center gap-1 ml-2">
          <span className="w-4 border-t-2" style={{ borderColor: PARENT_EDGE_COLOR }} /> Parent
        </span>
        <span className="flex items-center gap-1">
          <span className="w-4 border-t-2 border-dashed" style={{ borderColor: MERGE_EDGE_COLOR }} /> Merge
        </span>
      </div>
    </div>
  );
}

export const StreamDAGView = memo(StreamDAGViewInner);
