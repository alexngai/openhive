/**
 * Tests for MAP cascade handler: x-cascade/* request handling.
 *
 * Verifies:
 * - stream.opened creates projection row with task_ref extracted from metadata
 * - stream.committed records a change, auto-creates stream if needed, back-fills task_ref
 * - stream.merged creates merge row, marks source stream merged
 * - stream.conflicted records conflict, marks stream conflicted
 * - stream.abandoned marks stream abandoned
 * - All handlers are idempotent on replay
 * - Validation errors return JSON-RPC -32602
 * - Unknown methods return -32601
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  handleCascadeRequest,
  CASCADE_METHODS,
} from '../../map/cascade-handler.js';
import { CascadeRequestError } from '../../map/cascade-types.js';
import {
  getStreamBySwarmAndId,
  listChangesForStream,
  listConflictsForStream,
  listCascadeOperations,
  listPushes,
  listQueueEntries,
  getCommitRangeForTask,
} from '../../db/dal/cascade-streams.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel to silence WS broadcasts in tests.
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_ROOT = testRoot('cascade-handler');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'cascade-handler.db');

describe('Cascade Handler', () => {
  const swarmId = 'swarm-cascade-test-001';
  const agentId = 'cascade-test-agent';

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    await agentsDAL.createAgent({
      name: 'cascade-test-agent',
      description: 'Agent for cascade handler tests',
    });
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('x-cascade/stream.opened', () => {
    it('creates a projection row and extracts task_ref from metadata', () => {
      const result = handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        {
          stream_id: 'abc12345',
          name: 'feature-auth',
          agent_id: 'worker-1',
          base_commit: 'deadbeef',
          branch_name: 'stream/abc12345',
          metadata: {
            task_ref: { resource_id: 'res-tasks', node_id: 'task-auth-root' },
          },
        },
        { swarmId, agentId }
      );

      expect(result.ok).toBe(true);
      expect(result.created).toBe(true);
      expect(result.stream_row_id).toBeTruthy();

      const stream = getStreamBySwarmAndId(swarmId, 'abc12345');
      expect(stream).not.toBeNull();
      expect(stream!.name).toBe('feature-auth');
      expect(stream!.source_agent_id).toBe('worker-1');
      expect(stream!.base_commit).toBe('deadbeef');
      expect(stream!.task_resource_id).toBe('res-tasks');
      expect(stream!.task_node_id).toBe('task-auth-root');
      expect(stream!.status).toBe('active');
    });

    it('is idempotent on replay (same stream_id)', () => {
      const first = handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'dup-1', name: 'x', agent_id: 'a1' },
        { swarmId, agentId }
      );
      const second = handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'dup-1', name: 'x', agent_id: 'a1' },
        { swarmId, agentId }
      );
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.stream_row_id).toBe(first.stream_row_id);
    });

    it('rejects missing stream_id with -32602', () => {
      expect(() =>
        handleCascadeRequest(
          CASCADE_METHODS.STREAM_OPENED,
          { name: 'x', agent_id: 'a' },
          { swarmId, agentId }
        )
      ).toThrow(CascadeRequestError);
    });
  });

  describe('x-cascade/stream.committed', () => {
    it('records a change and auto-creates the stream if unseen', () => {
      const result = handleCascadeRequest(
        CASCADE_METHODS.STREAM_COMMITTED,
        {
          stream_id: 'commit-stream-1',
          commit_hash: 'c1',
          change_id: 'chg-1',
          agent_id: 'worker-2',
          message_summary: 'feat: thing',
          files_touched: ['src/a.ts', 'src/b.ts'],
          parent_commit: 'c0',
        },
        { swarmId, agentId }
      );

      expect(result.ok).toBe(true);
      expect(result.created).toBe(true);

      const stream = getStreamBySwarmAndId(swarmId, 'commit-stream-1');
      expect(stream).not.toBeNull();
      const changes = listChangesForStream(stream!.id);
      expect(changes).toHaveLength(1);
      expect(changes[0].commit_hash).toBe('c1');
      expect(changes[0].change_id).toBe('chg-1');
      expect(changes[0].files_touched).toEqual(['src/a.ts', 'src/b.ts']);
      expect(changes[0].message_summary).toBe('feat: thing');
    });

    it('is idempotent on duplicate (stream_id, commit_hash)', () => {
      const payload = {
        stream_id: 'commit-stream-2',
        commit_hash: 'c1',
        change_id: 'chg-x',
        agent_id: 'worker-2',
        message_summary: 'feat: x',
        files_touched: ['a.ts'],
        parent_commit: 'c0',
      };
      const first = handleCascadeRequest(CASCADE_METHODS.STREAM_COMMITTED, payload, {
        swarmId,
        agentId,
      });
      const second = handleCascadeRequest(CASCADE_METHODS.STREAM_COMMITTED, payload, {
        swarmId,
        agentId,
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);

      const stream = getStreamBySwarmAndId(swarmId, 'commit-stream-2');
      const changes = listChangesForStream(stream!.id);
      expect(changes).toHaveLength(1);
    });

    it('back-fills stream task_ref from first committed event carrying it', () => {
      // Open a stream without task_ref
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'late-ref', name: 'late', agent_id: 'w' },
        { swarmId, agentId }
      );

      const before = getStreamBySwarmAndId(swarmId, 'late-ref');
      expect(before!.task_resource_id).toBeNull();

      // Commit with task_ref
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_COMMITTED,
        {
          stream_id: 'late-ref',
          commit_hash: 'lr-c1',
          change_id: 'lr-chg',
          agent_id: 'w',
          message_summary: 'commit',
          files_touched: [],
          parent_commit: 'base',
          metadata: {
            task_ref: { resource_id: 'res-late', node_id: 'node-late' },
          },
        },
        { swarmId, agentId }
      );

      const after = getStreamBySwarmAndId(swarmId, 'late-ref');
      expect(after!.task_resource_id).toBe('res-late');
      expect(after!.task_node_id).toBe('node-late');
    });
  });

  describe('x-cascade/stream.merged', () => {
    it('creates a merge row and marks the source stream merged', () => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'src-1', name: 'src', agent_id: 'a' },
        { swarmId, agentId }
      );
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'tgt-1', name: 'tgt', agent_id: 'a' },
        { swarmId, agentId }
      );

      const result = handleCascadeRequest(
        CASCADE_METHODS.STREAM_MERGED,
        {
          source_stream_id: 'src-1',
          target_stream_id: 'tgt-1',
          merge_commit: 'merge-c1',
          agent_id: 'a',
          strategy: 'merge-commit',
          source_commit: 'src-head',
        },
        { swarmId, agentId }
      );

      expect(result.ok).toBe(true);
      expect(result.created).toBe(true);

      const source = getStreamBySwarmAndId(swarmId, 'src-1');
      expect(source!.status).toBe('merged');
      expect(source!.closed_at).not.toBeNull();
    });

    it('handles worker-branch sources (task-merge strategy) without creating a source stream projection', () => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'integration-1', name: 'int', agent_id: 'a' },
        { swarmId, agentId }
      );

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_MERGED,
        {
          source_stream_id: 'worker/agent-a/wt-123',
          target_stream_id: 'integration-1',
          merge_commit: 'task-merge-c1',
          agent_id: 'a',
          strategy: 'task-merge',
          metadata: { task_id: 'wt-123', task_title: 'Do thing' },
        },
        { swarmId, agentId }
      );

      // Source (worker branch) should NOT have a projection row.
      const workerStream = getStreamBySwarmAndId(swarmId, 'worker/agent-a/wt-123');
      expect(workerStream).toBeNull();

      // Target should still exist.
      const target = getStreamBySwarmAndId(swarmId, 'integration-1');
      expect(target).not.toBeNull();
    });
  });

  describe('x-cascade/stream.conflicted', () => {
    it('records a conflict and marks the stream conflicted', () => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'conf-1', name: 'c', agent_id: 'a' },
        { swarmId, agentId }
      );

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_CONFLICTED,
        {
          stream_id: 'conf-1',
          conflict_id: 'cf-abc',
          conflicted_files: ['a.ts', 'b.ts'],
          agent_id: 'a',
          source: 'sync',
        },
        { swarmId, agentId }
      );

      const stream = getStreamBySwarmAndId(swarmId, 'conf-1');
      expect(stream!.status).toBe('conflicted');
      const conflicts = listConflictsForStream(stream!.id);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].conflicted_files).toEqual(['a.ts', 'b.ts']);
      expect(conflicts[0].source).toBe('sync');
    });

    it('is idempotent on (stream, conflict_id) when conflict_id is provided', () => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'conf-dup', name: 'cd', agent_id: 'a' },
        { swarmId, agentId }
      );
      const stream = getStreamBySwarmAndId(swarmId, 'conf-dup');

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_CONFLICTED,
        {
          stream_id: 'conf-dup',
          conflict_id: 'cf-same',
          conflicted_files: ['x.ts'],
        },
        { swarmId, agentId }
      );
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_CONFLICTED,
        {
          stream_id: 'conf-dup',
          conflict_id: 'cf-same',
          conflicted_files: ['x.ts'],
        },
        { swarmId, agentId }
      );

      expect(listConflictsForStream(stream!.id)).toHaveLength(1);
    });
  });

  describe('x-cascade/stream.abandoned', () => {
    it('marks the stream abandoned and sets closed_at', () => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'abd-1', name: 'a', agent_id: 'a' },
        { swarmId, agentId }
      );

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_ABANDONED,
        { stream_id: 'abd-1', reason: 'superseded' },
        { swarmId, agentId }
      );

      const stream = getStreamBySwarmAndId(swarmId, 'abd-1');
      expect(stream!.status).toBe('abandoned');
      expect(stream!.closed_at).not.toBeNull();
    });
  });

  describe('task ↔ commit range join', () => {
    it('getCommitRangeForTask returns commits from all streams bound to a task', () => {
      const taskRef = { resource_id: 'res-join', node_id: 'node-join' };

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'join-1', name: 'j1', agent_id: 'a', metadata: { task_ref: taskRef } },
        { swarmId, agentId }
      );
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_COMMITTED,
        {
          stream_id: 'join-1',
          commit_hash: 'j1-c1',
          change_id: 'chg-j1-1',
          agent_id: 'a',
          message_summary: 'first',
          files_touched: ['f1.ts'],
          parent_commit: 'base',
          metadata: { task_ref: taskRef },
        },
        { swarmId, agentId }
      );
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_COMMITTED,
        {
          stream_id: 'join-1',
          commit_hash: 'j1-c2',
          change_id: 'chg-j1-2',
          agent_id: 'a',
          message_summary: 'second',
          files_touched: ['f2.ts'],
          parent_commit: 'j1-c1',
          metadata: { task_ref: taskRef },
        },
        { swarmId, agentId }
      );

      const ranges = getCommitRangeForTask('res-join', 'node-join');
      expect(ranges).toHaveLength(1);
      expect(ranges[0].stream_id).toBe('join-1');
      expect(ranges[0].first_commit).toBe('j1-c1');
      expect(ranges[0].last_commit).toBe('j1-c2');
      expect(ranges[0].change_ids).toEqual(['chg-j1-1', 'chg-j1-2']);
      expect(ranges[0].files_union.sort()).toEqual(['f1.ts', 'f2.ts']);
      expect(ranges[0].commits).toHaveLength(2);
    });
  });

  describe('x-cascade/cascade.rebased', () => {
    it('records each new commit against the dependent stream', () => {
      // Seed the dependent stream first.
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'rebased-child', name: 'rc', agent_id: 'b' },
        { swarmId, agentId }
      );

      handleCascadeRequest(
        CASCADE_METHODS.CASCADE_REBASED,
        {
          stream_id: 'rebased-child',
          agent_id: 'a',
          triggered_by_stream_id: 'root-parent',
          triggered_by_agent_id: 'a',
          new_base_commit: 'nb',
          new_head: 'nh',
          new_commits: [
            {
              commit_hash: 'rc-new-1',
              change_id: 'chg-reb-1',
              parent_commit: 'nb',
              message_summary: 'rebased first',
              files_touched: ['x.ts'],
            },
            {
              commit_hash: 'rc-new-2',
              change_id: 'chg-reb-2',
              parent_commit: 'rc-new-1',
              message_summary: 'rebased second',
              files_touched: ['y.ts'],
            },
          ],
        },
        { swarmId, agentId }
      );

      const stream = getStreamBySwarmAndId(swarmId, 'rebased-child');
      const changes = listChangesForStream(stream!.id);
      expect(changes).toHaveLength(2);
      expect(changes.map((c) => c.commit_hash)).toEqual(['rc-new-1', 'rc-new-2']);
      expect(changes[0].change_id).toBe('chg-reb-1');
      expect(changes[0].metadata).toMatchObject({
        cascade_rebased_from: 'root-parent',
        cascade_triggered_by_agent: 'a',
      });
    });

    it('is idempotent when the same cascade.rebased event is replayed', () => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'rebased-dup', name: 'rd', agent_id: 'b' },
        { swarmId, agentId }
      );
      const payload = {
        stream_id: 'rebased-dup',
        agent_id: 'a',
        triggered_by_stream_id: 'root',
        new_base_commit: 'nb',
        new_head: 'nh',
        new_commits: [
          {
            commit_hash: 'rd-c1',
            change_id: 'chg',
            parent_commit: 'nb',
            message_summary: 'once',
            files_touched: [],
          },
        ],
      };
      handleCascadeRequest(CASCADE_METHODS.CASCADE_REBASED, payload, {
        swarmId,
        agentId,
      });
      handleCascadeRequest(CASCADE_METHODS.CASCADE_REBASED, payload, {
        swarmId,
        agentId,
      });

      const stream = getStreamBySwarmAndId(swarmId, 'rebased-dup');
      expect(listChangesForStream(stream!.id)).toHaveLength(1);
    });
  });

  describe('x-cascade/cascade.completed', () => {
    it('accepts summary payloads and returns ok even when root is unknown to the hub', () => {
      const result = handleCascadeRequest(
        CASCADE_METHODS.CASCADE_COMPLETED,
        {
          root_stream_id: 'never-seen-root',
          agent_id: 'a',
          strategy: 'stop_on_conflict',
          updated_streams: ['dep-1', 'dep-2'],
          failed_streams: [],
          skipped_streams: [],
        },
        { swarmId, agentId }
      );
      expect(result.ok).toBe(true);
    });

    it('persists to cascade_operations audit log', () => {
      handleCascadeRequest(
        CASCADE_METHODS.CASCADE_COMPLETED,
        {
          root_stream_id: 'audit-root',
          agent_id: 'auditor',
          strategy: 'skip_conflicting',
          updated_streams: ['s1', 's2'],
          failed_streams: [{ stream_id: 's3', reason: 'conflict' }],
          skipped_streams: ['s4'],
          deferred_streams: ['s5'],
        },
        { swarmId, agentId }
      );

      const ops = listCascadeOperations({ source_swarm_id: swarmId });
      const audit = ops.find((o) => o.root_stream_id === 'audit-root');
      expect(audit).toBeDefined();
      expect(audit!.strategy).toBe('skip_conflicting');
      expect(audit!.updated_streams).toEqual(['s1', 's2']);
      expect(audit!.failed_streams).toEqual([{ stream_id: 's3', reason: 'conflict' }]);
      expect(audit!.skipped_streams).toEqual(['s4']);
      expect(audit!.deferred_streams).toEqual(['s5']);
    });

    it('rejects missing root_stream_id or updated_streams', () => {
      expect(() =>
        handleCascadeRequest(
          CASCADE_METHODS.CASCADE_COMPLETED,
          { agent_id: 'a', strategy: 'stop_on_conflict', updated_streams: [] },
          { swarmId, agentId }
        )
      ).toThrow(CascadeRequestError);

      expect(() =>
        handleCascadeRequest(
          CASCADE_METHODS.CASCADE_COMPLETED,
          { root_stream_id: 'r', agent_id: 'a', strategy: 'stop_on_conflict' },
          { swarmId, agentId }
        )
      ).toThrow(CascadeRequestError);
    });
  });

  describe('x-cascade/stream.pushed', () => {
    it('records a push entry for trunk-style flows', () => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'push-s1', name: 'trunk', agent_id: 'a' },
        { swarmId, agentId }
      );
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_PUSHED,
        {
          stream_id: 'push-s1',
          agent_id: 'a',
          pushed_commit: 'sha-pushed',
          remote: 'origin',
          remote_ref: 'main',
          strategy: 'direct-push',
        },
        { swarmId, agentId }
      );

      const pushes = listPushes({ source_swarm_id: swarmId });
      const audit = pushes.find((p) => p.stream_id === 'push-s1');
      expect(audit).toBeDefined();
      expect(audit!.pushed_commit).toBe('sha-pushed');
      expect(audit!.remote).toBe('origin');
      expect(audit!.remote_ref).toBe('main');
      expect(audit!.strategy).toBe('direct-push');
    });
  });

  describe('x-cascade/queue.* event chain', () => {
    it('tracks status transitions queued → ready → removed via upsert', () => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'q-s1', name: 'queueable', agent_id: 'a' },
        { swarmId, agentId }
      );

      // 1. Added → status='queued'
      handleCascadeRequest(
        CASCADE_METHODS.QUEUE_ADDED,
        { entry_id: 'qe-1', stream_id: 'q-s1', target_branch: 'main' },
        { swarmId, agentId }
      );
      let entries = listQueueEntries({ source_swarm_id: swarmId });
      let entry = entries.find((e) => e.entry_id === 'qe-1');
      expect(entry?.status).toBe('queued');

      // 2. Ready
      handleCascadeRequest(
        CASCADE_METHODS.QUEUE_READY,
        { entry_id: 'qe-1', stream_id: 'q-s1', target_branch: 'main' },
        { swarmId, agentId }
      );
      entries = listQueueEntries({ source_swarm_id: swarmId });
      entry = entries.find((e) => e.entry_id === 'qe-1');
      expect(entry?.status).toBe('ready');

      // 3. Removed (with outcome)
      handleCascadeRequest(
        CASCADE_METHODS.QUEUE_REMOVED,
        {
          entry_id: 'qe-1',
          stream_id: 'q-s1',
          target_branch: 'main',
          outcome: 'merged',
        },
        { swarmId, agentId }
      );
      entries = listQueueEntries({ source_swarm_id: swarmId });
      entry = entries.find((e) => e.entry_id === 'qe-1');
      expect(entry?.status).toBe('removed');
      expect(entry?.outcome).toBe('merged');
    });

    it('queue.cancelled records reason', () => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'q-s2', name: 'cancellable', agent_id: 'a' },
        { swarmId, agentId }
      );
      handleCascadeRequest(
        CASCADE_METHODS.QUEUE_ADDED,
        { entry_id: 'qe-2', stream_id: 'q-s2', target_branch: 'main' },
        { swarmId, agentId }
      );
      handleCascadeRequest(
        CASCADE_METHODS.QUEUE_CANCELLED,
        {
          entry_id: 'qe-2',
          stream_id: 'q-s2',
          target_branch: 'main',
          reason: 'operator decision',
        },
        { swarmId, agentId }
      );

      const entries = listQueueEntries({ source_swarm_id: swarmId, status: 'cancelled' });
      const entry = entries.find((e) => e.entry_id === 'qe-2');
      expect(entry).toBeDefined();
      expect(entry!.reason).toBe('operator decision');
    });
  });

  describe('x-cascade/stream.conflict_resolved', () => {
    it('marks an existing conflict resolved and revives stream status', () => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'cr-s1', name: 'cr-stream', agent_id: 'a' },
        { swarmId, agentId }
      );
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_CONFLICTED,
        {
          stream_id: 'cr-s1',
          conflict_id: 'cf-resolved-1',
          conflicted_files: ['x.ts'],
          source: 'sync',
        },
        { swarmId, agentId }
      );
      const before = getStreamBySwarmAndId(swarmId, 'cr-s1');
      expect(before?.status).toBe('conflicted');

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_CONFLICT_RESOLVED,
        {
          stream_id: 'cr-s1',
          conflict_id: 'cf-resolved-1',
          resolution_method: 'auto-resolve',
          resolved_by: 'system',
          resolution_summary: 'merged with -X ours',
        },
        { swarmId, agentId }
      );

      const after = getStreamBySwarmAndId(swarmId, 'cr-s1');
      expect(after?.status).toBe('active');
      const conflicts = listConflictsForStream(after!.id);
      const resolved = conflicts.find((c) => c.conflict_id === 'cf-resolved-1');
      expect(resolved?.status).toBe('resolved');
      expect(resolved?.resolved_at).not.toBeNull();
    });
  });

  describe('dispatch errors', () => {
    it('throws CascadeRequestError for unknown cascade methods', () => {
      expect(() =>
        handleCascadeRequest(
          'x-cascade/stream.unknown',
          { stream_id: 'x' },
          { swarmId, agentId }
        )
      ).toThrow(CascadeRequestError);
    });
  });
});
