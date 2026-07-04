import type { StreamDAGNode } from '../../hooks/useApi';

/**
 * Resolve a dispatch outcome's `cascade_stream` artifact ref
 * (`${swarm_id}/${runtime_stream_id}`) to its Changes-hub row so the outcome
 * view can deep-link straight to the diff (`/changes?stream=<row_id>`) rather
 * than the fleet-wide Changes list (P5.2).
 *
 * Returns `null` when the stream isn't indexed on this hub — callers render a
 * clearly labeled fallback per principle 4 (never a diff link that 404s).
 */
export function resolveCascadeStreamRow(
  ref: string,
  nodes: StreamDAGNode[],
): StreamDAGNode | null {
  for (const n of nodes) {
    if (`${n.source_swarm_id}/${n.stream_id}` === ref) return n;
  }
  return null;
}

/** `/changes?stream=<row_id>` deep link, or `null` when unresolved. */
export function cascadeStreamDeepLink(
  ref: string,
  nodes: StreamDAGNode[],
): string | null {
  const row = resolveCascadeStreamRow(ref, nodes);
  return row ? `/changes?stream=${encodeURIComponent(row.id)}` : null;
}
