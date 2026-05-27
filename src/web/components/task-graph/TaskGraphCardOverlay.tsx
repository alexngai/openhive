/**
 * TaskGraphCardOverlay — always-visible HTML cards anchored to sigma node
 * positions.
 *
 * Cards are pure decoration: `pointer-events: none` so all click / drag /
 * hover interaction flows through to the sigma canvas underneath (which
 * already handles those). The overlay subscribes to sigma's `afterRender`
 * event and rewrites each card's `transform` directly via a DOM ref — this
 * skips React reconciliation on every frame (drag pulses, FA2 ticks) and
 * keeps 200+ cards smooth.
 *
 * React is responsible only for: which cards exist, their content, and
 * selection / hover / dim styling. Per-frame motion is direct DOM.
 *
 * Cards hide when zoomed out far enough that they would overlap into
 * illegibility — below the threshold, sigma's labels carry the load.
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import type Sigma from 'sigma';
import type Graph from 'graphology';
import { TaskNodeCard, CARD_WIDTH, CARD_HEIGHT } from './TaskNodeCard';
import { resolveAssigneeSwarm } from '../swarm/SwarmChip';
import { swarmColorFor, SWARM_UNASSIGNED_COLOR } from './swarmPalette';
import type { OpenTasksGraphNode, MapSwarm } from '../../lib/api';

/** Above this camera ratio (zoomed out), cards hide. */
const HIDE_RATIO = 2.5;

interface TaskGraphCardOverlayProps {
  sigma: Sigma | null;
  graph: Graph | null;
  /** Hovered node id (mirrors sigma's enterNode/leaveNode state). */
  hoveredNode: string | null;
  /** Currently selected node (sidebar target). */
  selectedNodeId: string | null;
  /** When set, only these node ids are visible — others get hidden. */
  depthVisible: Set<string> | null;
  /** Status (default) or swarm color stripe. */
  colorMode: 'status' | 'swarm';
  /** All swarms registered with the hub — used to resolve assignee → swarm. */
  swarms: MapSwarm[] | undefined;
  /** False while FA2 is still moving nodes; true after settle + noverlap. */
  settled: boolean;
}

interface CardEntry {
  el: HTMLDivElement | null;
  node: OpenTasksGraphNode;
}

function TaskGraphCardOverlayInner({
  sigma,
  graph,
  hoveredNode,
  selectedNodeId,
  depthVisible,
  colorMode,
  swarms,
  settled,
}: TaskGraphCardOverlayProps) {
  const cardRefsRef = useRef<Map<string, CardEntry>>(new Map());
  const neighborSetRef = useRef<Set<string> | null>(null);

  // Pull every visible task node out of the graph. We render one card per
  // node; sigma still owns positioning + hit-testing.
  const nodes = useMemo(() => {
    if (!graph) return [];
    const out: OpenTasksGraphNode[] = [];
    graph.forEachNode((_id, attrs) => {
      const d = (attrs as { _data?: OpenTasksGraphNode })._data;
      if (d) out.push(d);
    });
    return out;
  }, [graph]);

  // Keep the ref Map in sync with the live `nodes` set: drop entries for
  // nodes that have left the graph (the ref callback below only writes `el`,
  // it no longer inserts entries — that would be a render-phase side effect
  // and would leak the entry on subsequent removal).
  useEffect(() => {
    const live = new Set(nodes.map((n) => n.id));
    const map = cardRefsRef.current;
    for (const id of map.keys()) {
      if (!live.has(id)) map.delete(id);
    }
    for (const node of nodes) {
      const existing = map.get(node.id);
      if (existing) existing.node = node;
      else map.set(node.id, { el: null, node });
    }
  }, [nodes]);

  // Precompute the hovered node's neighbor set — cards outside it get dimmed.
  useEffect(() => {
    if (!graph || !hoveredNode || !graph.hasNode(hoveredNode)) {
      neighborSetRef.current = null;
      return;
    }
    const ns = new Set<string>([hoveredNode]);
    graph.forEachNeighbor(hoveredNode, (n) => ns.add(n));
    neighborSetRef.current = ns;
  }, [graph, hoveredNode]);

  // Per-frame position sync. Subscribes to sigma's afterRender — fires on
  // camera moves, drags, and FA2 layout ticks. Writes transforms directly to
  // each card's DOM node (no React re-render on motion).
  useEffect(() => {
    if (!sigma || !graph) return;

    const updateTransforms = () => {
      const cam = sigma.getCamera();
      const ratio = cam.ratio;
      const showCards = ratio <= HIDE_RATIO;

      for (const [id, entry] of cardRefsRef.current) {
        if (!entry.el) continue;
        if (!showCards || !graph.hasNode(id)) {
          entry.el.style.opacity = '0';
          entry.el.style.pointerEvents = 'none';
          continue;
        }
        const attrs = graph.getNodeAttributes(id);
        const viewport = sigma.graphToViewport({
          x: attrs.x as number,
          y: attrs.y as number,
        });
        const dx = viewport.x - CARD_WIDTH / 2;
        const dy = viewport.y - CARD_HEIGHT / 2;
        entry.el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        // Native opacity restore — React-controlled dim happens via re-render.
        if (entry.el.style.opacity === '0') {
          entry.el.style.opacity = '';
        }
      }
    };

    updateTransforms();
    sigma.on('afterRender', updateTransforms);
    return () => {
      sigma.off('afterRender', updateTransforms);
    };
  }, [sigma, graph]);

  if (!sigma || !graph || nodes.length === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        // Fade in once FA2 has settled so the user doesn't see cards jiggle
        // around for ~2.5s while physics runs. After settle, the noverlap
        // pass has already placed cards at their final spread positions.
        opacity: settled ? 1 : 0,
        transition: 'opacity 200ms ease-out',
      }}
    >
      {nodes.map((node) => {
        const nodeId = node.id;
        const isSelected = selectedNodeId === nodeId;
        const isHovered = hoveredNode === nodeId;

        // Depth filter masks everything outside the visible set.
        const depthHidden = depthVisible !== null && !depthVisible.has(nodeId);
        // Hover dims non-neighbors. Selected is never dimmed.
        const hoverDimmed =
          !!hoveredNode &&
          !isHovered &&
          !isSelected &&
          neighborSetRef.current !== null &&
          !neighborSetRef.current.has(nodeId);
        const dimmed = depthHidden || hoverDimmed;

        // Resolved swarm for the swarm chip + (in swarm mode) the stripe.
        const resolvedSwarm = resolveAssigneeSwarm(node.assignee ?? null, swarms);
        const swarmInfo = resolvedSwarm
          ? {
              id: resolvedSwarm.id,
              name: resolvedSwarm.name,
              color: swarmColorFor(resolvedSwarm.id),
            }
          : node.assignee
            ? { id: '__unassigned__', name: 'unassigned', color: SWARM_UNASSIGNED_COLOR }
            : null;

        // Multi-graph source ring color, if present on the node.
        const sourceColor = ((node as { _sourceColor?: string })._sourceColor) ?? null;

        return (
          <div
            key={nodeId}
            ref={(el) => {
              // Ref callback only writes `el` onto an entry that the sync
              // effect above already created — no insertion here, so removed
              // nodes don't leak entries.
              const existing = cardRefsRef.current.get(nodeId);
              if (existing) existing.el = el;
            }}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              pointerEvents: 'none',
              willChange: 'transform',
              zIndex: isSelected ? 30 : isHovered ? 20 : 10,
              // Initial transform — replaced by direct DOM write on first
              // afterRender tick.
              transform: 'translate3d(-9999px, -9999px, 0)',
            }}
          >
            <TaskNodeCard
              node={node}
              selected={isSelected}
              hovered={isHovered}
              dimmed={dimmed}
              sourceColor={sourceColor}
              swarm={swarmInfo}
              swarmColored={colorMode === 'swarm'}
            />
          </div>
        );
      })}
    </div>
  );
}

export const TaskGraphCardOverlay = memo(TaskGraphCardOverlayInner);
