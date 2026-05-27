/**
 * swarmPalette — deterministic swarm-id → color mapping.
 *
 * Previously duplicated across three files; consolidating into one helper
 * means a single test guards the cross-view invariant ("same swarm → same
 * color, in every view"). If anyone retunes the hash or the palette,
 * these assertions trip first.
 */

import { describe, it, expect } from 'vitest';
import {
  SWARM_PALETTE,
  SWARM_UNASSIGNED_COLOR,
  swarmColorFor,
} from '../../../components/task-graph/swarmPalette';

describe('swarmPalette', () => {
  describe('SWARM_PALETTE', () => {
    it('contains exactly 10 hex colors', () => {
      expect(SWARM_PALETTE).toHaveLength(10);
      for (const c of SWARM_PALETTE) {
        expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it('has no duplicate entries', () => {
      expect(new Set(SWARM_PALETTE).size).toBe(SWARM_PALETTE.length);
    });
  });

  describe('SWARM_UNASSIGNED_COLOR', () => {
    it('is a valid hex string and not part of the regular palette', () => {
      expect(SWARM_UNASSIGNED_COLOR).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(SWARM_PALETTE).not.toContain(SWARM_UNASSIGNED_COLOR);
    });
  });

  describe('swarmColorFor', () => {
    it('returns a color from the palette', () => {
      expect(SWARM_PALETTE).toContain(swarmColorFor('swarm-1'));
      expect(SWARM_PALETTE).toContain(swarmColorFor('long-uuid-here-1234'));
      expect(SWARM_PALETTE).toContain(swarmColorFor('a'));
    });

    it('is deterministic — same id maps to the same color every call', () => {
      const id = 'swarm-platform';
      const first = swarmColorFor(id);
      for (let i = 0; i < 50; i++) {
        expect(swarmColorFor(id)).toBe(first);
      }
    });

    it('different ids generally land in different slots', () => {
      // Hash collisions are possible by design; just assert the function is
      // not a constant. Spread 50 ids and require >1 unique result.
      const ids = Array.from({ length: 50 }, (_, i) => `swarm-${i}`);
      const colors = new Set(ids.map(swarmColorFor));
      expect(colors.size).toBeGreaterThan(1);
    });

    it('exercises every palette slot across a reasonable id space', () => {
      // With 10 slots and a deterministic hash, 200 distinct ids should
      // cover every slot at least once. Guards against a stuck-modulo bug.
      const ids = Array.from({ length: 200 }, (_, i) => `s${i}`);
      const hits = new Set(ids.map(swarmColorFor));
      expect(hits.size).toBe(SWARM_PALETTE.length);
    });

    it('handles empty strings without throwing', () => {
      expect(() => swarmColorFor('')).not.toThrow();
      // h=0 → SWARM_PALETTE[0]
      expect(swarmColorFor('')).toBe(SWARM_PALETTE[0]);
    });
  });
});
