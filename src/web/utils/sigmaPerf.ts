/**
 * Adaptive sigma.js settings based on graph size.
 *
 * For large graphs, disable expensive rendering features
 * (edge labels, edge rendering) to keep interactions responsive.
 */

import type Sigma from 'sigma';

const EDGE_LABEL_THRESHOLD = 150;   // hide edge labels above this node count
const EDGE_RENDER_THRESHOLD = 300;  // hide edges entirely above this node count
const LABEL_THRESHOLD_BUMP = 200;   // raise label threshold above this node count

export function applySigmaPerfSettings(sigma: Sigma, nodeCount: number): void {
  if (nodeCount > EDGE_LABEL_THRESHOLD) {
    sigma.setSetting('renderEdgeLabels', false);
  }

  if (nodeCount > EDGE_RENDER_THRESHOLD) {
    sigma.setSetting('edgeReducer', () => ({ hidden: true }));
  }

  if (nodeCount > LABEL_THRESHOLD_BUMP) {
    sigma.setSetting('labelRenderedSizeThreshold', 12);
  }
}
