/**
 * Pure dagre wrapper for cascade stream DAG layout.
 *
 * Input: nodes + edges from `useCascadeDAG`. Output: a Map of node id → top-left
 * pixel coordinates ready for React Flow node `position`.
 *
 * Layout is left-to-right (rank ≈ depth from root). Only `parent` edges
 * influence ranking; `merge` edges are added with weight 0 unless they'd
 * create a cycle, in which case they're skipped (the React Flow layer still
 * renders the edge, dagre just doesn't lay it out).
 */

import dagre from 'dagre';
import type { StreamDAGNode, StreamDAGEdge } from '../../../hooks/useApi';

export const CARD_WIDTH = 240;
export const CARD_HEIGHT = 96;
const RANK_SEP = 80;
const NODE_SEP = 24;

export interface LayoutPosition {
  x: number;
  y: number;
}

export function layoutCascadeDAG(
  nodes: StreamDAGNode[],
  edges: StreamDAGEdge[],
): Map<string, LayoutPosition> {
  const positions = new Map<string, LayoutPosition>();
  if (nodes.length === 0) return positions;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: RANK_SEP, nodesep: NODE_SEP });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, { width: CARD_WIDTH, height: CARD_HEIGHT });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const addedEdges = new Set<string>();

  // Parent edges first — they define ranks.
  for (const e of edges) {
    if (e.type !== 'parent') continue;
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const key = `${e.source}->${e.target}`;
    if (addedEdges.has(key)) continue;
    addedEdges.add(key);
    g.setEdge(e.source, e.target);
  }

  // Merge edges with weight 0, skipping any that would close a cycle. After
  // parent edges are placed the graph is acyclic; reject a merge edge if
  // `target` already has a path to `source`.
  for (const e of edges) {
    if (e.type !== 'merge') continue;
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const key = `${e.source}->${e.target}`;
    if (addedEdges.has(key)) continue;
    if (hasPath(g, e.target, e.source)) continue;
    addedEdges.add(key);
    g.setEdge(e.source, e.target, { weight: 0 });
  }

  dagre.layout(g);

  for (const n of nodes) {
    const laid = g.node(n.id);
    if (!laid) continue;
    positions.set(n.id, {
      x: laid.x - CARD_WIDTH / 2,
      y: laid.y - CARD_HEIGHT / 2,
    });
  }
  return positions;
}

/** BFS reachability check used to reject cycle-creating merge edges. */
function hasPath(g: dagre.graphlib.Graph, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const succs = g.successors(cur) as string[] | undefined;
    if (!succs) continue;
    for (const next of succs) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
