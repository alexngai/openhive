/**
 * Single source of truth for swarm-id → color resolution.
 *
 * Previously duplicated in TaskGraphViewer, TaskGraphCardOverlay, and
 * TaskHierarchyCard. Keeping it here ensures the cross-view invariant
 * ("same color for the same swarm everywhere") doesn't silently drift if
 * one copy is tweaked.
 */

export const SWARM_PALETTE = [
  '#f59e0b',
  '#3b82f6',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#ef4444',
  '#84cc16',
  '#f97316',
  '#14b8a6',
];

export const SWARM_UNASSIGNED_COLOR = '#4b5563';

/** Deterministic hash into the palette. Same input → same color, always. */
export function swarmColorFor(swarmId: string): string {
  let h = 0;
  for (let i = 0; i < swarmId.length; i++) {
    h = ((h << 5) - h + swarmId.charCodeAt(i)) | 0;
  }
  return SWARM_PALETTE[Math.abs(h) % SWARM_PALETTE.length];
}
