/**
 * Verifies that cascade_diff_cache entries are evicted on terminal stream
 * lifecycle events: stream.merged, stream.abandoned, cascade.rebased.
 *
 * Pre-seeds rows directly via the DAL, fires the handler with the
 * matching MAP event, then asserts the cache is empty for the affected
 * stream. Sibling streams are untouched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  handleCascadeRequest,
  CASCADE_METHODS,
} from '../../map/cascade-handler.js';
import { upsertStream } from '../../db/dal/cascade-streams.js';
import * as cache from '../../db/dal/cascade-diff-cache.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_ROOT = testRoot('cascade-diff-eviction');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'cascade-diff-eviction.db');
const SWARM = 'swarm-evict';

// Help readers track the magic stream-id shape.
function seedCache(streamId: string, commit: string): void {
  cache.putDiff({
    stream_id: streamId,
    commit_hash: commit,
    diff_blob: `diff for ${streamId}@${commit}`,
    files_touched: ['a'],
  });
}

describe('cascade_diff_cache eviction on terminal events', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'evict-test',
      description: 'eviction-test',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM cascade_diff_cache').run();
    db.prepare('DELETE FROM cascade_merges').run();
    db.prepare('DELETE FROM cascade_changes').run();
    db.prepare('DELETE FROM cascade_streams').run();
  });

  it('handleStreamMerged evicts cache for the merged source stream only', () => {
    const sourceStreamId = 'src-stream';
    const targetStreamId = 'target-stream';
    const otherStreamId = 'other-stream';

    upsertStream({
      stream_id: sourceStreamId,
      source_swarm_id: SWARM,
      source_agent_id: agentId,
      name: 'src',
    });
    upsertStream({
      stream_id: targetStreamId,
      source_swarm_id: SWARM,
      source_agent_id: agentId,
      name: 'target',
    });

    seedCache(sourceStreamId, 'aaa');
    seedCache(sourceStreamId, 'bbb');
    seedCache(otherStreamId, 'ccc');

    expect(cache.countDiffsForStream(sourceStreamId)).toBe(2);
    expect(cache.countDiffsForStream(otherStreamId)).toBe(1);

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_MERGED,
      {
        source_stream_id: sourceStreamId,
        target_stream_id: targetStreamId,
        merge_commit: 'm1',
        agent_id: agentId,
      },
      { swarmId: SWARM, agentId },
    );

    expect(cache.countDiffsForStream(sourceStreamId)).toBe(0);
    expect(cache.countDiffsForStream(otherStreamId)).toBe(1);
  });

  it('handleStreamAbandoned evicts cache for the abandoned stream', () => {
    const streamId = 'doomed-stream';
    upsertStream({
      stream_id: streamId,
      source_swarm_id: SWARM,
      source_agent_id: agentId,
      name: 'doomed',
    });
    seedCache(streamId, 'aaa');
    seedCache(streamId, 'bbb');
    expect(cache.countDiffsForStream(streamId)).toBe(2);

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_ABANDONED,
      { stream_id: streamId, reason: 'user-requested' },
      { swarmId: SWARM, agentId },
    );

    expect(cache.countDiffsForStream(streamId)).toBe(0);
  });

  it('handleCascadeRebased evicts cache for the rebased stream', () => {
    const streamId = 'rebased-stream';
    upsertStream({
      stream_id: streamId,
      source_swarm_id: SWARM,
      source_agent_id: agentId,
      name: 'to-rebase',
    });
    seedCache(streamId, 'old1');
    seedCache(streamId, 'old2');
    expect(cache.countDiffsForStream(streamId)).toBe(2);

    handleCascadeRequest(
      CASCADE_METHODS.CASCADE_REBASED,
      {
        stream_id: streamId,
        new_base_commit: 'newbase',
        new_head: 'newhead',
        new_commits: [
          { commit_hash: 'new1', message_summary: 'first' },
          { commit_hash: 'new2', message_summary: 'second' },
        ],
        triggered_by_stream_id: 'parent',
        triggered_by_agent_id: agentId,
        agent_id: agentId,
      },
      { swarmId: SWARM, agentId },
    );

    expect(cache.countDiffsForStream(streamId)).toBe(0);
  });
});
