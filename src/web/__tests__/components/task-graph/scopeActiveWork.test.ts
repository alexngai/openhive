import { describe, it, expect } from 'vitest';
import {
  scopeActiveWork,
  rankingEndpoints,
} from '../../../components/task-graph/layout/scopeActiveWork';
import type { OpenTasksGraphNode, OpenTasksGraphEdge } from '../../../lib/api';

function task(
  id: string,
  status = 'open',
  overrides: Partial<OpenTasksGraphNode> = {},
): OpenTasksGraphNode {
  return { id, type: 'task', title: id, status, ...overrides };
}

function edge(from: string, to: string, type: string): OpenTasksGraphEdge {
  return { id: `${from}->${to}:${type}`, from_id: from, to_id: to, type };
}

describe('rankingEndpoints', () => {
  it('maps blocks A→B to parent A, child B', () => {
    expect(rankingEndpoints(edge('A', 'B', 'blocks'))).toEqual({
      parent: 'A',
      child: 'B',
    });
  });

  it('reverses depends-on A→B to parent B, child A (B is the prereq)', () => {
    expect(rankingEndpoints(edge('A', 'B', 'depends-on'))).toEqual({
      parent: 'B',
      child: 'A',
    });
  });

  it('reverses subtask-of A→B to parent B, child A (B is the container)', () => {
    expect(rankingEndpoints(edge('A', 'B', 'subtask-of'))).toEqual({
      parent: 'B',
      child: 'A',
    });
  });

  it('maps parent-of A→B to parent A, child B', () => {
    expect(rankingEndpoints(edge('A', 'B', 'parent-of'))).toEqual({
      parent: 'A',
      child: 'B',
    });
  });

  it('reverses child-of A→B to parent B, child A', () => {
    expect(rankingEndpoints(edge('A', 'B', 'child-of'))).toEqual({
      parent: 'B',
      child: 'A',
    });
  });

  it('returns null for decoration edge types', () => {
    expect(rankingEndpoints(edge('A', 'B', 'related'))).toBeNull();
    expect(rankingEndpoints(edge('A', 'B', 'unknown'))).toBeNull();
  });
});

describe('scopeActiveWork', () => {
  it('keeps active tasks and drops completed/failed by default', () => {
    const nodes = [
      task('A', 'in_progress'),
      task('B', 'completed'),
      task('C', 'blocked'),
      task('D', 'failed'),
      task('E', 'open'),
    ];
    const res = scopeActiveWork(nodes, []);
    expect(res.nodes.map((n) => n.id).sort()).toEqual(['A', 'C', 'E']);
  });

  it('drops archived tasks even if otherwise active', () => {
    const nodes = [
      task('A', 'in_progress'),
      task('B', 'in_progress', { archived: true }),
    ];
    expect(scopeActiveWork(nodes, []).nodes.map((n) => n.id)).toEqual(['A']);
  });

  it('drops non-task types by default', () => {
    const nodes = [
      task('A', 'open'),
      { id: 'N', type: 'note', title: 'note', status: 'open' } as OpenTasksGraphNode,
      { id: 'C', type: 'context', title: 'ctx' } as OpenTasksGraphNode,
    ];
    expect(scopeActiveWork(nodes, []).nodes.map((n) => n.id)).toEqual(['A']);
  });

  it('includes non-task types when includeAuxTypes is set', () => {
    const nodes = [
      task('A', 'open'),
      { id: 'N', type: 'note', title: 'note', status: 'open' } as OpenTasksGraphNode,
    ];
    const res = scopeActiveWork(nodes, [], { includeAuxTypes: true });
    expect(res.nodes.map((n) => n.id).sort()).toEqual(['A', 'N']);
  });

  it('pulls in upstream blockers via depends-on regardless of status', () => {
    // A depends-on B (B is parent). A is active, B is completed.
    // Scope should include both, because B is the upstream blocker of A.
    const nodes = [task('A', 'in_progress'), task('B', 'completed')];
    const edges = [edge('A', 'B', 'depends-on')];
    const res = scopeActiveWork(nodes, edges);
    expect(res.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
  });

  it('pulls in upstream blockers via blocks regardless of status', () => {
    // A blocks B (A is parent). B is active, A is completed.
    const nodes = [task('A', 'completed'), task('B', 'in_progress')];
    const edges = [edge('A', 'B', 'blocks')];
    const res = scopeActiveWork(nodes, edges);
    expect(res.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
  });

  it('walks the upstream chain multiple hops', () => {
    // C depends-on B depends-on A; only C is active. All three should appear.
    const nodes = [
      task('A', 'completed'),
      task('B', 'completed'),
      task('C', 'in_progress'),
    ];
    const edges = [
      edge('C', 'B', 'depends-on'),
      edge('B', 'A', 'depends-on'),
    ];
    expect(scopeActiveWork(nodes, edges).nodes.map((n) => n.id).sort()).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('does NOT pull in downstream consumers of an active node', () => {
    // A depends-on B (B is parent). B is active, A is completed.
    // A is downstream of B (consumer). Scope should not include A.
    const nodes = [task('A', 'completed'), task('B', 'in_progress')];
    const edges = [edge('A', 'B', 'depends-on')];
    const res = scopeActiveWork(nodes, edges);
    expect(res.nodes.map((n) => n.id).sort()).toEqual(['B']);
  });

  it('keeps edges only when both endpoints survive', () => {
    const nodes = [
      task('A', 'in_progress'),
      task('B', 'completed'), // dropped
    ];
    // A→B is a `related` edge (decoration). B is not in scope, so the edge
    // should not survive.
    const edges = [edge('A', 'B', 'related')];
    const res = scopeActiveWork(nodes, edges);
    expect(res.nodes.map((n) => n.id)).toEqual(['A']);
    expect(res.edges).toEqual([]);
  });

  it('includeTerminal=true keeps completed/failed even without being ancestors', () => {
    const nodes = [
      task('A', 'in_progress'),
      task('B', 'completed'),
      task('C', 'failed'),
    ];
    const res = scopeActiveWork(nodes, [], { includeTerminal: true });
    expect(res.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('returns no nodes when nothing is active and includeTerminal is false', () => {
    const nodes = [task('A', 'completed'), task('B', 'failed')];
    expect(scopeActiveWork(nodes, []).nodes).toEqual([]);
  });

  it('is stable across runs for the same input', () => {
    const nodes = [
      task('A', 'in_progress'),
      task('B', 'completed'),
      task('C', 'blocked'),
    ];
    const edges = [edge('C', 'B', 'depends-on'), edge('A', 'B', 'depends-on')];
    const first = scopeActiveWork(nodes, edges);
    const second = scopeActiveWork(nodes, edges);
    expect(first.nodes.map((n) => n.id)).toEqual(second.nodes.map((n) => n.id));
    expect(first.edges).toEqual(second.edges);
  });
});
