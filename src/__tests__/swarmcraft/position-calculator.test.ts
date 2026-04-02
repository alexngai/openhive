import { describe, it, expect, beforeEach } from 'vitest';
import { PositionCalculator } from '../../../references/swarmcraft/src/ui/utils/position-calculator.js';

describe('PositionCalculator', () => {
  let calc: PositionCalculator;
  let nodePositions: Map<string, { x: number; y: number }>;

  beforeEach(() => {
    calc = new PositionCalculator();
    nodePositions = new Map([
      ['src/server.ts', { x: 100, y: 200 }],
      ['src/api/routes/agents.ts', { x: 300, y: 400 }],
      ['src/web/App.tsx', { x: 500, y: 100 }],
      ['lib/utils.ts', { x: 0, y: 0 }],
      ['src/config.ts', { x: 200, y: 300 }],
    ]);
  });

  describe('exact path matching (tier 1)', () => {
    it('should match exact file paths', () => {
      calc.recordAccess('agent-1', 'src/server.ts', 'write');
      const pos = calc.calculatePosition('agent-1', nodePositions);
      expect(pos).not.toBeNull();
      expect(pos!.x).toBe(100);
      expect(pos!.y).toBe(200);
    });

    it('should return null when no activity recorded', () => {
      const pos = calc.calculatePosition('agent-1', nodePositions);
      expect(pos).toBeNull();
    });

    it('should return null when no paths match graph nodes', () => {
      calc.recordAccess('agent-1', 'nonexistent/file.ts', 'read');
      const pos = calc.calculatePosition('agent-1', nodePositions);
      expect(pos).toBeNull();
    });
  });

  describe('suffix matching (tier 2)', () => {
    it('should match absolute path to relative node via suffix', () => {
      // Agent reports absolute path, graph has relative path
      calc.recordAccess('agent-1', '/Users/dev/project/src/server.ts', 'write');
      const pos = calc.calculatePosition('agent-1', nodePositions);
      expect(pos).not.toBeNull();
      expect(pos!.x).toBe(100);
      expect(pos!.y).toBe(200);
    });

    it('should match relative path to absolute node via suffix', () => {
      // Graph has absolute paths, agent has relative
      const absNodes = new Map([
        ['/Users/dev/project/src/server.ts', { x: 100, y: 200 }],
      ]);
      calc.recordAccess('agent-1', 'src/server.ts', 'write');
      const pos = calc.calculatePosition('agent-1', absNodes);
      expect(pos).not.toBeNull();
      expect(pos!.x).toBe(100);
      expect(pos!.y).toBe(200);
    });

    it('should match deep nested paths via suffix', () => {
      calc.recordAccess('agent-1', '/home/user/repos/openhive/src/api/routes/agents.ts', 'write');
      const pos = calc.calculatePosition('agent-1', nodePositions);
      expect(pos).not.toBeNull();
      expect(pos!.x).toBe(300);
      expect(pos!.y).toBe(400);
    });
  });

  describe('filename matching (tier 3)', () => {
    it('should match by filename when path does not match', () => {
      // "config.ts" matches "src/config.ts" by filename
      const nodes = new Map([
        ['src/config.ts', { x: 200, y: 300 }],
      ]);
      calc.recordAccess('agent-1', 'packages/other/config.ts', 'read');
      const pos = calc.calculatePosition('agent-1', nodes);
      expect(pos).not.toBeNull();
      expect(pos!.x).toBe(200);
      expect(pos!.y).toBe(300);
    });

    it('should skip ambiguous filenames like index.ts', () => {
      const nodes = new Map([
        ['src/index.ts', { x: 100, y: 100 }],
        ['src/web/index.tsx', { x: 200, y: 200 }],
      ]);
      calc.recordAccess('agent-1', 'lib/index.ts', 'read');
      const pos = calc.calculatePosition('agent-1', nodes);
      // index.ts is explicitly filtered out as ambiguous
      expect(pos).toBeNull();
    });

    it('should skip ambiguous filenames like index.tsx', () => {
      const nodes = new Map([
        ['src/web/index.tsx', { x: 200, y: 200 }],
      ]);
      calc.recordAccess('agent-1', 'other/index.tsx', 'read');
      const pos = calc.calculatePosition('agent-1', nodes);
      expect(pos).toBeNull();
    });

    it('should skip ambiguous filenames like index.js', () => {
      const nodes = new Map([
        ['dist/index.js', { x: 50, y: 50 }],
      ]);
      calc.recordAccess('agent-1', 'build/index.js', 'read');
      const pos = calc.calculatePosition('agent-1', nodes);
      expect(pos).toBeNull();
    });
  });

  describe('weighted centroid calculation', () => {
    it('should compute weighted average of multiple file positions', () => {
      // Two files with equal recency, both writes
      calc.recordAccess('agent-1', 'src/server.ts', 'write');      // (100, 200)
      calc.recordAccess('agent-1', 'src/web/App.tsx', 'write');     // (500, 100)
      // Note: most recent is first (index 0), so App.tsx has higher weight

      const pos = calc.calculatePosition('agent-1', nodePositions);
      expect(pos).not.toBeNull();
      // Position should be between the two nodes
      expect(pos!.x).toBeGreaterThan(100);
      expect(pos!.x).toBeLessThan(500);
    });

    it('should weight writes higher than reads', () => {
      const calc1 = new PositionCalculator({ writeMultiplier: 2.0 });
      // Record a read at (100,200) then a write at (500,100)
      calc1.recordAccess('agent-1', 'src/server.ts', 'read');
      calc1.recordAccess('agent-1', 'src/web/App.tsx', 'write');

      const pos = calc1.calculatePosition('agent-1', nodePositions);
      expect(pos).not.toBeNull();
      // Write (App.tsx) should pull position closer to (500, 100)
      expect(pos!.x).toBeGreaterThan(300); // biased toward App.tsx
    });

    it('should apply exponential decay favoring recent activity', () => {
      // Record old activity at server.ts, then recent at App.tsx
      calc.recordAccess('agent-1', 'src/server.ts', 'write');  // older (index 1)
      calc.recordAccess('agent-1', 'src/web/App.tsx', 'write'); // newer (index 0)

      const pos = calc.calculatePosition('agent-1', nodePositions);
      expect(pos).not.toBeNull();
      // Most recent (App.tsx at 500,100) should have more weight
      expect(pos!.x).toBeGreaterThan(300); // closer to 500 than 100
    });
  });

  describe('activity management', () => {
    it('should track anchor files', () => {
      calc.recordAccess('agent-1', 'src/server.ts', 'write');
      calc.recordAccess('agent-1', 'src/config.ts', 'read');

      const pos = calc.calculatePosition('agent-1', nodePositions);
      expect(pos).not.toBeNull();
      expect(pos!.anchorFiles).toContain('src/server.ts');
      expect(pos!.anchorFiles).toContain('src/config.ts');
    });

    it('should respect windowSize limit', () => {
      const smallWindow = new PositionCalculator({ windowSize: 3 });
      for (let i = 0; i < 10; i++) {
        smallWindow.recordAccess('agent-1', `file-${i}.ts`, 'read');
      }
      const activity = smallWindow.getActivity('agent-1');
      expect(activity).toHaveLength(3);
    });

    it('should clear activity for a specific agent', () => {
      calc.recordAccess('agent-1', 'src/server.ts', 'write');
      calc.recordAccess('agent-2', 'src/config.ts', 'read');

      calc.clearActivity('agent-1');

      expect(calc.getActivity('agent-1')).toHaveLength(0);
      expect(calc.getActivity('agent-2')).toHaveLength(1);
    });

    it('should clear all activity', () => {
      calc.recordAccess('agent-1', 'src/server.ts', 'write');
      calc.recordAccess('agent-2', 'src/config.ts', 'read');

      calc.clearAll();

      expect(calc.getActivity('agent-1')).toHaveLength(0);
      expect(calc.getActivity('agent-2')).toHaveLength(0);
    });
  });

  describe('calculateAllPositions', () => {
    it('should return positions for all tracked agents', () => {
      calc.recordAccess('agent-1', 'src/server.ts', 'write');
      calc.recordAccess('agent-2', 'src/web/App.tsx', 'read');

      const allPos = calc.calculateAllPositions(nodePositions);
      expect(allPos.size).toBe(2);
      expect(allPos.has('agent-1')).toBe(true);
      expect(allPos.has('agent-2')).toBe(true);
    });

    it('should exclude agents with no matching positions', () => {
      calc.recordAccess('agent-1', 'src/server.ts', 'write');
      calc.recordAccess('agent-2', 'nonexistent.ts', 'read');

      const allPos = calc.calculateAllPositions(nodePositions);
      expect(allPos.size).toBe(1);
      expect(allPos.has('agent-1')).toBe(true);
      expect(allPos.has('agent-2')).toBe(false);
    });
  });

  describe('setFallbackPosition', () => {
    it('should establish initial position for agents without activity', () => {
      calc.setFallbackPosition('agent-1', 'src/server.ts');
      const pos = calc.calculatePosition('agent-1', nodePositions);
      expect(pos).not.toBeNull();
      expect(pos!.x).toBe(100);
      expect(pos!.y).toBe(200);
    });

    it('should not overwrite existing activity', () => {
      calc.recordAccess('agent-1', 'src/web/App.tsx', 'write');
      calc.setFallbackPosition('agent-1', 'src/server.ts');

      const activity = calc.getActivity('agent-1');
      // Should still have the original activity, fallback should not be added
      expect(activity).toHaveLength(1);
      expect(activity[0].filePath).toBe('src/web/App.tsx');
    });
  });
});
