/**
 * useTaskGraph hook
 *
 * Fetches OpenTasks graph data and transforms it into a graphology Graph
 * instance for rendering with sigma.js.
 */

import { useCallback, useMemo } from 'react';
import Graph from 'graphology';
import { useOpenTasksGraph, useOpenTasksSummary } from '../../hooks/useApi';
import { useWSEvent } from '../../hooks/useWebSocket';
import { useQueryClient } from '@tanstack/react-query';
import type { OpenTasksGraphNode, OpenTasksGraphEdge } from '../../lib/api';

/** Status → color mapping for node rendering */
export const STATUS_COLORS: Record<string, string> = {
  open: '#6b7280',       // gray
  in_progress: '#3b82f6', // blue
  blocked: '#f59e0b',     // amber/yellow
  completed: '#22c55e',   // green
  failed: '#ef4444',      // red
};

/** OpenTasks node type → sigma renderer program */
const RENDERER_TYPE: Record<string, string> = {
  task: 'circle',
  milestone: 'circle',
  context: 'square',
  note: 'square',
  feedback: 'square',
  external: 'square',
};

/** Node type → size mapping */
const TYPE_SIZES: Record<string, number> = {
  task: 14,
  milestone: 20,
  note: 10,
  context: 9,
  feedback: 9,
  external: 9,
};

/**
 * Simple string hash → deterministic number in [0, range).
 * Ensures the same node ID always gets the same initial position.
 */
function hashPosition(id: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) % 10000) / 100; // 0–100 range
}

export interface TaskGraphState {
  graph: Graph | null;
  nodes: OpenTasksGraphNode[];
  edges: OpenTasksGraphEdge[];
  isLoading: boolean;
  error: Error | null;
  summary: {
    node_count: number;
    edge_count: number;
    task_counts: Record<string, number>;
    ready_count: number;
  } | null;
}

/**
 * Build a graphology Graph from raw nodes + edges arrays.
 * Used by multi-graph mode to create a merged sigma.js graph.
 */
export function buildGraphologyGraph(
  nodes: OpenTasksGraphNode[],
  edges: OpenTasksGraphEdge[],
  graphColorMap?: Map<string, string>,
): Graph {
  const g = new Graph({ type: 'directed', multi: false });

  for (const node of nodes) {
    if (node.archived) continue;
    const status = node.status || 'open';
    // Use source color if available (multi-graph), fall back to status color
    const sourceColor = (node as any)._sourceColor;
    g.addNode(node.id, {
      label: node.title || node.id,
      type: RENDERER_TYPE[node.type] || 'circle',
      size: TYPE_SIZES[node.type] || 6,
      color: STATUS_COLORS[status] || STATUS_COLORS.open,
      borderColor: sourceColor || null,
      nodeType: node.type,
      status,
      priority: node.priority,
      x: hashPosition(node.id, 0x9E37),
      y: hashPosition(node.id, 0x7F4A),
      _data: node,
    });
  }

  for (const edge of edges) {
    if (g.hasNode(edge.from_id) && g.hasNode(edge.to_id)) {
      try {
        g.addEdge(edge.from_id, edge.to_id, {
          type: 'arrow',
          size: 2,
          color: '#9ca3af',
          edgeType: edge.type,
        });
      } catch {
        // Skip duplicate edges
      }
    }
  }

  return g;
}

export function useTaskGraph(resourceId: string): TaskGraphState {
  const { data: graphData, isLoading: graphLoading, error: graphError } = useOpenTasksGraph(resourceId);
  const { data: summary } = useOpenTasksSummary(resourceId);
  const queryClient = useQueryClient();

  // Invalidate on WebSocket updates
  const handleResourceSynced = useCallback((data: { resource_id: string }) => {
    if (data.resource_id === resourceId) {
      queryClient.invalidateQueries({ queryKey: ['opentasks-graph', resourceId] });
      queryClient.invalidateQueries({ queryKey: ['opentasks-summary', resourceId] });
    }
  }, [resourceId, queryClient]);
  useWSEvent('resource_synced', handleResourceSynced);

  const graph = useMemo(() => {
    if (!graphData?.nodes?.length) return null;

    const g = new Graph({ type: 'directed', multi: false });

    // Add nodes
    for (const node of graphData.nodes) {
      if (node.archived) continue;
      const status = node.status || 'open';
      g.addNode(node.id, {
        label: node.title || node.id,
        type: RENDERER_TYPE[node.type] || 'circle',
        size: TYPE_SIZES[node.type] || 6,
        color: STATUS_COLORS[status] || STATUS_COLORS.open,
        nodeType: node.type,
        status,
        priority: node.priority,
        x: hashPosition(node.id, 0x9E37),
        y: hashPosition(node.id, 0x7F4A),
        // Store full node data for sidebar
        _data: node,
      });
    }

    // Add edges
    for (const edge of graphData.edges) {
      if (g.hasNode(edge.from_id) && g.hasNode(edge.to_id)) {
        try {
          g.addEdge(edge.from_id, edge.to_id, {
            type: 'arrow',
            size: 2.5,
            color: '#9ca3af',
            edgeType: edge.type,
          });
        } catch {
          // Skip duplicate edges
        }
      }
    }

    return g;
  }, [graphData]);

  return {
    graph,
    nodes: graphData?.nodes || [],
    edges: graphData?.edges || [],
    isLoading: graphLoading,
    error: graphError as Error | null,
    summary: summary || null,
  };
}
