/**
 * DAL tests for cascade_diff_cache — exercises the V56 migration and the
 * NULL-safe cache key on a real SQLite instance.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as cache from '../../db/dal/cascade-diff-cache.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('cascade-diff-cache-dal');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'cascade-diff-cache-dal.db');

const STREAM = 'stream_abc';
const COMMIT = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

describe('cascade-diff-cache DAL', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM cascade_diff_cache').run();
  });

  describe('putDiff / getDiff', () => {
    it('writes and reads a row with no base or file_path', () => {
      const written = cache.putDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        diff_blob: 'diff --git a/x b/x\n',
        files_touched: ['x'],
      });
      expect(written.id).toBeTruthy();
      expect(written.base_hash).toBeNull();
      expect(written.file_path).toBeNull();
      expect(written.size_bytes).toBe(Buffer.byteLength('diff --git a/x b/x\n', 'utf-8'));
      expect(written.compression).toBe('none');

      const hit = cache.getDiff({ stream_id: STREAM, commit_hash: COMMIT });
      expect(hit).not.toBeNull();
      expect(hit!.diff_blob).toBe('diff --git a/x b/x\n');
      expect(hit!.files_touched).toEqual(['x']);
    });

    it('treats NULL base_hash and file_path as distinct from string values', () => {
      cache.putDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        diff_blob: 'whole-commit blob',
        files_touched: ['a', 'b'],
      });
      cache.putDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        file_path: 'a',
        diff_blob: 'single-file a blob',
        files_touched: ['a'],
      });
      cache.putDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        base_hash: BASE,
        diff_blob: 'range blob',
        files_touched: ['a', 'b'],
      });

      const whole = cache.getDiff({ stream_id: STREAM, commit_hash: COMMIT });
      const fileA = cache.getDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        file_path: 'a',
      });
      const range = cache.getDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        base_hash: BASE,
      });

      expect(whole!.diff_blob).toBe('whole-commit blob');
      expect(fileA!.diff_blob).toBe('single-file a blob');
      expect(range!.diff_blob).toBe('range blob');
    });

    it('returns null on miss', () => {
      expect(
        cache.getDiff({ stream_id: STREAM, commit_hash: 'nope' })
      ).toBeNull();
    });

    it('is idempotent on duplicate insert (same key)', () => {
      const first = cache.putDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        diff_blob: 'first blob',
        files_touched: ['x'],
      });
      const second = cache.putDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        diff_blob: 'second blob (should be ignored)',
        files_touched: ['y'],
      });
      // INSERT OR IGNORE — the second write is dropped, key still points
      // at the first row.
      expect(second.id).toBe(first.id);
      expect(second.diff_blob).toBe('first blob');
      expect(second.files_touched).toEqual(['x']);
      expect(cache.countDiffsForStream(STREAM)).toBe(1);
    });
  });

  describe('evictByStream', () => {
    it('removes every row for the given stream and leaves others alone', () => {
      cache.putDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        diff_blob: 'a',
        files_touched: [],
      });
      cache.putDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        file_path: 'x',
        diff_blob: 'b',
        files_touched: ['x'],
      });
      cache.putDiff({
        stream_id: 'other_stream',
        commit_hash: COMMIT,
        diff_blob: 'c',
        files_touched: [],
      });

      const removed = cache.evictByStream(STREAM);
      expect(removed).toBe(2);
      expect(cache.countDiffsForStream(STREAM)).toBe(0);
      expect(cache.countDiffsForStream('other_stream')).toBe(1);
    });

    it('returns 0 when the stream had no entries', () => {
      expect(cache.evictByStream('never_seen')).toBe(0);
    });
  });

  describe('touchAccess', () => {
    it('getDiff transparently bumps last_accessed_at', () => {
      const written = cache.putDiff({
        stream_id: STREAM,
        commit_hash: COMMIT,
        diff_blob: 'x',
        files_touched: [],
      });

      // SQLite's datetime('now') is whole-second resolution, which makes
      // wall-clock-based timing racy. Backdate the row manually so the
      // touch under test produces an unambiguous bump.
      const oldStamp = '2020-01-01 00:00:00';
      getDatabase()
        .prepare(
          `UPDATE cascade_diff_cache SET last_accessed_at = ? WHERE id = ?`
        )
        .run(oldStamp, written.id);

      const hit = cache.getDiff({ stream_id: STREAM, commit_hash: COMMIT });
      expect(hit).not.toBeNull();
      expect(hit!.last_accessed_at > oldStamp).toBe(true);
    });
  });
});
