/**
 * TaskGraphViewer — Main sigma.js canvas for rendering the task DAG.
 *
 * Renders the graphology graph using sigma.js, applies a force-directed layout,
 * and handles node click → sidebar interaction.
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import Sigma from 'sigma';
import { random as randomLayout } from 'graphology-layout';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type Graph from 'graphology';
import { TaskGraphSidebar } from './TaskGraphSidebar';
import { STATUS_COLORS } from './useTaskGraph';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { applySigmaPerfSettings } from '../../utils/sigmaPerf';
import type { OpenTasksGraphNode } from '../../lib/api';

interface Props {
  graph: Graph;
  resourceId: string;
  onNodeSelect?: (node: OpenTasksGraphNode | null) => void;
}

export function TaskGraphViewer({ graph, resourceId, onNodeSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const [selectedNode, setSelectedNode] = useState<OpenTasksGraphNode | null>(null);

  // Apply layout on mount or when graph changes
  useEffect(() => {
    if (!graph || graph.order === 0) return;

    // Apply initial random positions
    randomLayout.assign(graph);

    // Run ForceAtlas2 for a fixed number of iterations
    forceAtlas2.assign(graph, {
      iterations: 100,
      settings: {
        gravity: 1,
        scalingRatio: 2,
        barnesHutOptimize: graph.order > 100,
        strongGravityMode: true,
      },
    });
  }, [graph]);

  // Initialize sigma renderer
  useEffect(() => {
    if (!containerRef.current || !graph || graph.order === 0) return;

    const sigma = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: false,
      defaultEdgeType: 'arrow',
      defaultNodeColor: STATUS_COLORS.open,
      defaultEdgeColor: '#4b556340',
      labelColor: { color: '#d1d2d3' },
      labelFont: 'Inter, system-ui, sans-serif',
      labelSize: 11,
      labelRenderedSizeThreshold: 6,
      edgeLabelColor: { color: '#7a7b7e' },
    });

    sigmaRef.current = sigma;
    applySigmaPerfSettings(sigma, graph.order);

    // Click handler for node selection
    sigma.on('clickNode', ({ node }) => {
      const nodeData = graph.getNodeAttributes(node);
      const data = (nodeData._data as OpenTasksGraphNode) || { id: node, type: 'task', ...nodeData };
      setSelectedNode(data);
      onNodeSelect?.(data);
    });

    sigma.on('clickStage', () => {
      setSelectedNode(null);
      onNodeSelect?.(null);
    });

    return () => {
      sigma.kill();
      sigmaRef.current = null;
    };
  }, [graph, onNodeSelect]);

  const handleZoomIn = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const camera = sigma.getCamera();
    camera.animatedZoom({ duration: 200 });
  }, []);

  const handleZoomOut = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const camera = sigma.getCamera();
    camera.animatedUnzoom({ duration: 200 });
  }, []);

  const handleFitView = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const camera = sigma.getCamera();
    camera.animatedReset({ duration: 300 });
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSelectedNode(null);
    onNodeSelect?.(null);
  }, [onNodeSelect]);

  return (
    <div className="flex h-full">
      {/* Canvas */}
      <div className="flex-1 relative" style={{ backgroundColor: 'var(--color-bg)' }}>
        <div ref={containerRef} className="w-full h-full" />

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

        {/* Legend */}
        <div
          className="absolute bottom-3 left-3 p-2 rounded text-2xs space-y-1"
          style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}
        >
          {Object.entries(STATUS_COLORS).map(([status, color]) => (
            <div key={status} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
              <span style={{ color: 'var(--color-text-muted)' }}>{status.replace('_', ' ')}</span>
            </div>
          ))}
        </div>

        {/* Empty state */}
        {graph.order === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>No nodes in graph</p>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <TaskGraphSidebar node={selectedNode} resourceId={resourceId} onClose={handleCloseSidebar} />
    </div>
  );
}
