/**
 * summarizeHierarchyView — pure helper that derives the scope-bar counts.
 *
 * Extracted from `TaskHierarchyView.tsx` so the math (which had a real bug
 * before: pre-cluster `scoped.nodes` vs post-cluster `clustered.nodes` were
 * mixed and produced inconsistent totals) is testable in isolation.
 *
 * Contract:
 *   - `inView`     = total cards rendered on screen (clusters count as one).
 *   - `upstream`   = ancestor-only cards (in scope as upstream blockers but
 *                    not seed). Cluster placeholders never count as
 *                    upstream because they're synthetic.
 *   - `clusters`   = number of cluster placeholders rendered.
 *
 * The shape of the input mirrors `ScopeResult` (which carries `seedIds`)
 * and `LeafClusterResult` (which carries `nodes` + `clusters`).
 */

import type { OpenTasksGraphNode } from '../../../lib/api';
import { CLUSTER_NODE_TYPE } from './leafClustering';

export interface HierarchyViewSummary {
  inView: number;
  upstream: number;
  clusters: number;
}

export function summarizeHierarchyView(
  clusteredNodes: ReadonlyArray<OpenTasksGraphNode>,
  clusters: ReadonlyMap<string, ReadonlyArray<string>> | { size: number },
  seedIds: ReadonlySet<string>,
): HierarchyViewSummary {
  let upstream = 0;
  for (const n of clusteredNodes) {
    if (n.type === CLUSTER_NODE_TYPE) continue;
    if (!seedIds.has(n.id)) upstream++;
  }
  return {
    inView: clusteredNodes.length,
    upstream,
    clusters: clusters.size,
  };
}

/**
 * Format the summary as the trailing fragment shown after "N in view" in
 * the scope bar. Pure — easier to test than walking the JSX.
 *
 * Returns the empty string when there's nothing extra to say, otherwise
 * something like " · 3 upstream · 2 clusters".
 */
export function formatHierarchySummarySuffix(
  summary: HierarchyViewSummary,
): string {
  const parts: string[] = [];
  if (summary.upstream > 0) parts.push(`${summary.upstream} upstream`);
  if (summary.clusters > 0) {
    parts.push(
      `${summary.clusters} cluster${summary.clusters > 1 ? 's' : ''}`,
    );
  }
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}
