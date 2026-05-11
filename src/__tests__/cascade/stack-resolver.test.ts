/**
 * Stack-linearity walker tests.
 *
 * Real cascade_streams + cascade_changes rows so we exercise the actual
 * parent_stream_id/child queries. Each test builds a small DAG, runs the
 * walker, and asserts shape + error.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { upsertStream, recordCommit, updateStreamStatus } from '../../db/dal/cascade-streams.js';
import {
  resolveLinearStack,
  NonLinearStackError,
  StackNotFoundError,
  StackHasNoBaseError,
  StackHasNoCommitsError,
} from '../../cascade/stack-resolver.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('stack-resolver');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'stack-resolver.db');
const SWARM = 'swarm-stack';

interface StreamSpec {
  stream_id: string;
  parent?: string;
  base?: string;
  commits?: Array<{ hash: string; ts?: string }>;
  status?: 'active' | 'merged' | 'abandoned' | 'conflicted';
}

function seed(specs: StreamSpec[]): Map<string, string> {
  const rowByStream = new Map<string, string>();
  for (const spec of specs) {
    const { stream } = upsertStream({
      stream_id: spec.stream_id,
      source_swarm_id: SWARM,
      source_agent_id: 'agent',
      name: spec.stream_id,
      base_commit: spec.base ?? null,
      parent_stream_id: spec.parent,
    });
    rowByStream.set(spec.stream_id, stream.id);

    for (const c of spec.commits ?? []) {
      recordCommit({
        stream_row_id: stream.id,
        commit_hash: c.hash,
      });
      if (c.ts) {
        getDatabase()
          .prepare('UPDATE cascade_changes SET synced_at = ? WHERE commit_hash = ? AND stream_row_id = ?')
          .run(c.ts, c.hash, stream.id);
      }
    }

    if (spec.status) updateStreamStatus(stream.id, spec.status);
  }
  return rowByStream;
}

describe('stack-resolver', () => {
  beforeAll(() => initDatabase(TEST_DB_PATH));
  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });
  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM cascade_changes').run();
    db.prepare('DELETE FROM cascade_streams').run();
  });

  describe('linear chains', () => {
    it('walks a single-stream stack (root only)', () => {
      const rows = seed([
        { stream_id: 's-root', base: 'base-A', commits: [{ hash: 'h-1' }] },
      ]);
      const r = resolveLinearStack(rows.get('s-root')!);
      expect(r.entries).toHaveLength(1);
      expect(r.lowest_base).toBe('base-A');
      expect(r.highest_head).toBe('h-1');
      expect(r.root.cascade_stream_id).toBe('s-root');
      expect(r.leaf.cascade_stream_id).toBe('s-root');
    });

    it('walks a 3-stream linear stack root → mid → leaf', () => {
      const rows = seed([
        { stream_id: 'A', base: 'base-A', commits: [{ hash: 'A1' }, { hash: 'A2', ts: '2099-01-01 00:00:00' }] },
        { stream_id: 'B', parent: 'A', base: 'A2', commits: [{ hash: 'B1' }] },
        { stream_id: 'C', parent: 'B', base: 'B1', commits: [{ hash: 'C1' }, { hash: 'C2', ts: '2099-01-01 00:00:00' }] },
      ]);
      const r = resolveLinearStack(rows.get('A')!);
      expect(r.entries.map((e) => e.cascade_stream_id)).toEqual(['A', 'B', 'C']);
      expect(r.lowest_base).toBe('base-A');
      // C2 is the more recently synced commit on C
      expect(r.highest_head).toBe('C2');
      expect(r.root.cascade_stream_id).toBe('A');
      expect(r.leaf.cascade_stream_id).toBe('C');
    });
  });

  describe('active-subset linearity (D2)', () => {
    it('skips a merged sibling and walks the active child', () => {
      const rows = seed([
        { stream_id: 'A', base: 'base-A', commits: [{ hash: 'A1' }] },
        { stream_id: 'B-merged', parent: 'A', base: 'A1', commits: [{ hash: 'BM1' }], status: 'merged' },
        { stream_id: 'B-active', parent: 'A', base: 'A1', commits: [{ hash: 'BA1' }] },
      ]);
      const r = resolveLinearStack(rows.get('A')!);
      expect(r.entries.map((e) => e.cascade_stream_id)).toEqual(['A', 'B-active']);
      expect(r.highest_head).toBe('BA1');
    });

    it('skips an abandoned sibling', () => {
      const rows = seed([
        { stream_id: 'A', base: 'base-A', commits: [{ hash: 'A1' }] },
        { stream_id: 'B-abandoned', parent: 'A', base: 'A1', commits: [{ hash: 'BA1' }], status: 'abandoned' },
        { stream_id: 'B-active', parent: 'A', base: 'A1', commits: [{ hash: 'BB1' }] },
      ]);
      const r = resolveLinearStack(rows.get('A')!);
      expect(r.entries.map((e) => e.cascade_stream_id)).toEqual(['A', 'B-active']);
    });

    it('does NOT skip conflicted streams — they are still active', () => {
      const rows = seed([
        { stream_id: 'A', base: 'base-A', commits: [{ hash: 'A1' }] },
        { stream_id: 'B', parent: 'A', base: 'A1', commits: [{ hash: 'B1' }], status: 'conflicted' },
      ]);
      const r = resolveLinearStack(rows.get('A')!);
      expect(r.entries.map((e) => e.cascade_stream_id)).toEqual(['A', 'B']);
    });
  });

  describe('rejection', () => {
    it('throws NonLinearStackError when two active children fork the stack', () => {
      const rows = seed([
        { stream_id: 'A', base: 'base-A', commits: [{ hash: 'A1' }] },
        { stream_id: 'B', parent: 'A', base: 'A1', commits: [{ hash: 'B1' }] },
        { stream_id: 'C', parent: 'A', base: 'A1', commits: [{ hash: 'C1' }] },
      ]);
      try {
        resolveLinearStack(rows.get('A')!);
        throw new Error('expected NonLinearStackError');
      } catch (e) {
        expect(e).toBeInstanceOf(NonLinearStackError);
        const branching = (e as NonLinearStackError).branching;
        expect(branching.cascade_stream_id).toBe('A');
        expect(branching.active_children.map((c) => c.cascade_stream_id).sort()).toEqual(['B', 'C']);
      }
    });

    it('throws StackNotFoundError when root row_id is unknown', () => {
      expect(() => resolveLinearStack('does-not-exist')).toThrow(StackNotFoundError);
    });

    it('throws StackHasNoBaseError when root has no base_commit', () => {
      const rows = seed([
        { stream_id: 'A', commits: [{ hash: 'A1' }] }, // no base
      ]);
      expect(() => resolveLinearStack(rows.get('A')!)).toThrow(StackHasNoBaseError);
    });

    it('throws StackHasNoCommitsError when leaf has no commits', () => {
      const rows = seed([
        { stream_id: 'A', base: 'base-A', commits: [{ hash: 'A1' }] },
        { stream_id: 'B', parent: 'A', base: 'A1' }, // no commits on leaf
      ]);
      expect(() => resolveLinearStack(rows.get('A')!)).toThrow(StackHasNoCommitsError);
    });
  });
});
