/**
 * Hierarchy view count math — pure derivations from the scope + cluster
 * pipeline. The pre-refactor inline JSX mixed pre-cluster `scoped.nodes`
 * with post-cluster `clustered.nodes`, so "N in view" + "N upstream" could
 * over-count. These tests pin the contract: both numbers reflect what's
 * actually on screen, cluster placeholders never count as upstream.
 */

import { describe, it, expect } from 'vitest';
import {
  summarizeHierarchyView,
  formatHierarchySummarySuffix,
} from '../../../components/task-graph/layout/viewSummary';
import { CLUSTER_NODE_TYPE } from '../../../components/task-graph/layout/leafClustering';
import type { OpenTasksGraphNode } from '../../../lib/api';

function task(id: string, status = 'open'): OpenTasksGraphNode {
  return { id, type: 'task', title: id, status };
}

function cluster(id: string): OpenTasksGraphNode {
  return { id, type: CLUSTER_NODE_TYPE, title: `+N more`, status: 'open' };
}

describe('summarizeHierarchyView', () => {
  it('reports zero counts when nothing is in view', () => {
    expect(summarizeHierarchyView([], { size: 0 }, new Set())).toEqual({
      inView: 0,
      upstream: 0,
      clusters: 0,
    });
  });

  it('counts seed-only nodes as inView, never upstream', () => {
    const nodes = [task('A'), task('B'), task('C')];
    const seedIds = new Set(['A', 'B', 'C']);
    expect(summarizeHierarchyView(nodes, { size: 0 }, seedIds)).toEqual({
      inView: 3,
      upstream: 0,
      clusters: 0,
    });
  });

  it('counts ancestor-only nodes as upstream', () => {
    // A + B are seeds; X + Y are ancestors pulled in by scopeActiveWork.
    const nodes = [task('A'), task('B'), task('X'), task('Y')];
    const seedIds = new Set(['A', 'B']);
    expect(summarizeHierarchyView(nodes, { size: 0 }, seedIds)).toEqual({
      inView: 4,
      upstream: 2,
      clusters: 0,
    });
  });

  it('excludes cluster placeholders from the upstream count', () => {
    // A is a seed, X is an ancestor, K is a synthetic cluster placeholder
    // that replaced 7 leaves under A. K must not be counted as upstream
    // even though it's not in seedIds.
    const nodes = [task('A'), task('X'), cluster('leaf-cluster:A')];
    const seedIds = new Set(['A']);
    expect(summarizeHierarchyView(nodes, { size: 1 }, seedIds)).toEqual({
      inView: 3,
      upstream: 1, // X only, not the cluster
      clusters: 1,
    });
  });

  it('passes through cluster size from the input map', () => {
    const nodes = [task('A')];
    expect(summarizeHierarchyView(nodes, { size: 3 }, new Set(['A']))).toEqual({
      inView: 1,
      upstream: 0,
      clusters: 3,
    });
  });

  it('accepts a Map for clusters as well as the {size} shape', () => {
    const clusters = new Map<string, string[]>([
      ['leaf-cluster:A', ['l1', 'l2']],
      ['leaf-cluster:B', ['l3', 'l4', 'l5']],
    ]);
    const nodes = [task('A')];
    expect(summarizeHierarchyView(nodes, clusters, new Set(['A']))).toEqual({
      inView: 1,
      upstream: 0,
      clusters: 2,
    });
  });
});

describe('formatHierarchySummarySuffix', () => {
  it('returns empty string when there are no extras', () => {
    expect(
      formatHierarchySummarySuffix({ inView: 5, upstream: 0, clusters: 0 }),
    ).toBe('');
  });

  it('renders upstream count when nonzero', () => {
    expect(
      formatHierarchySummarySuffix({ inView: 5, upstream: 2, clusters: 0 }),
    ).toBe(' · 2 upstream');
  });

  it('renders cluster count when nonzero, with correct pluralization', () => {
    expect(
      formatHierarchySummarySuffix({ inView: 5, upstream: 0, clusters: 1 }),
    ).toBe(' · 1 cluster');
    expect(
      formatHierarchySummarySuffix({ inView: 5, upstream: 0, clusters: 3 }),
    ).toBe(' · 3 clusters');
  });

  it('combines upstream and cluster parts with " · "', () => {
    expect(
      formatHierarchySummarySuffix({ inView: 5, upstream: 2, clusters: 1 }),
    ).toBe(' · 2 upstream · 1 cluster');
    expect(
      formatHierarchySummarySuffix({ inView: 10, upstream: 4, clusters: 2 }),
    ).toBe(' · 4 upstream · 2 clusters');
  });
});
