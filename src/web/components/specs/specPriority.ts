import type { StatusTone } from '../common/StatusChip';

/**
 * Maps a spec priority number to the StatusChip tone + display label.
 * P0 = highest urgency (danger), P4 = lowest (neutral).
 */
export const PRIORITY_MAP: Record<number, { tone: StatusTone; label: string }> = {
  0: { tone: 'danger',  label: 'P0' },
  1: { tone: 'warning', label: 'P1' },
  2: { tone: 'info',    label: 'P2' },
  3: { tone: 'neutral', label: 'P3' },
  4: { tone: 'neutral', label: 'P4' },
};
