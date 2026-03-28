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
  blocked: '#ef4444',     // red
  completed: '#22c55e',   // green
  failed: '#ef4444',      // red
};

/** Node type → size mapping */
const TYPE_SIZES: Record<string, number> = {
  task: 8,
  milestone: 12,
  note: 6,
  context: 5,
  feedback: 5,
  external: 5,
};

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
        size: TYPE_SIZES[node.type] || 6,
        color: STATUS_COLORS[status] || STATUS_COLORS.open,
        // Note: sigma reserves "type" for the node renderer program name,
        // so we use "nodeType" to store the OpenTasks node type.
        nodeType: node.type,
        status,
        priority: node.priority,
        // Initial random position (will be laid out)
        x: Math.random() * 100,
        y: Math.random() * 100,
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
            size: 1.5,
            color: '#4b5563',
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
