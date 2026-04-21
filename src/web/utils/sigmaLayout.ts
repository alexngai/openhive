/**
 * Shared sigma.js layout helpers tuned for well-spaced node placement.
 */

import Graph from "graphology";
import { random as randomLayout } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";

export interface FA2SizedSettings {
  gravity: number;
  scalingRatio: number;
  slowDown: number;
  barnesHutOptimize: boolean;
  barnesHutTheta: number;
  strongGravityMode: false;
  outboundAttractionDistribution: true;
  linLogMode: false;
  adjustSizes: true;
  edgeWeightInfluence: number;
}

export function getFA2Settings(nodeCount: number): FA2SizedSettings {
  const isSmall = nodeCount < 500;
  const isMedium = nodeCount >= 500 && nodeCount < 2000;
  const isLarge = nodeCount >= 2000 && nodeCount < 10000;

  return {
    gravity: isSmall ? 0.8 : isMedium ? 0.5 : isLarge ? 0.3 : 0.15,
    scalingRatio: isSmall ? 15 : isMedium ? 30 : isLarge ? 60 : 100,
    slowDown: isSmall ? 1 : isMedium ? 2 : isLarge ? 3 : 5,
    barnesHutOptimize: nodeCount > 200,
    barnesHutTheta: isLarge ? 0.8 : 0.6,
    strongGravityMode: false,
    outboundAttractionDistribution: true,
    linLogMode: false,
    adjustSizes: true,
    edgeWeightInfluence: 1,
  };
}

export function getLayoutDuration(nodeCount: number): number {
  if (nodeCount > 10000) return 45000;
  if (nodeCount > 5000) return 35000;
  if (nodeCount > 2000) return 30000;
  if (nodeCount > 1000) return 30000;
  if (nodeCount > 500) return 25000;
  return 20000;
}

export const NOVERLAP_SETTINGS = {
  maxIterations: 20,
  ratio: 1.1,
  margin: 10,
  expansion: 1.05,
};

/**
 * Synchronous layout for small graphs where a worker would be overkill.
 * Seeds with a wide random distribution, runs FA2 iterations to convergence,
 * then a final noverlap pass to separate residual overlaps.
 */
export function applySigmaLayout(graph: Graph): void {
  if (graph.order === 0) return;

  // Wider seed box than the default 0-1 range so FA2 starts with room to breathe.
  randomLayout.assign(graph, { scale: 1000 });

  const inferred = forceAtlas2.inferSettings(graph);
  const sized = getFA2Settings(graph.order);
  // Scale iterations with graph size — small graphs converge quickly, larger ones need more.
  const iterations = graph.order < 200 ? 300 : graph.order < 1000 ? 500 : 800;

  forceAtlas2.assign(graph, {
    iterations,
    settings: { ...inferred, ...sized },
  });

  noverlap.assign(graph, NOVERLAP_SETTINGS);
}
