import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import { random as randomLayout } from 'graphology-layout';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { ZoomIn, ZoomOut, Maximize2, X, Network } from 'lucide-react';
import { useKnowledgeGraphFull } from '../../../hooks/useApi';
import { Markdown } from '../../common/Markdown';
import type { KnowledgeSearchResult } from '../../../lib/api';

const TYPE_COLORS: Record<string, string> = {
  observation: '#3b82f6',     // blue
  entity: '#22c55e',          // green
  'domain-summary': '#f59e0b', // amber
};

const DEFAULT_NODE_COLOR = '#6b7280';

function buildGraph(notes: KnowledgeSearchResult[]) {
  const g = new Graph({ type: 'directed', multi: false });

  // Add nodes from knowledge notes
  for (const note of notes) {
    const fm = note.frontmatter;
    if (!fm?.id) continue;
    const id = fm.id as string;
    const knowledgeType = (fm.type as string) || 'observation';
    const confidence = (fm.confidence as number) || 0.5;

    g.addNode(id, {
      label: id,
      size: 4 + confidence * 8,
      color: TYPE_COLORS[knowledgeType] || DEFAULT_NODE_COLOR,
      x: Math.random() * 100,
      y: Math.random() * 100,
      _data: { ...fm, path: note.path, snippet: note.snippet },
    });
  }

  // Add edges from frontmatter links
  for (const note of notes) {
    const fm = note.frontmatter;
    if (!fm?.id || !Array.isArray(fm.links)) continue;
    const fromId = fm.id as string;

    for (const link of fm.links as Array<{ target: string; relation: string; layer?: string }>) {
      if (g.hasNode(fromId) && g.hasNode(link.target)) {
        try {
          g.addEdge(fromId, link.target, {
            type: 'arrow',
            size: 1.5,
            color: '#4b5563',
            label: link.relation,
            _relation: link.relation,
            _layer: link.layer,
          });
        } catch { /* skip duplicate edges */ }
      }
    }
  }

  return g;
}

function GraphSidebar({ nodeData, onClose }: { nodeData: Record<string, unknown> | null; onClose: () => void }) {
  if (!nodeData) return null;

  const id = nodeData.id as string;
  const type = nodeData.type as string;
  const confidence = nodeData.confidence as number;
  const domains = (nodeData.domain as string[]) || [];
  const entities = (nodeData.entities as string[]) || [];
  const path = nodeData.path as string;
  const snippet = nodeData.snippet as string;
  const agentId = (nodeData.source as Record<string, unknown>)?.agentId as string | undefined;
  const links = (nodeData.links as Array<{ target: string; relation: string }>) || [];

  return (
    <div
      className="w-72 shrink-0 overflow-y-auto border-l p-4 space-y-3"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold font-mono">{id}</h3>
        <button onClick={onClose} className="btn-ghost p-1 shrink-0 cursor-pointer"><X className="w-4 h-4" /></button>
      </div>

      {/* Type + confidence */}
      <div className="flex items-center gap-2">
        <span className="text-2xs px-1.5 py-0.5 rounded" style={{ backgroundColor: (TYPE_COLORS[type] || DEFAULT_NODE_COLOR) + '18', color: TYPE_COLORS[type] || DEFAULT_NODE_COLOR }}>
          {type}
        </span>
        {confidence != null && (
          <span className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
            conf {(confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {/* Path */}
      {path && (
        <div className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)' }}>{path}</div>
      )}

      {/* Domains + entities */}
      {(domains.length > 0 || entities.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {domains.map(d => (
            <span key={d} className="text-2xs px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-accent)' }}>{d}</span>
          ))}
          {entities.map(e => (
            <span key={e} className="text-2xs px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>{e}</span>
          ))}
        </div>
      )}

      {/* Agent */}
      {agentId && (
        <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>by {agentId}</div>
      )}

      {/* Snippet */}
      {snippet && (
        <div className="prose-sm text-xs"><Markdown content={snippet} /></div>
      )}

      {/* Links */}
      {links.length > 0 && (
        <div>
          <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>Links</div>
          <div className="space-y-0.5">
            {links.map((link, i) => (
              <div key={i} className="text-2xs font-mono" style={{ color: 'var(--color-text-secondary)' }}>
                {link.relation} → {link.target}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function KnowledgeGraph({ resourceId }: { resourceId: string }) {
  const { data, isLoading } = useKnowledgeGraphFull(resourceId);
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const [selectedNode, setSelectedNode] = useState<Record<string, unknown> | null>(null);

  const graph = useMemo(() => {
    if (!data?.results?.length) return null;
    // Only include notes with knowledge IDs
    const knowledgeNotes = data.results.filter(r => r.frontmatter?.id);
    if (knowledgeNotes.length === 0) return null;
    return buildGraph(knowledgeNotes);
  }, [data]);

  // Apply layout
  useEffect(() => {
    if (!graph || graph.order === 0) return;
    randomLayout.assign(graph);
    forceAtlas2.assign(graph, {
      iterations: 100,
      settings: { gravity: 1, scalingRatio: 2, barnesHutOptimize: graph.order > 50, strongGravityMode: true },
    });
  }, [graph]);

  // Initialize sigma
  useEffect(() => {
    if (!containerRef.current || !graph || graph.order === 0) return;

    const sigma = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: true,
      defaultEdgeType: 'arrow',
      defaultNodeColor: DEFAULT_NODE_COLOR,
      defaultEdgeColor: '#4b5563',
      labelColor: { color: '#d1d2d3' },
      labelFont: 'Inter, system-ui, sans-serif',
      labelSize: 11,
      labelRenderedSizeThreshold: 4,
      edgeLabelColor: { color: '#7a7b7e' },
      edgeLabelSize: 9,
    });

    sigmaRef.current = sigma;

    sigma.on('clickNode', ({ node }) => {
      const attrs = graph.getNodeAttributes(node);
      setSelectedNode(attrs._data as Record<string, unknown>);
    });
    sigma.on('clickStage', () => setSelectedNode(null));

    return () => { sigma.kill(); sigmaRef.current = null; };
  }, [graph]);

  const handleZoomIn = useCallback(() => sigmaRef.current?.getCamera().animatedZoom({ duration: 200 }), []);
  const handleZoomOut = useCallback(() => sigmaRef.current?.getCamera().animatedUnzoom({ duration: 200 }), []);
  const handleFitView = useCallback(() => sigmaRef.current?.getCamera().animatedReset({ duration: 300 }), []);

  if (isLoading) {
    return <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading knowledge graph...</div>;
  }

  if (!graph || graph.order === 0) {
    return (
      <div className="py-8 text-center">
        <Network className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No knowledge notes found</p>
        <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
          Knowledge notes have an id field in their frontmatter
        </p>
      </div>
    );
  }

  return (
    <div className="flex" style={{ height: 400 }}>
      {/* Canvas */}
      <div className="flex-1 relative rounded-md overflow-hidden" style={{ backgroundColor: 'var(--color-bg)' }}>
        <div ref={containerRef} className="w-full h-full" />

        {/* Zoom controls */}
        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <button onClick={handleZoomIn} className="btn-ghost p-1 rounded cursor-pointer" style={{ backgroundColor: 'var(--color-surface)' }}><ZoomIn className="w-3.5 h-3.5" /></button>
          <button onClick={handleZoomOut} className="btn-ghost p-1 rounded cursor-pointer" style={{ backgroundColor: 'var(--color-surface)' }}><ZoomOut className="w-3.5 h-3.5" /></button>
          <button onClick={handleFitView} className="btn-ghost p-1 rounded cursor-pointer" style={{ backgroundColor: 'var(--color-surface)' }}><Maximize2 className="w-3.5 h-3.5" /></button>
        </div>

        {/* Legend */}
        <div className="absolute bottom-2 left-2 p-1.5 rounded text-2xs space-y-0.5" style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}>
          {Object.entries(TYPE_COLORS).map(([type, color]) => (
            <div key={type} className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              <span style={{ color: 'var(--color-text-muted)' }}>{type}</span>
            </div>
          ))}
        </div>

        {/* Stats */}
        <div className="absolute top-2 left-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {graph.order} nodes, {graph.size} edges
        </div>
      </div>

      {/* Sidebar */}
      <GraphSidebar nodeData={selectedNode} onClose={() => setSelectedNode(null)} />
    </div>
  );
}
