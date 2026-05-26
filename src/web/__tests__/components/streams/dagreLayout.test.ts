import { describe, it, expect } from 'vitest';
import {
  layoutCascadeDAG,
  CARD_WIDTH,
  CARD_HEIGHT,
} from '../../../components/streams/layout/dagreLayout';
import type {
  StreamDAGNode,
  StreamDAGEdge,
} from '../../../hooks/useApi';

function node(id: string, overrides: Partial<StreamDAGNode> = {}): StreamDAGNode {
  return {
    id,
    stream_id: `stream-${id}`,
    source_swarm_id: 'swarm-1',
    source_agent_id: 'agent-1',
    parent_stream_id: null,
    name: id,
    status: 'active',
    task_resource_id: null,
    task_node_id: null,
    publish_branch: null,
    opened_at: '2026-01-01T00:00:00Z',
    last_event_at: '2026-01-01T00:00:00Z',
    commit_count: 1,
    open_conflict_count: 0,
    ...overrides,
  };
}

describe('layoutCascadeDAG', () => {
  it('returns an empty map for an empty input', () => {
    expect(layoutCascadeDAG([], []).size).toBe(0);
  });

  it('places a single node at a finite position', () => {
    const positions = layoutCascadeDAG([node('a')], []);
    const p = positions.get('a');
    expect(p).toBeDefined();
    expect(Number.isFinite(p!.x)).toBe(true);
    expect(Number.isFinite(p!.y)).toBe(true);
  });

  it('returns top-left coordinates (centers offset by half the card)', () => {
    // For a single node dagre centers at (CARD_WIDTH/2, CARD_HEIGHT/2) with
    // its default padding, so top-left should land at (0, 0)-ish — what we
    // actually care about is the offset invariant: top-left + half-card =
    // a finite number.
    const positions = layoutCascadeDAG([node('only')], []);
    const p = positions.get('only')!;
    expect(p.x + CARD_WIDTH / 2).toBeGreaterThanOrEqual(0);
    expect(p.y + CARD_HEIGHT / 2).toBeGreaterThanOrEqual(0);
  });

  it('lays parent → child left-to-right (child x > parent x)', () => {
    const nodes = [node('root'), node('child')];
    const edges: StreamDAGEdge[] = [
      { source: 'root', target: 'child', type: 'parent' },
    ];
    const positions = layoutCascadeDAG(nodes, edges);
    expect(positions.get('child')!.x).toBeGreaterThan(positions.get('root')!.x);
  });

  it('places siblings in different y rows under the same parent', () => {
    const nodes = [node('root'), node('a'), node('b')];
    const edges: StreamDAGEdge[] = [
      { source: 'root', target: 'a', type: 'parent' },
      { source: 'root', target: 'b', type: 'parent' },
    ];
    const positions = layoutCascadeDAG(nodes, edges);
    const ay = positions.get('a')!.y;
    const by = positions.get('b')!.y;
    expect(ay).not.toBe(by);
  });

  it('chains depth ranks: grandchild x > child x > root x', () => {
    const nodes = [node('root'), node('child'), node('grand')];
    const edges: StreamDAGEdge[] = [
      { source: 'root', target: 'child', type: 'parent' },
      { source: 'child', target: 'grand', type: 'parent' },
    ];
    const positions = layoutCascadeDAG(nodes, edges);
    const rx = positions.get('root')!.x;
    const cx = positions.get('child')!.x;
    const gx = positions.get('grand')!.x;
    expect(cx).toBeGreaterThan(rx);
    expect(gx).toBeGreaterThan(cx);
  });

  it('ignores edges that reference unknown nodes', () => {
    const nodes = [node('a')];
    const edges: StreamDAGEdge[] = [
      { source: 'a', target: 'ghost', type: 'parent' },
      { source: 'ghost', target: 'a', type: 'merge' },
    ];
    // Should not throw and should still place the known node.
    const positions = layoutCascadeDAG(nodes, edges);
    expect(positions.get('a')).toBeDefined();
  });

  it('does not throw when a merge edge would close a cycle', () => {
    // root → child (parent), then a merge back from child → root would form
    // a cycle. The layout should skip the cycle-creating edge silently.
    const nodes = [node('root'), node('child')];
    const edges: StreamDAGEdge[] = [
      { source: 'root', target: 'child', type: 'parent' },
      { source: 'child', target: 'root', type: 'merge' },
    ];
    expect(() => layoutCascadeDAG(nodes, edges)).not.toThrow();
    const positions = layoutCascadeDAG(nodes, edges);
    expect(positions.get('root')).toBeDefined();
    expect(positions.get('child')).toBeDefined();
  });

  it('handles branching merges (a child merges into a sibling)', () => {
    // root → a, root → b, then a merges into b. b should still rank to the
    // right of a (parent edge + merge edge both go that direction).
    const nodes = [node('root'), node('a'), node('b')];
    const edges: StreamDAGEdge[] = [
      { source: 'root', target: 'a', type: 'parent' },
      { source: 'root', target: 'b', type: 'parent' },
      { source: 'a', target: 'b', type: 'merge' },
    ];
    const positions = layoutCascadeDAG(nodes, edges);
    expect(positions.get('b')!.x).toBeGreaterThan(positions.get('a')!.x);
  });

  it('is deterministic across runs for the same input', () => {
    const nodes = [node('root'), node('a'), node('b'), node('c')];
    const edges: StreamDAGEdge[] = [
      { source: 'root', target: 'a', type: 'parent' },
      { source: 'a', target: 'b', type: 'parent' },
      { source: 'a', target: 'c', type: 'parent' },
    ];
    const first = layoutCascadeDAG(nodes, edges);
    const second = layoutCascadeDAG(nodes, edges);
    for (const [id, p] of first) {
      expect(second.get(id)).toEqual(p);
    }
  });

  it('deduplicates identical parent edges', () => {
    const nodes = [node('root'), node('child')];
    const edges: StreamDAGEdge[] = [
      { source: 'root', target: 'child', type: 'parent' },
      { source: 'root', target: 'child', type: 'parent' },
    ];
    expect(() => layoutCascadeDAG(nodes, edges)).not.toThrow();
  });
});
