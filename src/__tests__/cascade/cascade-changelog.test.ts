/**
 * Tests for the changelog generator + markdown renderer.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { generateChangelog, renderMarkdown } from '../../cascade/changelog.js';
import {
  handleCascadeRequest,
  CASCADE_METHODS,
} from '../../map/cascade-handler.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_ROOT = testRoot('cascade-changelog');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'changelog.db');

describe('Cascade Changelog', () => {
  const swarmId = 'swarm-changelog-test';
  const agentId = 'changelog-test-agent';
  const taskRef = { resource_id: 'res-changelog', node_id: 'task-changelog' };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    await agentsDAL.createAgent({
      name: 'changelog-test-agent',
      description: 'Agent for changelog tests',
    });
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('empty case', () => {
    it('returns has_work=false with zero totals when no streams are bound', () => {
      const result = generateChangelog('nope', 'nope');
      expect(result.has_work).toBe(false);
      expect(result.totals.commits).toBe(0);
      expect(result.totals.streams).toBe(0);
      expect(result.commits).toEqual([]);
      expect(result.files_union).toEqual([]);
    });

    it('renders a "no commits" message in markdown', () => {
      const md = renderMarkdown(generateChangelog('nope', 'nope'), {
        title: 'Placeholder Task',
      });
      expect(md).toContain('# Placeholder Task');
      expect(md).toContain('No commits bound to this task yet.');
    });
  });

  describe('happy path — multi-commit stream with merge', () => {
    const streamId = 'cl-stream-1';

    beforeAll(() => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        {
          stream_id: streamId,
          name: 'changelog-happy',
          agent_id: 'worker-c',
          base_commit: 'base',
          metadata: { task_ref: taskRef },
        },
        { swarmId, agentId }
      );

      const commits = [
        { hash: 'cl-c1', change: 'chg-cl-1', msg: 'feat: add login', files: ['src/auth/login.ts'] },
        { hash: 'cl-c2', change: 'chg-cl-2', msg: 'test: login edges', files: ['test/auth/login.test.ts'] },
        { hash: 'cl-c3', change: 'chg-cl-3', msg: 'docs: auth flow', files: ['docs/auth.md', 'src/auth/login.ts'] },
      ];
      let parent = 'base';
      for (const c of commits) {
        handleCascadeRequest(
          CASCADE_METHODS.STREAM_COMMITTED,
          {
            stream_id: streamId,
            commit_hash: c.hash,
            change_id: c.change,
            agent_id: 'worker-c',
            message_summary: c.msg,
            files_touched: c.files,
            parent_commit: parent,
            metadata: { task_ref: taskRef },
          },
          { swarmId, agentId }
        );
        parent = c.hash;
      }

      // Also merge the stream into main so merges section renders
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_MERGED,
        {
          source_stream_id: streamId,
          target_stream_id: 'main',
          merge_commit: 'cl-merge-1',
          agent_id: 'worker-c',
          source_commit: 'cl-c3',
          strategy: 'merge-commit',
        },
        { swarmId, agentId }
      );
    });

    it('aggregates commits, totals, and files_union', () => {
      const result = generateChangelog(taskRef.resource_id, taskRef.node_id);
      expect(result.has_work).toBe(true);
      expect(result.totals.commits).toBe(3);
      expect(result.totals.streams).toBe(1);
      expect(result.totals.merged_streams).toBe(1);
      expect(result.totals.files_touched).toBe(3);
      expect(result.files_union).toEqual([
        'docs/auth.md',
        'src/auth/login.ts',
        'test/auth/login.test.ts',
      ]);
      expect(result.commits[0].commit_hash).toBe('cl-c1');
      expect(result.commits[2].commit_hash).toBe('cl-c3');
      expect(result.streams[0].merge_commit).toBe('cl-merge-1');
      expect(result.streams[0].merge_target).toBe('main');
    });

    it('renders markdown with commits + merges + files sections', () => {
      const result = generateChangelog(taskRef.resource_id, taskRef.node_id);
      const md = renderMarkdown(result, { title: 'Add OAuth login', subtitle: 'T-42' });
      expect(md).toContain('# Add OAuth login');
      expect(md).toContain('_T-42_');
      expect(md).toContain('3 commits');
      expect(md).toContain('1 stream');
      expect(md).toContain('3 files touched');
      expect(md).toContain('1 merged');
      expect(md).toContain('## Commits');
      expect(md).toContain('`cl-c1`');
      expect(md).toContain('feat: add login');
      expect(md).toContain('## Merges');
      expect(md).toContain(`stream/${streamId}`);
      // merge_commit is sliced to 8 chars; 'cl-merge-1' → 'cl-merge'
      expect(md).toContain('`cl-merge`');
      expect(md).toContain('## Files touched');
      expect(md).toContain('- docs/auth.md');
    });

    it('truncates long message summaries + caps file lists per commit', () => {
      const longRef = { resource_id: 'res-long', node_id: 'task-long' };
      const longStream = 'cl-stream-long';
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        {
          stream_id: longStream,
          name: 'long',
          agent_id: 'w',
          metadata: { task_ref: longRef },
        },
        { swarmId, agentId }
      );
      const longMsg = 'a'.repeat(200);
      const manyFiles = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_COMMITTED,
        {
          stream_id: longStream,
          commit_hash: 'long-c1',
          change_id: 'chg-long',
          agent_id: 'w',
          message_summary: longMsg,
          files_touched: manyFiles,
          parent_commit: 'base',
          metadata: { task_ref: longRef },
        },
        { swarmId, agentId }
      );

      const md = renderMarkdown(
        generateChangelog(longRef.resource_id, longRef.node_id),
        { summary_max_length: 40, files_per_commit_cap: 3 }
      );
      // Summary truncated with ellipsis
      expect(md).toMatch(/a{39}…/);
      // Files capped
      expect(md).toContain('f0.ts, f1.ts, f2.ts');
      expect(md).toContain('+7 more');
    });
  });

  describe('conflicts surfaced', () => {
    it('surfaces open conflicts in both structured output and markdown', () => {
      const cRef = { resource_id: 'res-cf', node_id: 'task-cf' };
      const cStream = 'cl-stream-cf';
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        {
          stream_id: cStream,
          name: 'cf',
          agent_id: 'w',
          metadata: { task_ref: cRef },
        },
        { swarmId, agentId }
      );
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_COMMITTED,
        {
          stream_id: cStream,
          commit_hash: 'cf-c1',
          change_id: 'chg-cf',
          agent_id: 'w',
          message_summary: 'feat: x',
          files_touched: ['x.ts'],
          parent_commit: 'base',
          metadata: { task_ref: cRef },
        },
        { swarmId, agentId }
      );
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_CONFLICTED,
        {
          stream_id: cStream,
          conflict_id: 'cf-open',
          conflicted_files: ['x.ts'],
          source: 'sync',
        },
        { swarmId, agentId }
      );

      const result = generateChangelog(cRef.resource_id, cRef.node_id);
      expect(result.totals.open_conflicts).toBe(1);
      expect(result.streams[0].open_conflicts[0].conflict_id).toBe('cf-open');

      const md = renderMarkdown(result);
      expect(md).toContain('**1 open conflict**');
      expect(md).toContain('## Conflicts');
      expect(md).toContain('cf-open');
    });
  });
});
