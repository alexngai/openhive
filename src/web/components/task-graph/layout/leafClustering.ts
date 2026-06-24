/**
 * leafClustering — collapse fan-out under a parent into a single "+N more" pill.
 *
 * Hierarchy-view safety valve for tasks with many leaf children (e.g. a parent
 * with 30 subtasks). Without this, ELK's layered layout produces a comically
 * wide rank. The cluster node has a stable id derived from its parent so
 * expand/collapse toggles can target it directly.
 *
 * Pure function over (nodes, edges, options). Runs BEFORE the ELK layout pass
 * so ELK lays out a graph already reduced to one box per cluster — cheaper
 * than laying out everything and post-processing.
 */

import type { OpenTasksGraphNode, OpenTasksGraphEdge } from '../../../lib/api';
import { rankingEndpoints } from './scopeActiveWork';

export const CLUSTER_NODE_TYPE = 'leaf-cluster';

export interface LeafClusterOptions {
  /** Minimum number of leaves under one parent before clustering kicks in. */
  threshold?: number;
  /** Cluster ids the user has expanded — children are restored individually. */
  expanded?: ReadonlySet<string>;
}

export interface LeafClusterResult {
  nodes: OpenTasksGraphNode[];
  edges: OpenTasksGraphEdge[];
  /** Map of cluster id → ids of original leaves it replaced (for expand action). */
  clusters: Map<string, string[]>;
}

const DEFAULT_THRESHOLD = 5;

interface LeafClusterPayload {
  parentId: string;
  leafIds: string[];
  statusCounts: Record<string, number>;
}

export function clusterLeaves(
  nodes: OpenTasksGraphNode[],
  edges: OpenTasksGraphEdge[],
  options: LeafClusterOptions = {},
): LeafClusterResult {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const expanded = options.expanded ?? new Set<string>();

  // outDegree counts only ranking-edge outgoing children. Leaves are nodes
  // with zero ranking children. Decoration edges (e.g. `related`) don't keep
  // a node out of cluster eligibility.
  const childrenOf = new Map<string, string[]>();
  const outDegree = new Map<string, number>();
  const byId = new Map<string, OpenTasksGraphNode>();
  for (const n of nodes) byId.set(n.id, n);

  for (const e of edges) {
    const r = rankingEndpoints(e);
    if (!r) continue;
    if (!byId.has(r.parent) || !byId.has(r.child)) continue;
    (childrenOf.get(r.parent) ?? childrenOf.set(r.parent, []).get(r.parent)!).push(r.child);
    outDegree.set(r.child, (outDegree.get(r.child) ?? 0) + 0); // ensure presence
    outDegree.set(r.parent, outDegree.get(r.parent) ?? 0); // ensure presence
  }
  // Now compute real outDegree as childrenOf size for each parent
  for (const [parent, kids] of childrenOf) {
    outDegree.set(parent, kids.length);
  }
  // Leaves: nodes that never appear as parent in childrenOf.
  // (Equivalently, !childrenOf.has(id).)

  // For each parent, find leaf children and decide whether to cluster.
  const clusters = new Map<string, string[]>();
  const clusterPayloads = new Map<string, LeafClusterPayload>();
  const removedLeafIds = new Set<string>();

  for (const [parentId, kids] of childrenOf) {
    const leaves = kids.filter((k) => !childrenOf.has(k));
    if (leaves.length < threshold) continue;
    const clusterId = `${CLUSTER_NODE_TYPE}:${parentId}`;
    if (expanded.has(clusterId)) continue; // user expanded this cluster
    clusters.set(clusterId, leaves);
    const statusCounts: Record<string, number> = {};
    for (const lid of leaves) {
      const ln = byId.get(lid);
      const s = ln?.status ?? 'open';
      statusCounts[s] = (statusCounts[s] ?? 0) + 1;
      removedLeafIds.add(lid);
    }
    clusterPayloads.set(clusterId, { parentId, leafIds: leaves, statusCounts });
  }

  // Build output node list: original nodes minus clustered leaves, plus
  // one synthetic node per cluster.
  const outNodes: OpenTasksGraphNode[] = nodes
    .filter((n) => !removedLeafIds.has(n.id))
    .slice();

  for (const [clusterId, payload] of clusterPayloads) {
    outNodes.push({
      id: clusterId,
      type: CLUSTER_NODE_TYPE,
      title: `+${payload.leafIds.length} more`,
      status: dominantStatus(payload.statusCounts),
      metadata: {
        clusterParentId: payload.parentId,
        clusterLeafIds: payload.leafIds,
        clusterStatusCounts: payload.statusCounts,
      },
    });
  }

  // Build output edge list: drop edges touching removed leaves, then add one
  // synthetic ranking edge per cluster from parent → cluster (mirroring the
  // edge type of the first removed leaf, so the layout treats it as a child).
  const outEdges: OpenTasksGraphEdge[] = edges.filter(
    (e) => !removedLeafIds.has(e.from_id) && !removedLeafIds.has(e.to_id),
  );
  for (const [clusterId, payload] of clusterPayloads) {
    // Find any original edge from parent → first leaf to mirror its type.
    const sample = edges.find((e) => {
      if (removedLeafIds.has(e.from_id) || removedLeafIds.has(e.to_id)) {
        const r = rankingEndpoints(e);
        return r?.parent === payload.parentId && payload.leafIds.includes(r.child);
      }
      return false;
    });
    const edgeType = sample?.type ?? 'subtask-of';
    // Re-create the ranking edge in the same direction the original was stored.
    // For 'blocks': parent → leaf (from=parent, to=leaf)
    // For 'depends-on' / 'subtask-of': leaf → parent (from=leaf, to=parent)
    if (edgeType === 'blocks') {
      outEdges.push({
        id: `${clusterId}:edge`,
        from_id: payload.parentId,
        to_id: clusterId,
        type: edgeType,
      });
    } else {
      outEdges.push({
        id: `${clusterId}:edge`,
        from_id: clusterId,
        to_id: payload.parentId,
        type: edgeType,
      });
    }
  }

  return { nodes: outNodes, edges: outEdges, clusters };
}

function dominantStatus(counts: Record<string, number>): string {
  let best = 'open';
  let bestN = -1;
  for (const [s, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = s;
      bestN = n;
    }
  }
  return best;
}
