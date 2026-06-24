/**
 * scopeActiveWork — focus a task graph on "what's live + what's holding it up".
 *
 * Default scope for the Hierarchy view (path B). Reduces noise by hiding
 * archived, completed, and decoration-only nodes; pulls in upstream
 * blockers regardless of status so the user can see *why* something's blocked.
 *
 * Pure function, deterministic — easy to unit-test against fixtures.
 *
 * Algorithm:
 *   1. Seed   = task nodes with status ∈ {open, in_progress, blocked} and !archived
 *   2. Expand upward via ranking edges (blocks / depends-on / subtask-of)
 *      to include all ancestors regardless of status
 *   3. Always drop archived. Default-drop non-task types (note/context/feedback/external)
 *      unless `includeAuxTypes` is true.
 *   4. Edges are kept iff both endpoints survive the node filter.
 */

import type { OpenTasksGraphNode, OpenTasksGraphEdge } from '../../../lib/api';

export interface ScopeOptions {
  /** Statuses considered "active". Default: open + in_progress + blocked. */
  activeStatuses?: ReadonlySet<string>;
  /** Include note/context/feedback/external. Default: false. */
  includeAuxTypes?: boolean;
  /** Include completed/failed nodes that aren't upstream blockers. Default: false. */
  includeTerminal?: boolean;
}

export interface ScopeResult {
  nodes: OpenTasksGraphNode[];
  edges: OpenTasksGraphEdge[];
  /** The original seed set — nodes that passed the activeStatus filter on
   *  their own merits (not just as upstream blockers). Useful for visually
   *  distinguishing seeds from ancestors in the rendered view. */
  seedIds: Set<string>;
}

const DEFAULT_ACTIVE = new Set(['open', 'in_progress', 'blocked']);

/**
 * For a ranking edge, returns [parentId, childId] regardless of how the
 * relation is stored in the underlying edge. The opentasks daemon ships the
 * following relation types (CLI `link --type`): blocks, depends-on,
 * parent-of, child-of (plus references / related / etc. that don't rank).
 *
 *   `blocks A→B`     : A is the blocker (parent), B is blocked (child).
 *   `depends-on A→B` : B is the prerequisite (parent), A is dependent (child).
 *   `parent-of A→B`  : A is the parent, B is the child (subtask).
 *   `child-of A→B`   : B is the parent, A is the child.
 *   `subtask-of A→B` : (alias for child-of, accepted defensively)
 */
export function rankingEndpoints(
  edge: OpenTasksGraphEdge,
): { parent: string; child: string } | null {
  switch (edge.type) {
    case 'blocks':
    case 'parent-of':
      return { parent: edge.from_id, child: edge.to_id };
    case 'depends-on':
    case 'child-of':
    case 'subtask-of':
      return { parent: edge.to_id, child: edge.from_id };
    default:
      return null;
  }
}

export function scopeActiveWork(
  nodes: OpenTasksGraphNode[],
  edges: OpenTasksGraphEdge[],
  options: ScopeOptions = {},
): ScopeResult {
  const activeStatuses = options.activeStatuses ?? DEFAULT_ACTIVE;
  const includeAux = options.includeAuxTypes ?? false;
  const includeTerminal = options.includeTerminal ?? false;

  const byId = new Map<string, OpenTasksGraphNode>();
  for (const n of nodes) byId.set(n.id, n);

  const passesTypeFilter = (n: OpenTasksGraphNode): boolean => {
    if (n.archived) return false;
    if (!includeAux && n.type !== 'task') return false;
    return true;
  };

  // Adjacency for upward walks — child → parent map from ranking edges only.
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    const r = rankingEndpoints(e);
    if (!r) continue;
    if (!byId.has(r.parent) || !byId.has(r.child)) continue;
    const arr = parentsOf.get(r.child) ?? [];
    arr.push(r.parent);
    parentsOf.set(r.child, arr);
  }

  // Seed = active tasks (or all task nodes if includeTerminal)
  const seed: string[] = [];
  for (const n of nodes) {
    if (!passesTypeFilter(n)) continue;
    if (includeTerminal) {
      seed.push(n.id);
      continue;
    }
    const status = n.status ?? 'open';
    if (activeStatuses.has(status)) seed.push(n.id);
  }

  // BFS upward to collect ancestors regardless of status.
  const visible = new Set<string>(seed);
  const queue = [...seed];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const parent of parentsOf.get(cur) ?? []) {
      if (visible.has(parent)) continue;
      const parentNode = byId.get(parent);
      if (!parentNode) continue;
      // Ancestors slip past the activeStatus filter (point of the scope), but
      // still respect archived / aux-type rules.
      if (parentNode.archived) continue;
      if (!includeAux && parentNode.type !== 'task') continue;
      visible.add(parent);
      queue.push(parent);
    }
  }

  const outNodes = nodes.filter((n) => visible.has(n.id));
  const outEdges = edges.filter(
    (e) => visible.has(e.from_id) && visible.has(e.to_id),
  );

  return { nodes: outNodes, edges: outEdges, seedIds: new Set(seed) };
}
