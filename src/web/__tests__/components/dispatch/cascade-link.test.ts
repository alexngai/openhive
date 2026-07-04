import { describe, it, expect } from 'vitest';
import {
  resolveCascadeStreamRow,
  cascadeStreamDeepLink,
} from '../../../components/dispatch/cascade-link';
import type { StreamDAGNode } from '../../../hooks/useApi';

const node = (over: Partial<StreamDAGNode>): StreamDAGNode => ({
  id: 'row_1',
  stream_id: 'stream_abc',
  source_swarm_id: 'swarm_1',
  source_agent_id: 'agent_1',
  parent_stream_id: null,
  name: 'feature branch',
  status: 'active',
  task_resource_id: null,
  task_node_id: null,
  publish_branch: null,
  opened_at: '',
  last_event_at: '',
  commit_count: 3,
  open_conflict_count: 0,
  ...over,
});

describe('resolveCascadeStreamRow', () => {
  it('matches on `${swarm_id}/${stream_id}`', () => {
    const nodes = [node({}), node({ id: 'row_2', stream_id: 'other' })];
    expect(resolveCascadeStreamRow('swarm_1/stream_abc', nodes)?.id).toBe('row_1');
  });

  it('returns null when no stream matches', () => {
    expect(resolveCascadeStreamRow('swarm_1/missing', [node({})])).toBeNull();
    expect(resolveCascadeStreamRow('swarm_1/stream_abc', [])).toBeNull();
  });
});

describe('cascadeStreamDeepLink', () => {
  it('builds a row-id deep link when resolvable', () => {
    expect(cascadeStreamDeepLink('swarm_1/stream_abc', [node({})])).toBe(
      '/changes?stream=row_1',
    );
  });

  it('is null when the stream is not indexed', () => {
    expect(cascadeStreamDeepLink('swarm_1/stream_abc', [])).toBeNull();
  });
});
