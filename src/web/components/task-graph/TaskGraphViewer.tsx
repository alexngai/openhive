/**
 * TaskGraphViewer — Obsidian-inspired sigma.js canvas for rendering the task DAG.
 *
 * Features:
 * - Continuous ForceAtlas2 physics via web worker supervisor
 * - Node drag with physics response
 * - Hover → highlight neighbors, dim rest
 * - Subtle node glow on dark background
 * - Depth/hop filter from selected node
 * - Smooth camera follow on node select
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import Sigma from 'sigma';
import { random as randomLayout } from 'graphology-layout';
import FA2LayoutSupervisor from 'graphology-layout-forceatlas2/worker';
import type Graph from 'graphology';
import { TaskGraphSidebar } from './TaskGraphSidebar';
import { STATUS_COLORS } from './useTaskGraph';
import { ZoomIn, ZoomOut, Maximize2, GitFork } from 'lucide-react';
import { applySigmaPerfSettings } from '../../utils/sigmaPerf';
import type { OpenTasksGraphNode } from '../../lib/api';

interface Props {
  graph: Graph;
  resourceId: string;
  onNodeSelect?: (node: OpenTasksGraphNode | null) => void;
  edges?: import('../../lib/api').OpenTasksGraphEdge[];
  allNodes?: OpenTasksGraphNode[];
  /** Map of graph ID → display name, for multi-graph legend */
  graphSources?: Map<string, { name: string; color: string }>;
}

/** Hex color → rgba with alpha */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Get all neighbors of a node (both directions) */
function getNeighborSet(graph: Graph, nodeKey: string): Set<string> {
  const neighbors = new Set<string>();
  graph.forEachNeighbor(nodeKey, (neighbor) => neighbors.add(neighbor));
  return neighbors;
}

/** Get nodes within N hops of a source node */
function getNodesWithinHops(graph: Graph, source: string, maxHops: number): Set<string> {
  const visited = new Set<string>([source]);
  let frontier = [source];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      graph.forEachNeighbor(node, (neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          nextFrontier.push(neighbor);
        }
      });
    }
    frontier = nextFrontier;
  }

  return visited;
}

export function TaskGraphViewer({ graph, resourceId, onNodeSelect, edges = [], allNodes = [], graphSources }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const supervisorRef = useRef<FA2LayoutSupervisor | null>(null);
  const [selectedNode, setSelectedNode] = useState<OpenTasksGraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [depthFilter, setDepthFilter] = useState<number>(0); // 0 = show all
  const dragStateRef = useRef<{
    dragging: boolean;
    node: string | null;
    startX: number;
    startY: number;
  }>({ dragging: false, node: null, startX: 0, startY: 0 });

  // Apply initial random positions
  useEffect(() => {
    if (!graph || graph.order === 0) return;
    randomLayout.assign(graph);
  }, [graph]);

  // Initialize sigma renderer + FA2 supervisor
  useEffect(() => {
    if (!containerRef.current || !graph || graph.order === 0) return;

    // Custom node hover drawing with glow
    const drawNodeHover = (
      context: CanvasRenderingContext2D,
      data: { x: number; y: number; size: number; color: string; label?: string | null },
    ) => {
      const { x, y, size, color } = data;

      // Outer glow rings
      for (let i = 3; i >= 1; i--) {
        context.beginPath();
        context.arc(x, y, size + i * 3, 0, Math.PI * 2);
        context.fillStyle = hexToRgba(color, 0.08 * (4 - i));
        context.fill();
        context.closePath();
      }

      // Node circle
      context.beginPath();
      context.arc(x, y, size, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
      context.closePath();

      // Label
      if (data.label) {
        const fontSize = Math.max(11, size * 1.2);
        context.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
        context.fillStyle = '#e5e6e8';
        context.textAlign = 'center';
        context.textBaseline = 'top';
        context.fillText(data.label, x, y + size + 4);
      }

      // Source graph ring (multi-graph mode)
      const borderCol = (data as any).borderColor;
      if (borderCol) {
        context.beginPath();
        context.arc(x, y, size + 1.5, 0, Math.PI * 2);
        context.strokeStyle = borderCol;
        context.lineWidth = 1.5;
        context.stroke();
        context.closePath();
      }
    };

    // Custom node label drawing — adds source graph ring in multi-graph mode
    const drawNodeLabel = (
      context: CanvasRenderingContext2D,
      data: { x: number; y: number; size: number; color: string; label?: string | null; borderColor?: string | null },
      settings: { labelFont: string; labelSize: number; labelColor: { color: string } },
    ) => {
      // Draw source graph ring (always visible, not just on hover)
      const borderCol = (data as any).borderColor;
      if (borderCol) {
        context.beginPath();
        context.arc(data.x, data.y, data.size + 2, 0, Math.PI * 2);
        context.strokeStyle = borderCol;
        context.lineWidth = 2;
        context.stroke();
        context.closePath();
      }

      // Draw label text
      if (data.label) {
        context.font = `${settings.labelSize}px ${settings.labelFont}`;
        context.fillStyle = settings.labelColor.color;
        context.textAlign = 'left';
        context.textBaseline = 'middle';
        context.fillText(data.label, data.x + data.size + 4, data.y);
      }
    };

    const sigma = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: false,
      defaultEdgeType: 'arrow',
      defaultNodeColor: STATUS_COLORS.open,
      defaultEdgeColor: '#4b556320',
      labelColor: { color: '#d1d2d3' },
      labelFont: 'Inter, system-ui, sans-serif',
      labelSize: 11,
      labelRenderedSizeThreshold: 6,
      edgeLabelColor: { color: '#7a7b7e' },
      defaultDrawNodeLabel: drawNodeLabel as any,
      defaultDrawNodeHover: drawNodeHover as any,
      // Smooth interactions
      zoomDuration: 200,
      inertiaDuration: 500,
      inertiaRatio: 0.5,
    });

    sigmaRef.current = sigma;
    applySigmaPerfSettings(sigma, graph.order);

    // ---------- Hover highlighting ----------
    sigma.on('enterNode', ({ node }) => {
      setHoveredNode(node);
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on('leaveNode', () => {
      setHoveredNode(null);
      sigma.refresh({ skipIndexation: true });
    });

    // ---------- Node click ----------
    sigma.on('clickNode', ({ node }) => {
      // If we just finished a drag, don't treat it as a click
      if (dragStateRef.current.dragging) return;

      const nodeData = graph.getNodeAttributes(node);
      const data = (nodeData._data as OpenTasksGraphNode) || { id: node, type: 'task', ...nodeData };
      setSelectedNode(data);
      onNodeSelect?.(data);

      // Smooth camera follow
      const position = { x: nodeData.x as number, y: nodeData.y as number };
      const camera = sigma.getCamera();
      camera.animate(
        { x: position.x, y: position.y, ratio: Math.min(camera.ratio, 0.7) },
        { duration: 400 },
      );
    });

    sigma.on('clickStage', () => {
      if (dragStateRef.current.dragging) return;
      setSelectedNode(null);
      onNodeSelect?.(null);
    });

    // ---------- Node drag ----------
    let draggedNode: string | null = null;

    sigma.on('downNode', ({ node, event }) => {
      draggedNode = node;
      dragStateRef.current = {
        dragging: false,
        node,
        startX: event.x,
        startY: event.y,
      };

      // Fix the node position so FA2 doesn't move it
      graph.setNodeAttribute(node, 'fixed', true);

      // Prevent camera movement during drag
      sigma.getCamera().disable();
    });

    // Use the renderer's mouse move (works everywhere on canvas)
    sigma.getMouseCaptor().on('mousemovebody', (event: { x: number; y: number; original: MouseEvent }) => {
      if (!draggedNode) return;

      // Detect actual dragging (moved > 3px)
      const dx = event.x - dragStateRef.current.startX;
      const dy = event.y - dragStateRef.current.startY;
      if (!dragStateRef.current.dragging && Math.sqrt(dx * dx + dy * dy) > 3) {
        dragStateRef.current.dragging = true;
      }

      // Convert viewport coords to graph coords
      const pos = sigma.viewportToGraph({ x: event.x, y: event.y });
      graph.setNodeAttribute(draggedNode, 'x', pos.x);
      graph.setNodeAttribute(draggedNode, 'y', pos.y);
    });

    const handleMouseUp = () => {
      if (draggedNode) {
        graph.removeNodeAttribute(draggedNode, 'fixed');
        draggedNode = null;
        sigma.getCamera().enable();

        // Small delay so the click handler can check dragStateRef
        setTimeout(() => {
          dragStateRef.current = { dragging: false, node: null, startX: 0, startY: 0 };
        }, 50);
      }
    };
    sigma.getMouseCaptor().on('mouseup', handleMouseUp);
    // Also catch mouseup outside the canvas
    document.addEventListener('mouseup', handleMouseUp);

    // ---------- Start FA2 supervisor ----------
    const supervisor = new FA2LayoutSupervisor(graph, {
      settings: {
        gravity: 0.5,
        scalingRatio: 3,
        barnesHutOptimize: graph.order > 50,
        strongGravityMode: true,
        slowDown: 5, // Gentler settling
      },
    });
    supervisorRef.current = supervisor;
    supervisor.start();

    // Stop physics after settling (but keep responsive to drags)
    const settleTimer = setTimeout(() => {
      // Reduce gravity for a calmer resting state, but keep running
      // so drags cause natural spring-back
    }, 3000);

    return () => {
      clearTimeout(settleTimer);
      supervisor.kill();
      supervisorRef.current = null;
      document.removeEventListener('mouseup', handleMouseUp);
      sigma.kill();
      sigmaRef.current = null;
    };
  }, [graph, onNodeSelect]);

  // ---------- Node/edge reducers for hover + depth filtering ----------
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma || !graph) return;

    // Compute depth-visible set
    let depthVisible: Set<string> | null = null;
    if (depthFilter > 0 && selectedNode) {
      depthVisible = getNodesWithinHops(graph, selectedNode.id, depthFilter);
    }

    sigma.setSetting('nodeReducer', (node: string, data: Record<string, any>) => {
      const result = { ...data };

      // Depth filter: hide nodes outside hop range
      if (depthVisible && !depthVisible.has(node)) {
        result.hidden = true;
        return result;
      }

      // Hover highlight: dim non-neighbors
      if (hoveredNode && hoveredNode !== node) {
        const neighbors = getNeighborSet(graph, hoveredNode);
        if (!neighbors.has(node)) {
          result.color = hexToRgba(data.color || STATUS_COLORS.open, 0.15);
          result.label = null; // hide label for dimmed nodes
        }
      }

      // Add subtle glow via increased size for hovered node
      if (hoveredNode === node) {
        result.size = (data.size || 8) * 1.3;
        result.zIndex = 10;
      }

      return result;
    });

    sigma.setSetting('edgeReducer', (edge: string, data: Record<string, any>) => {
      const result = { ...data };
      const source = graph.source(edge);
      const target = graph.target(edge);

      // Depth filter
      if (depthVisible && (!depthVisible.has(source) || !depthVisible.has(target))) {
        result.hidden = true;
        return result;
      }

      // Hover highlight
      if (hoveredNode) {
        if (source === hoveredNode || target === hoveredNode) {
          // Highlight connected edges
          result.color = '#d1d2d380';
          result.size = 2.5;
        } else {
          result.color = '#4b556308';
          result.size = 0.5;
        }
      }

      return result;
    });

    sigma.refresh({ skipIndexation: true });
  }, [hoveredNode, depthFilter, selectedNode, graph]);

  const handleZoomIn = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    sigma.getCamera().animatedZoom({ duration: 200 });
  }, []);

  const handleZoomOut = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    sigma.getCamera().animatedUnzoom({ duration: 200 });
  }, []);

  const handleFitView = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    sigma.getCamera().animatedReset({ duration: 300 });
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSelectedNode(null);
    onNodeSelect?.(null);
    setDepthFilter(0);
  }, [onNodeSelect]);

  return (
    <div className="flex h-full">
      {/* Canvas */}
      <div className="flex-1 relative" style={{ backgroundColor: 'var(--color-bg)' }}>
        <div ref={containerRef} className="w-full h-full" style={{ cursor: 'grab' }} />

        {/* Controls overlay */}
        <div className="absolute top-3 right-3 flex flex-col gap-1">
          <button onClick={handleZoomIn} className="btn-ghost p-1.5 rounded" style={{ backgroundColor: 'var(--color-surface)' }}>
            <ZoomIn className="w-4 h-4" />
          </button>
          <button onClick={handleZoomOut} className="btn-ghost p-1.5 rounded" style={{ backgroundColor: 'var(--color-surface)' }}>
            <ZoomOut className="w-4 h-4" />
          </button>
          <button onClick={handleFitView} className="btn-ghost p-1.5 rounded" style={{ backgroundColor: 'var(--color-surface)' }}>
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>

        {/* Depth filter (shown when a node is selected) */}
        {selectedNode && (
          <div
            className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-lg"
            style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}
          >
            <GitFork className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
            <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Depth</span>
            <input
              type="range"
              min={0}
              max={5}
              value={depthFilter}
              onChange={(e) => setDepthFilter(Number(e.target.value))}
              className="w-20 h-1 accent-amber-500"
              title={depthFilter === 0 ? 'Show all' : `${depthFilter} hop${depthFilter > 1 ? 's' : ''}`}
            />
            <span className="text-2xs font-mono w-8" style={{ color: 'var(--color-text-muted)' }}>
              {depthFilter === 0 ? 'All' : `${depthFilter}h`}
            </span>
          </div>
        )}

        {/* Legend */}
        <div
          className="absolute bottom-3 left-3 p-2 rounded text-2xs space-y-1"
          style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}
        >
          {Object.entries(STATUS_COLORS).map(([status, color]) => (
            <div key={status} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 6px ${hexToRgba(color, 0.5)}` }} />
              <span style={{ color: 'var(--color-text-muted)' }}>{status.replace('_', ' ')}</span>
            </div>
          ))}
        </div>

        {/* Graph sources legend (multi-graph) */}
        {graphSources && graphSources.size > 1 && (
          <div
            className="absolute bottom-3 left-40 p-2 rounded text-2xs space-y-1"
            style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}
          >
            <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>Graphs</div>
            {Array.from(graphSources.entries()).map(([id, { name, color }]) => (
              <div key={id} className="flex items-center gap-1.5">
                <div
                  className="w-2.5 h-2.5 rounded-full border-2"
                  style={{ borderColor: color, backgroundColor: 'transparent' }}
                />
                <span className="truncate max-w-[120px]" style={{ color: 'var(--color-text-muted)' }}>{name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Physics indicator */}
        <div className="absolute bottom-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded" style={{ backgroundColor: 'var(--color-surface)' }}>
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Physics</span>
        </div>

        {/* Empty state */}
        {graph.order === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>No nodes in graph</p>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <TaskGraphSidebar node={selectedNode} resourceId={resourceId} onClose={handleCloseSidebar} edges={edges} allNodes={allNodes} />
    </div>
  );
}
