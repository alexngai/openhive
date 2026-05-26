import { describe, it, expect } from 'vitest';
import {
  clusterLeaves,
  CLUSTER_NODE_TYPE,
} from '../../../components/task-graph/layout/leafClustering';
import type { OpenTasksGraphNode, OpenTasksGraphEdge } from '../../../lib/api';

function task(
  id: string,
  overrides: Partial<OpenTasksGraphNode> = {},
): OpenTasksGraphNode {
  return { id, type: 'task', title: id, status: 'open', ...overrides };
}

function edge(from: string, to: string, type: string): OpenTasksGraphEdge {
  return { id: `${from}->${to}:${type}`, from_id: from, to_id: to, type };
}

describe('clusterLeaves', () => {
  it('does nothing when fan-out is under threshold', () => {
    const nodes = [task('P'), task('A'), task('B'), task('C'), task('D')];
    const edges = [
      edge('A', 'P', 'subtask-of'),
      edge('B', 'P', 'subtask-of'),
      edge('C', 'P', 'subtask-of'),
      edge('D', 'P', 'subtask-of'),
    ];
    const res = clusterLeaves(nodes, edges, { threshold: 5 });
    expect(res.nodes.length).toBe(5);
    expect(res.clusters.size).toBe(0);
  });

  it('collapses 6+ leaf children of one parent into one cluster node', () => {
    const nodes = [
      task('P'),
      task('A'),
      task('B'),
      task('C'),
      task('D'),
      task('E'),
      task('F'),
    ];
    const edges = [
      edge('A', 'P', 'subtask-of'),
      edge('B', 'P', 'subtask-of'),
      edge('C', 'P', 'subtask-of'),
      edge('D', 'P', 'subtask-of'),
      edge('E', 'P', 'subtask-of'),
      edge('F', 'P', 'subtask-of'),
    ];
    const res = clusterLeaves(nodes, edges, { threshold: 5 });
    // P + cluster node
    expect(res.nodes.length).toBe(2);
    expect(res.clusters.size).toBe(1);
    const cluster = res.nodes.find((n) => n.type === CLUSTER_NODE_TYPE);
    expect(cluster).toBeDefined();
    expect(cluster!.title).toBe('+6 more');
    const clusterId = cluster!.id;
    expect(res.clusters.get(clusterId)?.sort()).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
    ]);
  });

  it('does NOT cluster leaves of different parents', () => {
    // Two parents, each with 3 leaves — neither parent crosses threshold 5.
    const nodes = [
      task('P1'),
      task('P2'),
      task('A'),
      task('B'),
      task('C'),
      task('D'),
      task('E'),
      task('F'),
    ];
    const edges = [
      edge('A', 'P1', 'subtask-of'),
      edge('B', 'P1', 'subtask-of'),
      edge('C', 'P1', 'subtask-of'),
      edge('D', 'P2', 'subtask-of'),
      edge('E', 'P2', 'subtask-of'),
      edge('F', 'P2', 'subtask-of'),
    ];
    const res = clusterLeaves(nodes, edges, { threshold: 5 });
    expect(res.nodes.length).toBe(8);
    expect(res.clusters.size).toBe(0);
  });

  it('skips a cluster the user has expanded', () => {
    const nodes = [
      task('P'),
      task('A'),
      task('B'),
      task('C'),
      task('D'),
      task('E'),
      task('F'),
    ];
    const edges = [
      edge('A', 'P', 'subtask-of'),
      edge('B', 'P', 'subtask-of'),
      edge('C', 'P', 'subtask-of'),
      edge('D', 'P', 'subtask-of'),
      edge('E', 'P', 'subtask-of'),
      edge('F', 'P', 'subtask-of'),
    ];
    const expanded = new Set([`${CLUSTER_NODE_TYPE}:P`]);
    const res = clusterLeaves(nodes, edges, { threshold: 5, expanded });
    expect(res.nodes.length).toBe(7);
    expect(res.clusters.size).toBe(0);
  });

  it('does NOT collapse non-leaf children (children with their own children)', () => {
    // P has 5 children A-E; A has its own child X. A is not a leaf.
    const nodes = [
      task('P'),
      task('A'),
      task('B'),
      task('C'),
      task('D'),
      task('E'),
      task('X'),
    ];
    const edges = [
      edge('A', 'P', 'subtask-of'),
      edge('B', 'P', 'subtask-of'),
      edge('C', 'P', 'subtask-of'),
      edge('D', 'P', 'subtask-of'),
      edge('E', 'P', 'subtask-of'),
      edge('X', 'A', 'subtask-of'),
    ];
    const res = clusterLeaves(nodes, edges, { threshold: 5 });
    // Only B/C/D/E are leaves — 4, below threshold. No cluster.
    expect(res.clusters.size).toBe(0);
    expect(res.nodes.length).toBe(7);
  });

  it('emits a ranking edge from cluster back to its parent', () => {
    const nodes = [task('P'), task('A'), task('B'), task('C'), task('D'), task('E')];
    const edges = [
      edge('A', 'P', 'subtask-of'),
      edge('B', 'P', 'subtask-of'),
      edge('C', 'P', 'subtask-of'),
      edge('D', 'P', 'subtask-of'),
      edge('E', 'P', 'subtask-of'),
    ];
    const res = clusterLeaves(nodes, edges, { threshold: 5 });
    const clusterEdge = res.edges.find((e) =>
      e.from_id.startsWith(CLUSTER_NODE_TYPE) || e.to_id.startsWith(CLUSTER_NODE_TYPE),
    );
    expect(clusterEdge).toBeDefined();
    // subtask-of stores from=child, to=parent
    expect(clusterEdge!.type).toBe('subtask-of');
    expect(clusterEdge!.to_id).toBe('P');
  });

  it('preserves dominant child status on the cluster node', () => {
    const nodes = [
      task('P'),
      task('A', { status: 'completed' }),
      task('B', { status: 'completed' }),
      task('C', { status: 'completed' }),
      task('D', { status: 'open' }),
      task('E', { status: 'in_progress' }),
    ];
    const edges = [
      edge('A', 'P', 'subtask-of'),
      edge('B', 'P', 'subtask-of'),
      edge('C', 'P', 'subtask-of'),
      edge('D', 'P', 'subtask-of'),
      edge('E', 'P', 'subtask-of'),
    ];
    const res = clusterLeaves(nodes, edges, { threshold: 5 });
    const cluster = res.nodes.find((n) => n.type === CLUSTER_NODE_TYPE);
    expect(cluster?.status).toBe('completed');
  });
});
