/**
 * elkHierarchyLayout — async ELK-based layered layout for the Hierarchy view.
 *
 * Wraps `elkjs/lib/elk.bundled.js` (browser worker-less build) and returns
 * top-left React Flow positions keyed by node id. Only `blocks` /
 * `depends-on` / `subtask-of` edges contribute to the ranking; decoration
 * edges (e.g. `related`) are returned in the result for rendering but never
 * touch ELK.
 *
 * Layered + downward direction: rank 0 sits at the top, dependents below.
 * Cycles in ranking edges are handled by ELK's feedback-arc-set heuristic
 * (the offending edge gets routed but doesn't break layout).
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import type {
  OpenTasksGraphNode,
  OpenTasksGraphEdge,
} from '../../../lib/api';
import { rankingEndpoints } from './scopeActiveWork';
import { CLUSTER_NODE_TYPE } from './leafClustering';
// Mirror the shared TaskNodeCard dimensions so cards in Hierarchy look
// identical to the path-A overlay cards.
import { CARD_WIDTH, CARD_HEIGHT } from '../TaskNodeCard';

export const HIERARCHY_CARD_WIDTH = CARD_WIDTH;
export const HIERARCHY_CARD_HEIGHT = CARD_HEIGHT;
export const HIERARCHY_CLUSTER_HEIGHT = 60;

export interface HierarchyLayoutPosition {
  x: number;
  y: number;
}

export interface HierarchyLayoutResult {
  /** Map of node id → top-left coordinates ready for React Flow. */
  positions: Map<string, HierarchyLayoutPosition>;
  /** Ranking edges that ELK used (after dedupe, both endpoints present). */
  rankingEdges: { from: string; to: string; type: string }[];
  /** Decoration edges (e.g. `related`) — keep for rendering only. */
  decorationEdges: { from: string; to: string; type: string }[];
}

const elk = new ELK();

const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.spacing.nodeNode': '32',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.crossingMinimization.semiInteractive': 'true',
  'elk.layered.feedbackEdges': 'true',
};

export async function layoutHierarchy(
  nodes: OpenTasksGraphNode[],
  edges: OpenTasksGraphEdge[],
): Promise<HierarchyLayoutResult> {
  const positions = new Map<string, HierarchyLayoutPosition>();
  if (nodes.length === 0) {
    return { positions, rankingEdges: [], decorationEdges: [] };
  }

  const nodeIds = new Set(nodes.map((n) => n.id));

  // Split incoming edges into ranking (rank-influencing) vs decoration.
  const rankingEdges: { from: string; to: string; type: string }[] = [];
  const decorationEdges: { from: string; to: string; type: string }[] = [];
  const dedupe = new Set<string>();

  for (const e of edges) {
    if (!nodeIds.has(e.from_id) || !nodeIds.has(e.to_id)) continue;
    const r = rankingEndpoints(e);
    if (r) {
      const key = `${r.parent}->${r.child}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      rankingEdges.push({ from: r.parent, to: r.child, type: e.type ?? 'depends-on' });
    } else {
      decorationEdges.push({
        from: e.from_id,
        to: e.to_id,
        type: e.type ?? 'related',
      });
    }
  }

  const elkGraph = {
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: nodes.map((n) => ({
      id: n.id,
      width: HIERARCHY_CARD_WIDTH,
      height:
        n.type === CLUSTER_NODE_TYPE
          ? HIERARCHY_CLUSTER_HEIGHT
          : HIERARCHY_CARD_HEIGHT,
    })),
    edges: rankingEdges.map((e, i) => ({
      id: `e${i}`,
      sources: [e.from],
      targets: [e.to],
    })),
  };

  const laid = (await elk.layout(elkGraph)) as {
    children?: { id: string; x?: number; y?: number }[];
  };

  for (const c of laid.children ?? []) {
    if (typeof c.x === 'number' && typeof c.y === 'number') {
      positions.set(c.id, { x: c.x, y: c.y });
    }
  }

  return { positions, rankingEdges, decorationEdges };
}
