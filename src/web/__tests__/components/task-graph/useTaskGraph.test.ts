/**
 * Tests for buildGraphologyGraph() and related utilities
 * from src/web/components/task-graph/useTaskGraph.ts.
 */

import { describe, it, expect } from 'vitest';
import { buildGraphologyGraph, STATUS_COLORS } from '../../../components/task-graph/useTaskGraph';
import type { OpenTasksGraphNode, OpenTasksGraphEdge } from '../../../lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<OpenTasksGraphNode> & { id: string }): OpenTasksGraphNode {
  return {
    type: 'task',
    status: 'open',
    ...overrides,
  } as OpenTasksGraphNode;
}

function makeEdge(from_id: string, to_id: string, type = 'blocks'): OpenTasksGraphEdge {
  return { id: `e-${from_id}-${to_id}`, from_id, to_id, type };
}

// ---------------------------------------------------------------------------
// buildGraphologyGraph
// ---------------------------------------------------------------------------

describe('buildGraphologyGraph', () => {
  it('builds a graph with the correct node count (filters archived)', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 't-1', title: 'Active task' }),
      makeNode({ id: 't-2', title: 'Another task' }),
      makeNode({ id: 't-3', title: 'Archived task', archived: true }),
    ];

    const graph = buildGraphologyGraph(nodes, []);

    expect(graph.order).toBe(2); // t-1, t-2 only
    expect(graph.hasNode('t-1')).toBe(true);
    expect(graph.hasNode('t-2')).toBe(true);
    expect(graph.hasNode('t-3')).toBe(false);
  });

  it('assigns correct renderer type based on node type', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 't-1', type: 'task' }),
      makeNode({ id: 'c-1', type: 'context' }),
      makeNode({ id: 'm-1', type: 'milestone' }),
      makeNode({ id: 'f-1', type: 'feedback' }),
    ];

    const graph = buildGraphologyGraph(nodes, []);

    expect(graph.getNodeAttribute('t-1', 'type')).toBe('circle');
    expect(graph.getNodeAttribute('c-1', 'type')).toBe('square');
    expect(graph.getNodeAttribute('m-1', 'type')).toBe('circle');
    expect(graph.getNodeAttribute('f-1', 'type')).toBe('square');
  });

  it('adds edges between existing nodes', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 't-1' }),
      makeNode({ id: 't-2' }),
    ];
    const edges: OpenTasksGraphEdge[] = [
      makeEdge('t-1', 't-2'),
    ];

    const graph = buildGraphologyGraph(nodes, edges);

    expect(graph.size).toBe(1); // 1 edge
    expect(graph.hasEdge('t-1', 't-2')).toBe(true);
  });

  it('skips edges referencing non-existent nodes', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 't-1' }),
    ];
    const edges: OpenTasksGraphEdge[] = [
      makeEdge('t-1', 't-missing'), // t-missing doesn't exist
      makeEdge('t-ghost', 't-1'),   // t-ghost doesn't exist
    ];

    const graph = buildGraphologyGraph(nodes, edges);

    expect(graph.size).toBe(0); // no edges added
  });

  it('skips edges where from node is archived', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 't-1', archived: true }),
      makeNode({ id: 't-2' }),
    ];
    const edges: OpenTasksGraphEdge[] = [
      makeEdge('t-1', 't-2'),
    ];

    const graph = buildGraphologyGraph(nodes, edges);

    // t-1 was filtered out (archived), so edge should be skipped
    expect(graph.size).toBe(0);
  });

  it('assigns correct status colors', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 't-1', status: 'open' }),
      makeNode({ id: 't-2', status: 'in_progress' }),
      makeNode({ id: 't-3', status: 'completed' }),
      makeNode({ id: 't-4', status: 'blocked' }),
      makeNode({ id: 't-5', status: 'failed' }),
    ];

    const graph = buildGraphologyGraph(nodes, []);

    expect(graph.getNodeAttribute('t-1', 'color')).toBe(STATUS_COLORS.open);
    expect(graph.getNodeAttribute('t-2', 'color')).toBe(STATUS_COLORS.in_progress);
    expect(graph.getNodeAttribute('t-3', 'color')).toBe(STATUS_COLORS.completed);
    expect(graph.getNodeAttribute('t-4', 'color')).toBe(STATUS_COLORS.blocked);
    expect(graph.getNodeAttribute('t-5', 'color')).toBe(STATUS_COLORS.failed);
  });

  it('defaults status to "open" when not specified', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 't-1', status: undefined }),
    ];

    const graph = buildGraphologyGraph(nodes, []);

    expect(graph.getNodeAttribute('t-1', 'color')).toBe(STATUS_COLORS.open);
    expect(graph.getNodeAttribute('t-1', 'status')).toBe('open');
  });

  it('uses deterministic positions (same node ID produces same x,y)', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 't-stable' }),
    ];

    const graph1 = buildGraphologyGraph(nodes, []);
    const graph2 = buildGraphologyGraph(nodes, []);

    expect(graph1.getNodeAttribute('t-stable', 'x')).toBe(
      graph2.getNodeAttribute('t-stable', 'x'),
    );
    expect(graph1.getNodeAttribute('t-stable', 'y')).toBe(
      graph2.getNodeAttribute('t-stable', 'y'),
    );
  });

  it('produces different positions for different node IDs', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 'node-aaa' }),
      makeNode({ id: 'node-zzz' }),
    ];

    const graph = buildGraphologyGraph(nodes, []);

    const xA = graph.getNodeAttribute('node-aaa', 'x');
    const yA = graph.getNodeAttribute('node-aaa', 'y');
    const xZ = graph.getNodeAttribute('node-zzz', 'x');
    const yZ = graph.getNodeAttribute('node-zzz', 'y');

    // At least one coordinate should differ
    expect(xA !== xZ || yA !== yZ).toBe(true);
  });

  it('handles duplicate edges gracefully (no throw)', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 't-1' }),
      makeNode({ id: 't-2' }),
    ];
    const edges: OpenTasksGraphEdge[] = [
      makeEdge('t-1', 't-2'),
      makeEdge('t-1', 't-2'), // duplicate
    ];

    // Should not throw — duplicates are caught internally
    const graph = buildGraphologyGraph(nodes, edges);
    expect(graph.size).toBe(1);
  });

  it('sets edge styling correctly', () => {
    const nodes: OpenTasksGraphNode[] = [
      makeNode({ id: 't-1' }),
      makeNode({ id: 't-2' }),
    ];
    const edges: OpenTasksGraphEdge[] = [
      makeEdge('t-1', 't-2', 'blocks'),
    ];

    const graph = buildGraphologyGraph(nodes, edges);
    const edgeKey = graph.edges()[0];
    const attrs = graph.getEdgeAttributes(edgeKey);

    expect(attrs.type).toBe('arrow');
    expect(attrs.size).toBe(2);
    expect(attrs.color).toBe('#9ca3af');
    expect(attrs.edgeType).toBe('blocks');
  });

  it('stores full node data in _data attribute', () => {
    const node = makeNode({ id: 't-1', title: 'Test task', priority: 3 });
    const graph = buildGraphologyGraph([node], []);

    const data = graph.getNodeAttribute('t-1', '_data');
    expect(data.id).toBe('t-1');
    expect(data.title).toBe('Test task');
    expect(data.priority).toBe(3);
  });

  it('handles empty inputs', () => {
    const graph = buildGraphologyGraph([], []);
    expect(graph.order).toBe(0);
    expect(graph.size).toBe(0);
  });
});
