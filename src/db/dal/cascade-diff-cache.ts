/**
 * DAL for cascade_diff_cache — content-addressed cache for unified diff blobs
 * fetched on-demand from runtimes via `cascade/diff.request`.
 *
 * Cache key: (stream_id, commit_hash, base_hash, file_path) where base_hash
 * and file_path may be NULL. SQLite NULL-safe uniqueness is enforced via
 * IFNULL in the index (see MIGRATION_V56_CASCADE_DIFF_CACHE).
 *
 * Entries are immutable. Eviction happens on stream lifecycle events
 * (merged / abandoned / rebased) via `evictByStream` — not by TTL.
 *
 * See docs/design/cascade-diff-and-stacked-prs.md (D6, D7, D15) for the
 * full design rationale and the eviction hook points.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';

export interface CascadeDiffCacheRow {
  id: string;
  stream_id: string;
  commit_hash: string;
  base_hash: string | null;
  file_path: string | null;
  diff_blob: string;
  files_touched: string[];
  size_bytes: number;
  compression: string;
  created_at: string;
  last_accessed_at: string;
}

export interface GetDiffInput {
  stream_id: string;
  commit_hash: string;
  base_hash?: string | null;
  file_path?: string | null;
}

export interface PutDiffInput {
  stream_id: string;
  commit_hash: string;
  base_hash?: string | null;
  file_path?: string | null;
  diff_blob: string;
  files_touched: string[];
  size_bytes?: number;
  compression?: string;
}

type Row = {
  id: string;
  stream_id: string;
  commit_hash: string;
  base_hash: string | null;
  file_path: string | null;
  diff_blob: string;
  files_touched: string;
  size_bytes: number;
  compression: string;
  created_at: string;
  last_accessed_at: string;
};

function deserialize(row: Row): CascadeDiffCacheRow {
  let files: string[] = [];
  try {
    const parsed = JSON.parse(row.files_touched);
    if (Array.isArray(parsed)) files = parsed.filter((f): f is string => typeof f === 'string');
  } catch {
    /* malformed — leave empty */
  }
  return {
    id: row.id,
    stream_id: row.stream_id,
    commit_hash: row.commit_hash,
    base_hash: row.base_hash,
    file_path: row.file_path,
    diff_blob: row.diff_blob,
    files_touched: files,
    size_bytes: row.size_bytes,
    compression: row.compression,
    created_at: row.created_at,
    last_accessed_at: row.last_accessed_at,
  };
}

/**
 * Look up a cached diff by content-addressed key. Returns null on miss.
 *
 * Touches `last_accessed_at` on hit so a future LRU sweep can use it.
 * NULL `base_hash` / `file_path` are matched explicitly.
 */
export function getDiff(input: GetDiffInput): CascadeDiffCacheRow | null {
  const db = getDatabase();
  const row = db
    .prepare<[string, string, string, string], Row>(
      `SELECT id, stream_id, commit_hash, base_hash, file_path, diff_blob,
              files_touched, size_bytes, compression, created_at, last_accessed_at
         FROM cascade_diff_cache
        WHERE stream_id = ?
          AND commit_hash = ?
          AND IFNULL(base_hash, '') = ?
          AND IFNULL(file_path, '') = ?
        LIMIT 1`
    )
    .get(
      input.stream_id,
      input.commit_hash,
      input.base_hash ?? '',
      input.file_path ?? ''
    );
  if (!row) return null;
  touchAccess(row.id);
  // touchAccess bumps last_accessed_at after the SELECT — reflect the new
  // value on the returned row so callers see a coherent timestamp.
  const bumped = readRowById(row.id);
  return deserialize(bumped ?? row);
}

function readRowById(id: string): Row | null {
  const db = getDatabase();
  return (
    db
      .prepare<[string], Row>(
        `SELECT id, stream_id, commit_hash, base_hash, file_path, diff_blob,
                files_touched, size_bytes, compression, created_at, last_accessed_at
           FROM cascade_diff_cache WHERE id = ? LIMIT 1`
      )
      .get(id) ?? null
  );
}

/**
 * Write a diff entry. Idempotent: re-insert of an existing key is silently
 * ignored (entries are immutable by design — same (stream, commit, base, file)
 * always produces the same diff).
 */
export function putDiff(input: PutDiffInput): CascadeDiffCacheRow {
  const db = getDatabase();
  const id = nanoid();
  const sizeBytes = input.size_bytes ?? Buffer.byteLength(input.diff_blob, 'utf-8');
  const compression = input.compression ?? 'none';

  db.prepare(
    `INSERT OR IGNORE INTO cascade_diff_cache (
      id, stream_id, commit_hash, base_hash, file_path,
      diff_blob, files_touched, size_bytes, compression
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.stream_id,
    input.commit_hash,
    input.base_hash ?? null,
    input.file_path ?? null,
    input.diff_blob,
    JSON.stringify(input.files_touched ?? []),
    sizeBytes,
    compression
  );

  // INSERT OR IGNORE may have skipped the write; re-read by key.
  const row = getDiff({
    stream_id: input.stream_id,
    commit_hash: input.commit_hash,
    base_hash: input.base_hash ?? null,
    file_path: input.file_path ?? null,
  });
  if (!row) {
    throw new Error('cascade-diff-cache: putDiff failed to read back row');
  }
  return row;
}

/**
 * Drop every cached entry for a stream. Called from `handleStreamMerged`,
 * `handleStreamAbandoned`, and `handleCascadeRebased` in
 * `src/map/cascade-handler.ts`.
 *
 * Takes the cascade `stream_id` (the runtime's id), not the hub `stream_row_id`,
 * because that's the column we cache by.
 *
 * Returns the number of rows deleted (handy for tests + observability).
 */
export function evictByStream(streamId: string): number {
  const db = getDatabase();
  const result = db
    .prepare(`DELETE FROM cascade_diff_cache WHERE stream_id = ?`)
    .run(streamId);
  return result.changes ?? 0;
}

/**
 * Bump `last_accessed_at` on a cache row. Called transparently by `getDiff`
 * on every hit. Exposed for future tests / direct LRU flows.
 */
export function touchAccess(id: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE cascade_diff_cache SET last_accessed_at = datetime('now') WHERE id = ?`
  ).run(id);
}

/**
 * Total cached rows for a stream — debugging + test helper.
 */
export function countDiffsForStream(streamId: string): number {
  const db = getDatabase();
  const row = db
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM cascade_diff_cache WHERE stream_id = ?`
    )
    .get(streamId);
  return row?.n ?? 0;
}
