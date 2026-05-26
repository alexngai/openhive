/**
 * TaskGraphViewer — Obsidian-inspired sigma.js canvas for rendering the task DAG.
 *
 * Features:
 * - Continuous ForceAtlas2 physics via web worker supervisor
 * - Node drag with physics response
 * - Hover → highlight neighbors, dim rest
 * - Subtle node glow on dark background
 * - Depth/hop filter from selected node
 * - Smooth camera follow on node select
 */

import { useRef, useEffect, useState, useCallback, useMemo, memo } from "react";
import Sigma from "sigma";
import { createEdgeArrowProgram } from "sigma/rendering";
import FA2LayoutSupervisor from "graphology-layout-forceatlas2/worker";
import type Graph from "graphology";
import { TaskGraphSidebar, type SelectedEdge } from "./TaskGraphSidebar";
import { STATUS_COLORS } from "./useTaskGraph";
import NodeSquareProgram from "./NodeSquareProgram";
import { ZoomIn, ZoomOut, Maximize2, GitFork, Palette, LayoutPanelLeft, Circle } from "lucide-react";
import { applySigmaPerfSettings } from "../../utils/sigmaPerf";
import { getFA2Settings, NOVERLAP_SETTINGS } from "../../utils/sigmaLayout";
import noverlap from "graphology-layout-noverlap";
import { GraphActionBar, type LinkModeState } from "./GraphActionBar";
import { useCreateTaskLink, useMapSwarms } from "../../hooks/useApi";
import { resolveAssigneeSwarm } from "../swarm/SwarmChip";
import { TaskGraphCardOverlay } from "./TaskGraphCardOverlay";
import type { OpenTasksGraphNode, MapSwarm } from "../../lib/api";

interface Props {
  graph: Graph;
  resourceId: string;
  onNodeSelect?: (node: OpenTasksGraphNode | null) => void;
  edges?: import("../../lib/api").OpenTasksGraphEdge[];
  allNodes?: OpenTasksGraphNode[];
  /** Map of graph ID → display name, for multi-graph legend */
  graphSources?: Map<string, { name: string; color: string }>;
}

const MAX_LABEL_LENGTH = 28;

/** Palette used for "color by swarm" mode. */
const SWARM_PALETTE = [
  "#f59e0b",
  "#3b82f6",
  "#10b981",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#ef4444",
  "#84cc16",
  "#f97316",
  "#14b8a6",
];

const SWARM_UNASSIGNED_COLOR = "#4b5563";

/**
 * Card-aware noverlap pass.
 *
 * The default NOVERLAP_SETTINGS use each node's visible `size` (~14px for
 * tasks) as a collision radius. With 208×64 cards rendered on top of those
 * dots by the path-A overlay, the dot-sized margin leaves cards stacked.
 * This helper temporarily inflates every node's `size` to a card-bounding
 * radius, runs noverlap to push cards apart, then restores the original
 * sizes (so sigma keeps rendering small dots). Pure / idempotent.
 */
function cardAwareNoverlap(graph: import("graphology").default) {
  const CARD_BOUND = 120; // ≈ half card width + margin
  const saved = new Map<string, number>();
  graph.forEachNode((id, attrs) => {
    saved.set(id, (attrs.size as number) ?? 8);
    graph.setNodeAttribute(id, "size", CARD_BOUND);
  });
  try {
    noverlap.assign(graph, {
      maxIterations: 100,
      ratio: 1.0,
      margin: 28,
      expansion: 1.08,
    });
  } finally {
    for (const [id, size] of saved) {
      graph.setNodeAttribute(id, "size", size);
    }
  }
}

/** Stable swarm-id → color mapping (deterministic hash into palette). */
function swarmColorFor(swarmId: string): string {
  let h = 0;
  for (let i = 0; i < swarmId.length; i++) {
    h = ((h << 5) - h + swarmId.charCodeAt(i)) | 0;
  }
  return SWARM_PALETTE[Math.abs(h) % SWARM_PALETTE.length];
}

/** Truncate label text with ellipsis */
function truncateLabel(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) return label;
  return label.slice(0, MAX_LABEL_LENGTH - 1) + "\u2026";
}

/** Draw a circle or rounded-square path depending on node type */
function shapePath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  isSquare: boolean,
) {
  if (isSquare) {
    const cornerR = r * 0.25;
    ctx.beginPath();
    ctx.roundRect(x - r, y - r, r * 2, r * 2, cornerR);
  } else {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

/** Hex color → rgba with alpha */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Get all neighbors of a node (both directions) */
function getNeighborSet(graph: Graph, nodeKey: string): Set<string> {
  const neighbors = new Set<string>();
  graph.forEachNeighbor(nodeKey, (neighbor) => neighbors.add(neighbor));
  return neighbors;
}

/** Get nodes within N hops of a source node */
function getNodesWithinHops(
  graph: Graph,
  source: string,
  maxHops: number,
): Set<string> {
  const visited = new Set<string>([source]);
  let frontier = [source];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      graph.forEachNeighbor(node, (neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          nextFrontier.push(neighbor);
        }
      });
    }
    frontier = nextFrontier;
  }

  return visited;
}

export const TaskGraphViewer = memo(function TaskGraphViewer({
  graph,
  resourceId,
  onNodeSelect,
  edges = [],
  allNodes = [],
  graphSources,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  // Mirror of sigmaRef as state so the card-overlay child re-renders once
  // sigma is constructed inside the mount effect.
  const [sigmaInstance, setSigmaInstance] = useState<Sigma | null>(null);
  const [showCards, setShowCards] = useState<boolean>(() => {
    try {
      return localStorage.getItem("openhive-task-card-mode") !== "off";
    } catch {
      return true;
    }
  });
  // Mirrored ref so the FA2 settle timer (captured in a closure on mount)
  // reads the *current* card mode without re-running the whole mount effect
  // when the user toggles.
  const showCardsRef = useRef(showCards);
  showCardsRef.current = showCards;
  // Tracks whether the FA2 settle has finished for the current graph mount.
  // Used to fade cards in after positions stabilize instead of letting them
  // jiggle around for 2.5s while physics runs.
  const [cardsSettled, setCardsSettled] = useState(false);
  const toggleShowCards = useCallback(() => {
    setShowCards((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("openhive-task-card-mode", next ? "on" : "off");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  const supervisorRef = useRef<FA2LayoutSupervisor | null>(null);
  // physicsRanForNodesRef removed — physics always runs on mount
  const graphRef = useRef<Graph | null>(null);
  const onNodeSelectRef = useRef(onNodeSelect);
  onNodeSelectRef.current = onNodeSelect;

  // Stable fingerprint of graph content — only changes when nodes/edges actually change.
  // This prevents sigma recreation on React re-renders with identical graph data.
  const graphFingerprint = (() => {
    if (!graph || graph.order === 0) return "";
    const nodes = graph.nodes().sort().join(",");
    const edgeCount = graph.size;
    return `${nodes}|${edgeCount}`;
  })();
  const [selectedNode, setSelectedNode] = useState<OpenTasksGraphNode | null>(
    null,
  );
  const [selectedEdge, setSelectedEdge] = useState<SelectedEdge | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [depthFilter, setDepthFilter] = useState<number>(0); // 0 = show all
  const [linkMode, setLinkMode] = useState<LinkModeState>({ active: false });
  const linkModeRef = useRef<LinkModeState>({ active: false });
  const setLinkModeAndRef = useCallback((mode: LinkModeState) => {
    linkModeRef.current = mode;
    setLinkMode(mode);
  }, []);
  const [linkType, setLinkType] = useState("blocks");
  const linkTypeRef = useRef("blocks");
  const setLinkTypeAndRef = useCallback((type: string) => {
    linkTypeRef.current = type;
    setLinkType(type);
  }, []);
  const [colorMode, setColorMode] = useState<"status" | "swarm">(() => {
    try {
      const stored = localStorage.getItem("openhive-task-color-mode");
      return stored === "swarm" ? "swarm" : "status";
    } catch {
      return "status";
    }
  });
  const { data: swarms } = useMapSwarms();
  const createLink = useCreateTaskLink(resourceId);
  const createLinkRef = useRef(createLink);
  createLinkRef.current = createLink;
  const pendingFocusRef = useRef<string | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const hoveredEdgeRef = useRef<string | null>(null);
  const dragStateRef = useRef<{
    dragging: boolean;
    node: string | null;
    startX: number;
    startY: number;
  }>({ dragging: false, node: null, startX: 0, startY: 0 });

  // Initialize sigma renderer + FA2 supervisor
  useEffect(() => {
    if (!containerRef.current || !graph || graph.order === 0) return;

    // Custom node hover drawing — glow + tooltip with extra details.
    // Skipped when path-A cards are on: cards already carry the same info
    // at-rest, so the canvas tooltip would just paint a duplicate on top.
    const drawNodeHover = (
      context: CanvasRenderingContext2D,
      data: {
        x: number;
        y: number;
        size: number;
        color: string;
        label?: string | null;
      },
    ) => {
      if (showCardsRef.current) return;
      const { x, y, size, color } = data;
      const nodeAttrs = data as Record<string, any>;
      const isSquare = nodeAttrs.type === "square";

      // Outer glow rings (drawn behind the WebGL node)
      for (let i = 3; i >= 1; i--) {
        shapePath(context, x, y, size + i * 3, isSquare);
        context.fillStyle = hexToRgba(color, 0.08 * (4 - i));
        context.fill();
        context.closePath();
      }

      // Source graph ring (multi-graph mode)
      const borderCol = nodeAttrs.borderColor;
      if (borderCol) {
        shapePath(context, x, y, size + 2, isSquare);
        context.strokeStyle = borderCol;
        context.lineWidth = 2;
        context.stroke();
        context.closePath();
      }

      // --- Tooltip card with details ---
      const nodeData = nodeAttrs._data as OpenTasksGraphNode | undefined;
      const status = nodeAttrs.status || "open";
      const nodeType = nodeAttrs.nodeType || "task";
      const priority = nodeAttrs.priority;
      const assignee = (nodeData as any)?.assignee;
      const sourceName = (nodeData as any)?._sourceGraphName;
      const fullLabel = data.label || "";

      // Build detail lines
      const details: string[] = [];
      const statusLabel = status.replace("_", " ");
      const typeLine =
        nodeType !== "task" ? `${nodeType} · ${statusLabel}` : statusLabel;
      details.push(typeLine);
      if (priority != null && priority > 0) {
        const pLabels: Record<number, string> = {
          1: "Low",
          2: "Medium",
          3: "High",
          4: "Critical",
        };
        details.push(`P${priority} ${pLabels[priority] || ""}`);
      }
      if (assignee) details.push(`@${assignee}`);
      if (sourceName) details.push(sourceName);

      // Measure tooltip dimensions
      const padding = 8;
      const lineHeight = 14;
      const titleFontSize = 12;
      const detailFontSize = 10;
      context.font = `600 ${titleFontSize}px Inter, system-ui, sans-serif`;
      const titleWidth = context.measureText(fullLabel).width;
      context.font = `${detailFontSize}px Inter, system-ui, sans-serif`;
      const detailWidths = details.map((d) => context.measureText(d).width);
      const maxWidth = Math.max(titleWidth, ...detailWidths) + padding * 2;
      const tooltipHeight =
        padding * 2 + titleFontSize + details.length * lineHeight;

      const tooltipX = x - maxWidth / 2;
      const tooltipY = y + size + 8;

      // Background
      context.fillStyle = "rgba(20, 21, 23, 0.92)";
      context.beginPath();
      const r = 6;
      context.roundRect(tooltipX, tooltipY, maxWidth, tooltipHeight, r);
      context.fill();
      context.strokeStyle = "rgba(255, 255, 255, 0.08)";
      context.lineWidth = 1;
      context.stroke();

      // Title (full, untruncated)
      context.font = `600 ${titleFontSize}px Inter, system-ui, sans-serif`;
      context.fillStyle = "#e5e6e8";
      context.textAlign = "left";
      context.textBaseline = "top";
      context.fillText(fullLabel, tooltipX + padding, tooltipY + padding);

      // Detail lines
      context.font = `${detailFontSize}px Inter, system-ui, sans-serif`;
      context.fillStyle = "#9ca3af";
      details.forEach((line, i) => {
        context.fillText(
          line,
          tooltipX + padding,
          tooltipY + padding + titleFontSize + 2 + i * lineHeight,
        );
      });
    };

    // Custom node label drawing — truncation + source graph ring in multi-graph mode
    const drawNodeLabel = (
      context: CanvasRenderingContext2D,
      data: {
        x: number;
        y: number;
        size: number;
        color: string;
        label?: string | null;
      },
      settings: {
        labelFont: string;
        labelSize: number;
        labelWeight: string;
        labelColor: { color: string };
      },
    ) => {
      if (!data.label) return;

      const fontSize = settings.labelSize;
      const font = settings.labelFont;
      const weight = settings.labelWeight || "";
      const color = settings.labelColor.color;

      // Source graph ring (multi-graph mode)
      const borderCol = (data as any).borderColor;
      if (borderCol) {
        const isSquare = (data as any).type === "square";
        context.save();
        shapePath(context, data.x, data.y, data.size + 2, isSquare);
        context.strokeStyle = borderCol;
        context.lineWidth = 2;
        context.stroke();
        context.restore();
      }

      // Label text — match sigma's default positioning
      context.fillStyle = color;
      context.font = `${weight} ${fontSize}px ${font}`;
      context.fillText(
        truncateLabel(data.label),
        data.x + data.size + 8,
        data.y + fontSize / 3,
      );
    };

    const BigArrowProgram = createEdgeArrowProgram({
      widenessToThicknessRatio: 6,
      lengthToThicknessRatio: 6,
    });

    const sigma = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: true,
      defaultEdgeType: "arrow",
      defaultNodeType: "circle",
      edgeProgramClasses: {
        arrow: BigArrowProgram,
      },
      nodeProgramClasses: {
        square: NodeSquareProgram,
      },
      defaultNodeColor: STATUS_COLORS.open,
      defaultEdgeColor: "#6b728090",
      labelColor: { color: "#d1d2d3" },
      labelFont: "Inter, system-ui, sans-serif",
      labelSize: 11,
      labelRenderedSizeThreshold: 6,
      edgeLabelColor: { color: "#7a7b7e" },
      enableEdgeEvents: true,
      minEdgeThickness: 0.5,
      defaultDrawNodeLabel: drawNodeLabel as any,
      defaultDrawNodeHover: drawNodeHover as any,
      // Smooth interactions
      zoomDuration: 200,
      inertiaDuration: 500,
      inertiaRatio: 0.5,
    });

    sigmaRef.current = sigma;
    setSigmaInstance(sigma);
    applySigmaPerfSettings(sigma, graph.order);

    // Scale edge label size with zoom (debounced to avoid re-render storms)
    const BASE_EDGE_LABEL_SIZE = 25;
    let labelSizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastLabelRatio = -1;
    sigma.getCamera().on("updated", () => {
      const ratio = sigma.getCamera().ratio;
      // Only update if ratio changed meaningfully (avoids jitter from micro-adjustments)
      if (Math.abs(ratio - lastLabelRatio) < 0.01) return;
      if (labelSizeTimer) clearTimeout(labelSizeTimer);
      labelSizeTimer = setTimeout(() => {
        lastLabelRatio = ratio;
        sigma.setSetting("edgeLabelSize", BASE_EDGE_LABEL_SIZE / (ratio + 1));
      }, 100);
    });

    // ---------- Hover highlighting ----------
    sigma.on("enterNode", ({ node }) => {
      hoveredNodeRef.current = node;
      setHoveredNode(node);
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("leaveNode", () => {
      hoveredNodeRef.current = null;
      setHoveredNode(null);
      sigma.refresh({ skipIndexation: true });
    });

    // ---------- Edge hover (custom hit detection) ----------
    const EDGE_HIT_DISTANCE = 12; // pixels
    sigma.on(
      "moveBody" as any,
      ({ event: e }: { event: { x: number; y: number } }) => {
        // Skip if hovering a node (nodes take priority)
        if (hoveredNodeRef.current) {
          if (hoveredEdgeRef.current) {
            hoveredEdgeRef.current = null;
            setHoveredEdge(null);
          }
          return;
        }

        let closestEdge: string | null = null;
        let closestDist = EDGE_HIT_DISTANCE;

        graph.forEachEdge((edge, _attrs, source, target) => {
          // Use live graph coords → viewport for accurate positions during physics
          const sAttrs = graph.getNodeAttributes(source);
          const tAttrs = graph.getNodeAttributes(target);
          if (!sAttrs || !tAttrs) return;
          const sPos = sigma.graphToViewport({
            x: sAttrs.x as number,
            y: sAttrs.y as number,
          });
          const tPos = sigma.graphToViewport({
            x: tAttrs.x as number,
            y: tAttrs.y as number,
          });

          // Point-to-segment distance
          const ax = sPos.x,
            ay = sPos.y;
          const bx = tPos.x,
            by = tPos.y;
          const dx = bx - ax,
            dy = by - ay;
          const lenSq = dx * dx + dy * dy;
          if (lenSq < 1) return;

          let t = ((e.x - ax) * dx + (e.y - ay) * dy) / lenSq;
          t = Math.max(0, Math.min(1, t));
          const px = ax + t * dx;
          const py = ay + t * dy;
          const dist = Math.sqrt((e.x - px) ** 2 + (e.y - py) ** 2);

          if (dist < closestDist) {
            closestDist = dist;
            closestEdge = edge;
          }
        });

        if (closestEdge !== hoveredEdgeRef.current) {
          hoveredEdgeRef.current = closestEdge;
          setHoveredEdge(closestEdge);
          sigma.refresh({ skipIndexation: true });
        }
      },
    );

    // ---------- Preview arrow for link mode ----------
    sigma.on("afterRender", () => {
      // Always clear the overlay canvas first
      const canvases = sigma.getCanvases();
      const canvas = canvases.mouse;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const currentLinkMode = linkModeRef.current;
      const hovered = hoveredNodeRef.current;

      // Only draw when picking target and hovering a valid node
      if (
        !currentLinkMode.active ||
        currentLinkMode.step !== "pick-target" ||
        !hovered
      )
        return;
      if (hovered === currentLinkMode.sourceNode.id) return;
      if (
        !graph.hasNode(currentLinkMode.sourceNode.id) ||
        !graph.hasNode(hovered)
      )
        return;

      // Get viewport positions of source and target
      const sourceAttrs = graph.getNodeAttributes(
        currentLinkMode.sourceNode.id,
      );
      const targetAttrs = graph.getNodeAttributes(hovered);

      const srcPos = sigma.graphToViewport({
        x: sourceAttrs.x as number,
        y: sourceAttrs.y as number,
      });
      const tgtPos = sigma.graphToViewport({
        x: targetAttrs.x as number,
        y: targetAttrs.y as number,
      });

      const ratio = sigma.getCamera().ratio;
      const srcSize = (sourceAttrs.size as number) || 14;
      const tgtSize = (targetAttrs.size as number) || 14;

      // Compute arrow direction
      const dx = tgtPos.x - srcPos.x;
      const dy = tgtPos.y - srcPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) return;

      const ux = dx / dist;
      const uy = dy / dist;

      // Shorten arrow to stop at node edges
      const startOffset = srcSize / ratio + 4;
      const endOffset = tgtSize / ratio + 12;
      const x1 = srcPos.x + ux * startOffset;
      const y1 = srcPos.y + uy * startOffset;
      const x2 = tgtPos.x - ux * endOffset;
      const y2 = tgtPos.y - uy * endOffset;

      ctx.save();

      // Dashed line
      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "rgba(251, 191, 36, 0.6)";
      ctx.lineWidth = 2;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // Arrowhead
      const headLen = 10;
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(251, 191, 36, 0.8)";
      ctx.beginPath();
      ctx.moveTo(x2 + ux * headLen, y2 + uy * headLen);
      ctx.lineTo(x2 - uy * headLen * 0.5, y2 + ux * headLen * 0.5);
      ctx.lineTo(x2 + uy * headLen * 0.5, y2 - ux * headLen * 0.5);
      ctx.closePath();
      ctx.fill();

      ctx.restore();

      // --- Edge hover tooltip ---
      const hovEdge = hoveredEdgeRef.current;
      if (hovEdge && graph.hasEdge(hovEdge)) {
        const edgeAttrs = graph.getEdgeAttributes(hovEdge);
        const sourceKey = graph.source(hovEdge);
        const targetKey = graph.target(hovEdge);
        const sourceAttrs2 = graph.getNodeAttributes(sourceKey);
        const targetAttrs2 = graph.getNodeAttributes(targetKey);

        const srcName = (sourceAttrs2.label as string) || sourceKey;
        const tgtName = (targetAttrs2.label as string) || targetKey;
        const edgeType = (edgeAttrs.edgeType as string) || "related";

        // Position tooltip at midpoint of edge
        const s = sigma.graphToViewport({
          x: sourceAttrs2.x as number,
          y: sourceAttrs2.y as number,
        });
        const t = sigma.graphToViewport({
          x: targetAttrs2.x as number,
          y: targetAttrs2.y as number,
        });
        const mx = (s.x + t.x) / 2;
        const my = (s.y + t.y) / 2;

        const label = `${truncateLabel(srcName)}  →  ${truncateLabel(tgtName)}`;
        const typeLine = edgeType.replace(/-/g, " ");

        ctx.save();
        const fontSize = 11;
        const detailSize = 10;
        const padding = 8;
        ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
        const labelW = ctx.measureText(label).width;
        ctx.font = `${detailSize}px Inter, system-ui, sans-serif`;
        const typeW = ctx.measureText(typeLine).width;
        const boxW = Math.max(labelW, typeW) + padding * 2;
        const boxH = padding * 2 + fontSize + detailSize + 4;
        const bx = mx - boxW / 2;
        const by = my - boxH - 8;

        // Background
        ctx.fillStyle = "rgba(20, 21, 23, 0.92)";
        ctx.beginPath();
        ctx.roundRect(bx, by, boxW, boxH, 6);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Label
        ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = "#e5e6e8";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(label, bx + padding, by + padding);

        // Type
        ctx.font = `${detailSize}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = "#9ca3af";
        ctx.fillText(typeLine, bx + padding, by + padding + fontSize + 4);

        ctx.restore();
      }
    });

    // ---------- Node click ----------
    sigma.on("clickNode", ({ node }) => {
      // If we just finished a drag, don't treat it as a click
      if (dragStateRef.current.dragging) return;

      const nodeData = graph.getNodeAttributes(node);
      const data = (nodeData._data as OpenTasksGraphNode) || {
        id: node,
        type: "task",
        ...nodeData,
      };
      const currentLinkMode = linkModeRef.current;

      // --- Link mode: pick source or target ---
      if (currentLinkMode.active) {
        if (currentLinkMode.step === "pick-source") {
          setLinkModeAndRef({
            active: true,
            step: "pick-target",
            sourceNode: data,
          });
        } else if (currentLinkMode.step === "pick-target") {
          // Create the edge — strip multi-graph resource prefix if present
          const stripPrefix = (id: string) =>
            id.includes(":") ? id.split(":").pop()! : id;
          const sourceId = stripPrefix(currentLinkMode.sourceNode.id);
          const targetId = stripPrefix(data.id);
          if (sourceId !== targetId) {
            createLinkRef.current.mutate({
              nodeId: sourceId,
              targetId,
              type: linkTypeRef.current,
            });
          }
          setLinkModeAndRef({ active: false });
        }
        return;
      }

      // --- Normal mode: select node ---
      setSelectedNode(data);
      setSelectedEdge(null);
      onNodeSelectRef.current?.(data);

      // Smooth camera follow — convert raw graph coords to framed graph coords
      const viewportPos = sigma.graphToViewport({
        x: nodeData.x as number,
        y: nodeData.y as number,
      });
      const framedPos = sigma.viewportToFramedGraph(viewportPos);
      const camera = sigma.getCamera();
      camera.animate(
        { x: framedPos.x, y: framedPos.y, ratio: Math.min(camera.ratio, 0.7) },
        { duration: 400 },
      );
    });

    sigma.on("clickStage", () => {
      if (dragStateRef.current.dragging) return;
      // Cancel link mode on stage click
      if (linkModeRef.current.active) {
        setLinkModeAndRef({ active: false });
        return;
      }
      // If hovering an edge, select it instead of deselecting
      if (hoveredEdgeRef.current && graph.hasEdge(hoveredEdgeRef.current)) {
        const edgeAttrs = graph.getEdgeAttributes(hoveredEdgeRef.current);
        setSelectedEdge({
          id: hoveredEdgeRef.current,
          from_id: graph.source(hoveredEdgeRef.current),
          to_id: graph.target(hoveredEdgeRef.current),
          type: (edgeAttrs.edgeType as string) || "related",
        });
        setSelectedNode(null);
        onNodeSelectRef.current?.(null);
        return;
      }
      setSelectedNode(null);
      setSelectedEdge(null);
      onNodeSelectRef.current?.(null);
    });

    // ---------- Node drag ----------
    let draggedNode: string | null = null;

    sigma.on("downNode", ({ node, event }) => {
      draggedNode = node;
      dragStateRef.current = {
        dragging: false,
        node,
        startX: event.x,
        startY: event.y,
      };

      // Fix the node position so FA2 doesn't move it
      graph.setNodeAttribute(node, "fixed", true);

      // Restart physics so other nodes respond to the drag
      if (supervisorRef.current && !supervisorRef.current.isRunning()) {
        supervisorRef.current.start();
      }

      // Prevent camera movement during drag
      sigma.getCamera().disable();
    });

    // Use the renderer's mouse move (works everywhere on canvas)
    sigma
      .getMouseCaptor()
      .on(
        "mousemovebody",
        (event: { x: number; y: number; original: MouseEvent }) => {
          if (!draggedNode) return;

          // Detect actual dragging (moved > 3px)
          const dx = event.x - dragStateRef.current.startX;
          const dy = event.y - dragStateRef.current.startY;
          if (
            !dragStateRef.current.dragging &&
            Math.sqrt(dx * dx + dy * dy) > 3
          ) {
            dragStateRef.current.dragging = true;
          }

          // Convert viewport coords to graph coords
          const pos = sigma.viewportToGraph({ x: event.x, y: event.y });
          graph.setNodeAttribute(draggedNode, "x", pos.x);
          graph.setNodeAttribute(draggedNode, "y", pos.y);
        },
      );

    const handleMouseUp = () => {
      if (draggedNode) {
        graph.removeNodeAttribute(draggedNode, "fixed");
        draggedNode = null;
        sigma.getCamera().enable();

        // Stop physics after nodes settle from the drag
        setTimeout(() => {
          if (supervisorRef.current?.isRunning()) {
            supervisorRef.current.stop();
          }
        }, 800);

        // Small delay so the click handler can check dragStateRef
        setTimeout(() => {
          dragStateRef.current = {
            dragging: false,
            node: null,
            startX: 0,
            startY: 0,
          };
        }, 50);
      }
    };
    sigma.getMouseCaptor().on("mouseup", handleMouseUp);
    // Also catch mouseup outside the canvas
    document.addEventListener("mouseup", handleMouseUp);

    // ---------- Start FA2 supervisor ----------
    const supervisor = new FA2LayoutSupervisor(graph, {
      settings: getFA2Settings(graph.order),
    });
    supervisorRef.current = supervisor;

    supervisor.start();
    setCardsSettled(false);
    const settleDuration =
      graph.order > 500 ? 5000 : graph.order > 100 ? 3500 : 2500;
    const settleTimer = setTimeout(() => {
      supervisor.stop();
      // Final noverlap pass to pry apart any residual overlaps. When cards
      // are on, run the card-aware pass instead — the default settings are
      // tuned for dot-sized collision and leave 208×64 cards stacked.
      if (graph.order < 5000) {
        if (showCardsRef.current) {
          cardAwareNoverlap(graph);
        } else {
          noverlap.assign(graph, NOVERLAP_SETTINGS);
        }
        sigma.refresh();
      }
      setCardsSettled(true);
    }, settleDuration);

    return () => {
      if (settleTimer) clearTimeout(settleTimer);
      supervisor.kill();
      supervisorRef.current = null;
      document.removeEventListener("mouseup", handleMouseUp);
      sigma.kill();
      sigmaRef.current = null;
      setSigmaInstance(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphFingerprint]);

  // Depth-visible set lifted out of the reducer so the overlay (path A)
  // can apply the same filter to its HTML cards. Sigma's reducer and the
  // overlay both read this single source of truth.
  const depthVisible = useMemo<Set<string> | null>(() => {
    if (!graph || depthFilter <= 0 || !selectedNode) return null;
    return getNodesWithinHops(graph, selectedNode.id, depthFilter);
  }, [graph, depthFilter, selectedNode]);

  // When cards are shown, suppress sigma's labels (cards already carry the
  // text) — flip `labelRenderedSizeThreshold` between its default (6) and an
  // effectively-infinite value. Sigma keeps rendering the colored dots
  // underneath each card, which become the visible signal once the user
  // zooms far enough out that cards hide.
  useEffect(() => {
    const sigma = sigmaInstance;
    if (!sigma) return;
    sigma.setSetting("labelRenderedSizeThreshold", showCards ? 9999 : 6);
    sigma.refresh({ skipIndexation: true });
  }, [sigmaInstance, showCards]);

  // Re-run the card-aware noverlap when the user toggles cards on *after*
  // physics has already settled. The mount effect's settle timer handles
  // the first-mount case for both modes; this effect only fires the late
  // transitions. Guard against running while the FA2 supervisor is still
  // active — touching node coords mid-physics fights the worker.
  useEffect(() => {
    const sigma = sigmaInstance;
    if (!sigma || !graph || !showCards || graph.order === 0) return;
    if (supervisorRef.current?.isRunning()) return;
    cardAwareNoverlap(graph);
    sigma.refresh();
  }, [sigmaInstance, graph, showCards]);

  // ---------- Node/edge reducers for hover + depth filtering ----------
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma || !graph) return;

    sigma.setSetting(
      "nodeReducer",
      (node: string, data: Record<string, any>) => {
        const result = { ...data };

        // Depth filter: hide nodes outside hop range
        if (depthVisible && !depthVisible.has(node)) {
          result.hidden = true;
          return result;
        }

        // Hover highlight: dim non-neighbors
        if (hoveredNode && hoveredNode !== node && graph.hasNode(hoveredNode)) {
          const neighbors = getNeighborSet(graph, hoveredNode);
          if (!neighbors.has(node)) {
            result.color = hexToRgba(data.color || STATUS_COLORS.open, 0.15);
            result.label = null; // hide label for dimmed nodes
          }
        }

        // Add subtle glow via increased size for hovered node
        if (hoveredNode === node) {
          result.size = (data.size || 8) * 1.3;
          result.zIndex = 10;
        }

        // Link mode: highlight source node with amber ring
        if (linkMode.active && linkMode.step === "pick-target") {
          if (node === linkMode.sourceNode.id) {
            result.color = "#f59e0b";
            result.size = (data.size || 8) * 1.4;
            result.zIndex = 10;
          }
        }

        return result;
      },
    );

    sigma.setSetting(
      "edgeReducer",
      (edge: string, data: Record<string, any>) => {
        const result = { ...data };
        let source: string, target: string;
        try {
          source = graph.source(edge);
          target = graph.target(edge);
        } catch {
          return result;
        }

        // Depth filter
        if (
          depthVisible &&
          (!depthVisible.has(source) || !depthVisible.has(target))
        ) {
          result.hidden = true;
          return result;
        }

        // Edge hover highlight
        if (hoveredEdge === edge) {
          result.color = "#fbbf24";
          result.size = data.size || 4;
          result.label = ((data.edgeType as string) || "related").replace(
            /-/g,
            " ",
          );
          return result;
        }

        // Node hover highlight
        if (hoveredNode) {
          if (source === hoveredNode || target === hoveredNode) {
            result.color = "#e5e7ebb0";
            result.size = 3;
          } else {
            result.color = "#6b728015";
            result.size = 1;
          }
        }

        return result;
      },
    );

    sigma.refresh({ skipIndexation: true });
  }, [hoveredNode, hoveredEdge, depthVisible, graph, linkMode]);

  // Recolor graph nodes based on colorMode (status vs. swarm)
  useEffect(() => {
    if (!graph) return;
    graph.forEachNode((nodeKey, attrs) => {
      const data = (attrs as { _data?: OpenTasksGraphNode })._data;
      let nextColor: string;
      if (colorMode === "swarm" && data?.type === "task") {
        const swarm = resolveAssigneeSwarm((data as any).assignee, swarms);
        nextColor = swarm ? swarmColorFor(swarm.id) : SWARM_UNASSIGNED_COLOR;
      } else {
        const status = (attrs as { status?: string }).status || "open";
        nextColor = STATUS_COLORS[status] || STATUS_COLORS.open;
      }
      if ((attrs as { color?: string }).color !== nextColor) {
        graph.setNodeAttribute(nodeKey, "color", nextColor);
      }
    });
    sigmaRef.current?.refresh();
  }, [colorMode, swarms, graph]);

  const toggleColorMode = useCallback(() => {
    setColorMode((prev) => {
      const next = prev === "status" ? "swarm" : "status";
      try {
        localStorage.setItem("openhive-task-color-mode", next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const handleZoomIn = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    sigma.getCamera().animatedZoom({ duration: 200 });
  }, []);

  const handleZoomOut = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    sigma.getCamera().animatedUnzoom({ duration: 200 });
  }, []);

  const handleFitView = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    sigma.getCamera().animatedReset({ duration: 300 });
  }, []);

  // Focus on newly created node once it appears in the graph
  useEffect(() => {
    const nodeId = pendingFocusRef.current;
    if (!nodeId || !graph || !graph.hasNode(nodeId)) return;

    const sigma = sigmaRef.current;
    if (!sigma) return;

    pendingFocusRef.current = null;

    // Select the node
    const nodeData = graph.getNodeAttributes(nodeId);
    const data = (nodeData._data as OpenTasksGraphNode) || {
      id: nodeId,
      type: "task",
      ...nodeData,
    };
    setSelectedNode(data);
    onNodeSelect?.(data);

    // Animate camera to it
    const viewportPos = sigma.graphToViewport({
      x: nodeData.x as number,
      y: nodeData.y as number,
    });
    const framedPos = sigma.viewportToFramedGraph(viewportPos);
    const camera = sigma.getCamera();
    camera.animate(
      { x: framedPos.x, y: framedPos.y, ratio: Math.min(camera.ratio, 0.7) },
      { duration: 400 },
    );
  }, [graph, onNodeSelect]);

  const handleNodeCreated = useCallback(
    (nodeId: string) => {
      // If the node is already in the graph, focus immediately
      if (graph && graph.hasNode(nodeId)) {
        const sigma = sigmaRef.current;
        if (!sigma) return;
        const nodeData = graph.getNodeAttributes(nodeId);
        const data = (nodeData._data as OpenTasksGraphNode) || {
          id: nodeId,
          type: "task",
          ...nodeData,
        };
        setSelectedNode(data);
        onNodeSelect?.(data);
        const viewportPos = sigma.graphToViewport({
          x: nodeData.x as number,
          y: nodeData.y as number,
        });
        const framedPos = sigma.viewportToFramedGraph(viewportPos);
        sigma.getCamera().animate(
          {
            x: framedPos.x,
            y: framedPos.y,
            ratio: Math.min(sigma.getCamera().ratio, 0.7),
          },
          { duration: 400 },
        );
      } else {
        // Node hasn't appeared yet — set pending focus for when graph updates
        pendingFocusRef.current = nodeId;
      }
    },
    [graph, onNodeSelect],
  );

  const handleCloseSidebar = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    onNodeSelect?.(null);
    setDepthFilter(0);
  }, [onNodeSelect]);

  const handleSidebarSelectNode = useCallback(
    (node: OpenTasksGraphNode) => {
      setSelectedNode(node);
      setSelectedEdge(null);
      onNodeSelect?.(node);

      // Animate camera to the node
      const sigma = sigmaRef.current;
      if (sigma && graph.hasNode(node.id)) {
        const nodeData = graph.getNodeAttributes(node.id);
        const viewportPos = sigma.graphToViewport({
          x: nodeData.x as number,
          y: nodeData.y as number,
        });
        const framedPos = sigma.viewportToFramedGraph(viewportPos);
        sigma
          .getCamera()
          .animate(
            {
              x: framedPos.x,
              y: framedPos.y,
              ratio: Math.min(sigma.getCamera().ratio, 0.7),
            },
            { duration: 400 },
          );
      }
    },
    [graph, onNodeSelect],
  );

  return (
    <div className="flex h-full overflow-hidden">
      {/* Canvas */}
      <div
        className="flex-1 relative overflow-hidden"
        style={{ backgroundColor: "var(--color-bg)" }}
      >
        <div
          ref={containerRef}
          className="w-full h-full overflow-hidden"
          style={{ cursor: linkMode.active ? "crosshair" : "grab" }}
        />

        {/* Controls overlay */}
        <div className="absolute bottom-3 left-3 flex flex-col gap-1">
          <button
            onClick={handleZoomIn}
            className="btn-ghost p-1.5 rounded"
            style={{ backgroundColor: "var(--color-surface)" }}
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={handleZoomOut}
            className="btn-ghost p-1.5 rounded"
            style={{ backgroundColor: "var(--color-surface)" }}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={handleFitView}
            className="btn-ghost p-1.5 rounded"
            style={{ backgroundColor: "var(--color-surface)" }}
          >
            <Maximize2 className="w-4 h-4" />
          </button>
          <button
            onClick={toggleColorMode}
            className="btn-ghost p-1.5 rounded"
            style={{
              backgroundColor: "var(--color-surface)",
              color:
                colorMode === "swarm"
                  ? "var(--color-honey-500, #f59e0b)"
                  : undefined,
            }}
            title={`Color by: ${colorMode === "swarm" ? "swarm" : "status"} (click to toggle)`}
          >
            <Palette className="w-4 h-4" />
          </button>
          <button
            onClick={toggleShowCards}
            className="btn-ghost p-1.5 rounded"
            style={{
              backgroundColor: "var(--color-surface)",
              color: showCards
                ? "var(--color-honey-500, #f59e0b)"
                : undefined,
            }}
            title={
              showCards
                ? "Showing rich task cards (click for dot mode)"
                : "Showing dots only (click for card mode)"
            }
          >
            {showCards ? (
              <LayoutPanelLeft className="w-4 h-4" />
            ) : (
              <Circle className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Path A — always-visible cards overlaying sigma's node dots. Pure
            decoration (pointer-events: none); sigma still owns clicks, drag,
            hover, link mode, and the depth filter. */}
        {showCards && (
          <TaskGraphCardOverlay
            sigma={sigmaInstance}
            graph={graph}
            hoveredNode={hoveredNode}
            selectedNodeId={selectedNode?.id ?? null}
            depthVisible={depthVisible}
            colorMode={colorMode}
            swarms={swarms}
            settled={cardsSettled}
          />
        )}

        {/* Color-by-swarm legend */}
        {colorMode === "swarm" && swarms && swarms.length > 0 && (
          <div
            className="absolute top-3 right-3 flex flex-col gap-1 px-2 py-1.5 rounded-lg max-h-[60%] overflow-y-auto"
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            <div
              className="text-2xs font-medium"
              style={{ color: "var(--color-text-muted)" }}
            >
              Color by swarm
            </div>
            {swarms.map((s: MapSwarm) => (
              <div key={s.id} className="flex items-center gap-1.5 text-2xs">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: swarmColorFor(s.id) }}
                />
                <span className="truncate max-w-[120px]">{s.name}</span>
                <span className="opacity-50">·</span>
                <span
                  className={
                    s.status === "online"
                      ? "text-emerald-400"
                      : s.status === "unreachable"
                        ? "text-amber-400"
                        : "opacity-50"
                  }
                >
                  {s.status}
                </span>
              </div>
            ))}
            <div
              className="flex items-center gap-1.5 text-2xs pt-1 border-t"
              style={{ borderColor: "var(--color-border-subtle)" }}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: SWARM_UNASSIGNED_COLOR }}
              />
              <span style={{ color: "var(--color-text-muted)" }}>
                Unassigned / other
              </span>
            </div>
          </div>
        )}

        {/* Depth filter (shown when a node is selected) */}
        {selectedNode && (
          <div
            className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-lg"
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            <GitFork
              className="w-3.5 h-3.5"
              style={{ color: "var(--color-text-muted)" }}
            />
            <span
              className="text-2xs"
              style={{ color: "var(--color-text-muted)" }}
            >
              Depth
            </span>
            <input
              type="range"
              min={0}
              max={5}
              value={depthFilter}
              onChange={(e) => setDepthFilter(Number(e.target.value))}
              className="w-20 h-1 accent-amber-500"
              title={
                depthFilter === 0
                  ? "Show all"
                  : `${depthFilter} hop${depthFilter > 1 ? "s" : ""}`
              }
            />
            <span
              className="text-2xs font-mono w-8"
              style={{ color: "var(--color-text-muted)" }}
            >
              {depthFilter === 0 ? "All" : `${depthFilter}h`}
            </span>
          </div>
        )}

        {/* Legends — stacked top-left */}
        <div className="absolute top-3 left-3 flex flex-col gap-2">
          {/* Status legend */}
          <div
            className="p-2 rounded text-2xs space-y-1"
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            <div
              className="text-2xs font-medium mb-1"
              style={{ color: "var(--color-text-muted)" }}
            >
              Status
            </div>
            {Object.entries(STATUS_COLORS).map(([status, color]) => (
              <div key={status} className="flex items-center gap-1.5">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{
                    backgroundColor: color,
                    boxShadow: `0 0 6px ${hexToRgba(color, 0.5)}`,
                  }}
                />
                <span style={{ color: "var(--color-text-muted)" }}>
                  {status.replace("_", " ")}
                </span>
              </div>
            ))}
          </div>

          {/* Graph sources legend (multi-graph) */}
          {graphSources && graphSources.size > 1 && (
            <div
              className="p-2 rounded text-2xs space-y-1"
              style={{
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border-subtle)",
              }}
            >
              <div
                className="text-2xs font-medium mb-1"
                style={{ color: "var(--color-text-muted)" }}
              >
                Graphs
              </div>
              {Array.from(graphSources.entries()).map(
                ([id, { name, color }]) => (
                  <div key={id} className="flex items-center gap-1.5">
                    <div
                      className="w-2.5 h-2.5 rounded-full border-2"
                      style={{
                        borderColor: color,
                        backgroundColor: "transparent",
                      }}
                    />
                    <span
                      className="truncate max-w-[120px]"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      {name}
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {/* Action bar */}
        <GraphActionBar
          resourceId={resourceId}
          linkMode={linkMode}
          onLinkModeChange={setLinkModeAndRef}
          linkType={linkType}
          onLinkTypeChange={setLinkTypeAndRef}
          onNodeCreated={handleNodeCreated}
        />

        {/* Empty state */}
        {graph.order === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
              No nodes in graph
            </p>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <TaskGraphSidebar
        node={selectedNode}
        resourceId={resourceId}
        selectedEdge={selectedEdge}
        onClose={handleCloseSidebar}
        onSelectNode={handleSidebarSelectNode}
        edges={edges}
        allNodes={allNodes}
      />
    </div>
  );
});
