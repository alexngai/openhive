import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import { random as randomLayout } from 'graphology-layout';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { ZoomIn, ZoomOut, Maximize2, X, Network } from 'lucide-react';
import { applySigmaPerfSettings } from '../../../utils/sigmaPerf';
import { useSkillGraph } from '../../../hooks/useApi';
import type { SkillGraphNode, SkillGraphEdge } from '../../../lib/api';

const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e',
  draft: '#3b82f6',
  experimental: '#f59e0b',
  deprecated: '#6b7280',
};

const EDGE_COLORS: Record<string, string> = {
  depends_on: '#ef4444',
  extends: '#3b82f6',
  alternative: '#f59e0b',
  related: '#6b7280',
  derived_from: '#7c3aed',
  fork: '#14b8a6',
};

function buildGraph(nodes: SkillGraphNode[], edges: SkillGraphEdge[]) {
  const g = new Graph({ type: 'directed', multi: false });

  for (const node of nodes) {
    g.addNode(node.id, {
      label: node.name || node.id,
      size: 8,
      color: STATUS_COLORS[node.status] || STATUS_COLORS.draft,
      x: Math.random() * 100,
      y: Math.random() * 100,
      _data: node,
    });
  }

  for (const edge of edges) {
    if (g.hasNode(edge.from) && g.hasNode(edge.to)) {
      try {
        g.addEdge(edge.from, edge.to, {
          type: 'arrow',
          size: 1.5,
          color: EDGE_COLORS[edge.type] || '#4b5563',
          label: edge.type.replace('_', ' '),
          _data: edge,
        });
      } catch { /* skip duplicate */ }
    }
  }

  return g;
}

function GraphSidebar({ nodeData, onClose }: { nodeData: SkillGraphNode | null; onClose: () => void }) {
  if (!nodeData) return null;

  return (
    <div className="w-72 shrink-0 overflow-y-auto border-l p-4 space-y-3" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">{nodeData.name || nodeData.id}</h3>
        <button onClick={onClose} className="btn-ghost p-1 shrink-0 cursor-pointer"><X className="w-4 h-4" /></button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-2xs px-1.5 py-0.5 rounded" style={{ backgroundColor: (STATUS_COLORS[nodeData.status] || '#6b7280') + '18', color: STATUS_COLORS[nodeData.status] || '#6b7280' }}>
          {nodeData.status}
        </span>
        {nodeData.version && <span className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)' }}>v{nodeData.version}</span>}
      </div>

      {nodeData.description && <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{nodeData.description}</p>}

      {nodeData.taxonomy?.primaryPath && (
        <div className="text-2xs" style={{ color: 'var(--color-accent)' }}>{nodeData.taxonomy.primaryPath.join(' / ')}</div>
      )}

      {nodeData.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {nodeData.tags.map(t => (
            <span key={t} className="text-2xs px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>{t}</span>
          ))}
        </div>
      )}

      <div className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)' }}>{nodeData.id}</div>
    </div>
  );
}

export function SkillGraph({ resourceId }: { resourceId: string }) {
  const { data, isLoading } = useSkillGraph(resourceId);
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const [selectedNode, setSelectedNode] = useState<SkillGraphNode | null>(null);

  const graph = useMemo(() => {
    if (!data?.nodes?.length) return null;
    return buildGraph(data.nodes, data.edges || []);
  }, [data]);

  useEffect(() => {
    if (!graph || graph.order === 0) return;
    randomLayout.assign(graph);
    forceAtlas2.assign(graph, {
      iterations: 100,
      settings: { gravity: 1, scalingRatio: 2, barnesHutOptimize: graph.order > 50, strongGravityMode: true },
    });
  }, [graph]);

  useEffect(() => {
    if (!containerRef.current || !graph || graph.order === 0) return;

    const sigma = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: true,
      defaultEdgeType: 'arrow',
      defaultNodeColor: '#6b7280',
      defaultEdgeColor: '#4b556340',
      labelColor: { color: '#d1d2d3' },
      labelFont: 'Inter, system-ui, sans-serif',
      labelSize: 11,
      labelRenderedSizeThreshold: 4,
      edgeLabelColor: { color: '#7a7b7e' },
      edgeLabelSize: 9,
    });

    sigmaRef.current = sigma;
    applySigmaPerfSettings(sigma, graph.order);

    sigma.on('clickNode', ({ node }) => {
      const attrs = graph.getNodeAttributes(node);
      setSelectedNode(attrs._data as SkillGraphNode);
    });
    sigma.on('clickStage', () => setSelectedNode(null));

    return () => { sigma.kill(); sigmaRef.current = null; };
  }, [graph]);

  const handleZoomIn = useCallback(() => sigmaRef.current?.getCamera().animatedZoom({ duration: 200 }), []);
  const handleZoomOut = useCallback(() => sigmaRef.current?.getCamera().animatedUnzoom({ duration: 200 }), []);
  const handleFitView = useCallback(() => sigmaRef.current?.getCamera().animatedReset({ duration: 300 }), []);

  if (isLoading) return <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading skill graph...</div>;

  if (!graph || graph.order === 0) {
    return (
      <div className="py-8 text-center">
        <Network className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No skill relationships found</p>
        <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>Skills with relationships, related fields, or forks will appear here</p>
      </div>
    );
  }

  return (
    <div className="flex" style={{ height: 400 }}>
      <div className="flex-1 relative rounded-md overflow-hidden" style={{ backgroundColor: 'var(--color-bg)' }}>
        <div ref={containerRef} className="w-full h-full" />

        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <button onClick={handleZoomIn} className="btn-ghost p-1 rounded cursor-pointer" style={{ backgroundColor: 'var(--color-surface)' }}><ZoomIn className="w-3.5 h-3.5" /></button>
          <button onClick={handleZoomOut} className="btn-ghost p-1 rounded cursor-pointer" style={{ backgroundColor: 'var(--color-surface)' }}><ZoomOut className="w-3.5 h-3.5" /></button>
          <button onClick={handleFitView} className="btn-ghost p-1 rounded cursor-pointer" style={{ backgroundColor: 'var(--color-surface)' }}><Maximize2 className="w-3.5 h-3.5" /></button>
        </div>

        {/* Legend */}
        <div className="absolute bottom-2 left-2 p-1.5 rounded text-2xs" style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}>
          <div className="space-y-0.5 mb-1.5">
            {Object.entries(STATUS_COLORS).map(([status, color]) => (
              <div key={status} className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                <span style={{ color: 'var(--color-text-muted)' }}>{status}</span>
              </div>
            ))}
          </div>
          <div className="border-t pt-1 space-y-0.5" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {Object.entries(EDGE_COLORS).map(([type, color]) => (
              <div key={type} className="flex items-center gap-1">
                <div className="w-3 h-0.5" style={{ backgroundColor: color }} />
                <span style={{ color: 'var(--color-text-muted)' }}>{type.replace('_', ' ')}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="absolute top-2 left-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {graph.order} skills, {graph.size} relationships
        </div>
      </div>

      <GraphSidebar nodeData={selectedNode} onClose={() => setSelectedNode(null)} />
    </div>
  );
}
