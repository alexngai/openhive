/**
 * Verifies the diff-resolver's post-fetch terminal-status check (F2 fix):
 * if a stream transitions to merged/abandoned during the on-demand fetch
 * window, the resolver MUST skip the write-through cache write — otherwise
 * it leaks a row for a stream whose `evictByStream` hook has already run.
 *
 * Mocks the MapDiffFetcher to simulate a slow fetch; transitions the
 * stream to `merged` before the fetcher resolves; asserts no cache row.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  upsertStream,
  updateStreamStatus,
} from '../../db/dal/cascade-streams.js';
import { createSwarm } from '../../db/dal/map.js';
import * as cache from '../../db/dal/cascade-diff-cache.js';
import {
  resolveCommitDiff,
  resolveStreamDiff,
  setMapDiffFetcher,
  getMapDiffFetcher,
  type MapDiffFetcher,
  type MapDiffFetchArgs,
} from '../../cascade/diff-resolver.js';
import { getInbound } from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { vi } from 'vitest';

vi.mock('../../map/connection-registry.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../map/connection-registry.js')>(
      '../../map/connection-registry.js',
    );
  return {
    ...actual,
    getInbound: vi.fn(),
    hasCapability: vi.fn().mockReturnValue(true),
  };
});

const TEST_ROOT = testRoot('diff-resolver-cache-safety');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'diff-resolver-cache-safety.db');
const SWARM = 'swarm-race';

let agentId: string;
let originalFetcher: MapDiffFetcher;

describe('diff-resolver — post-fetch terminal-status race protection', () => {
  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'race-test',
      description: 'race',
    });
    agentId = agent.id;
    createSwarm(agentId, {
      id: SWARM,
      name: SWARM,
      map_endpoint: 'inline-test',
      map_transport: 'websocket',
      auth_method: 'none',
    });
    // Make the presence gate happy.
    vi.mocked(getInbound).mockReturnValue({
      ws: { readyState: 1 /* OPEN */ } as unknown as WebSocket,
      // The resolver only reads ws.readyState; everything else is unused.
    } as unknown as ReturnType<typeof getInbound>);
    originalFetcher = getMapDiffFetcher();
  });

  afterAll(() => {
    setMapDiffFetcher(originalFetcher);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM cascade_diff_cache').run();
    db.prepare('DELETE FROM cascade_changes').run();
    db.prepare('DELETE FROM cascade_streams').run();
  });

  it('skips putDiff when stream transitions to merged during fetch (commit diff)', async () => {
    const { stream } = upsertStream({
      stream_id: 'race-stream',
      source_swarm_id: SWARM,
      source_agent_id: agentId,
      name: 'race',
      base_commit: 'base-1',
    });

    // Fetcher races the merge: flips the stream to `merged` BEFORE
    // returning a successful payload. This models the real race where
    // `handleStreamMerged → evictByStream` runs while we're awaiting
    // the sidecar's diff response.
    setMapDiffFetcher({
      async fetch(_args: MapDiffFetchArgs) {
        updateStreamStatus(stream.id, 'merged');
        return {
          ok: true,
          payload: {
            diff: 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@\n+x\n',
            files_touched: ['f'],
            truncated: false,
          },
        };
      },
    });

    const result = await resolveCommitDiff({
      stream_row_id: stream.id,
      commit_hash: 'commit-A',
    });

    expect(result.ok).toBe(true);
    // No cache row should exist — the post-fetch status check should
    // have suppressed putDiff.
    const cached = cache.getDiff({
      stream_id: stream.stream_id,
      commit_hash: 'commit-A',
      base_hash: null,
      file_path: null,
    });
    expect(cached).toBeNull();
  });

  it('skips putDiff when stream transitions to abandoned during fetch (stream diff)', async () => {
    const { stream } = upsertStream({
      stream_id: 'race-abandon',
      source_swarm_id: SWARM,
      source_agent_id: agentId,
      name: 'race-abandon',
      base_commit: 'base-X',
    });
    // recordCommit so resolveStreamDiff has a head to range from.
    getDatabase()
      .prepare(
        `INSERT INTO cascade_changes (id, stream_row_id, commit_hash) VALUES (?, ?, ?)`,
      )
      .run('c1', stream.id, 'head-Y');

    setMapDiffFetcher({
      async fetch(_args: MapDiffFetchArgs) {
        updateStreamStatus(stream.id, 'abandoned');
        return {
          ok: true,
          payload: { diff: '...', files_touched: [], truncated: false },
        };
      },
    });

    const result = await resolveStreamDiff({ stream_row_id: stream.id });
    expect(result.ok).toBe(true);
    const cached = cache.getDiff({
      stream_id: stream.stream_id,
      commit_hash: 'head-Y',
      base_hash: 'base-X',
      file_path: null,
    });
    expect(cached).toBeNull();
  });

  it('writes through normally when status stays active', async () => {
    const { stream } = upsertStream({
      stream_id: 'happy-stream',
      source_swarm_id: SWARM,
      source_agent_id: agentId,
      name: 'happy',
      base_commit: 'base-Z',
    });

    setMapDiffFetcher({
      async fetch(_args: MapDiffFetchArgs) {
        // No status change — should reach putDiff.
        return {
          ok: true,
          payload: {
            diff: 'diff --git a/g b/g\n--- a/g\n+++ b/g\n@@\n+y\n',
            files_touched: ['g'],
            truncated: false,
          },
        };
      },
    });

    await resolveCommitDiff({
      stream_row_id: stream.id,
      commit_hash: 'commit-Z',
    });

    const cached = cache.getDiff({
      stream_id: stream.stream_id,
      commit_hash: 'commit-Z',
      base_hash: null,
      file_path: null,
    });
    expect(cached).not.toBeNull();
    expect(cached?.files_touched).toEqual(['g']);
  });
});
