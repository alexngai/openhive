/**
 * Resolver cache for ResolvedTemplate.
 *
 * Keyed by `(templateId, contentHash)` so that any change to a team_template
 * resource (or to a referenced loadout / skill bank that flows through
 * postProcess) produces a new key and the cached entry is naturally bypassed.
 *
 * TTL mirrors `src/skill-tree/serving.ts` (10 min) to keep cache pressures
 * symmetric across the resolver pipeline.
 */

import { createHash } from 'node:crypto';
import type { ResolvedTemplate } from './types.js';

interface CacheEntry {
  template: ResolvedTemplate;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60 * 1000;

/**
 * In-flight Promise coalescer. When N concurrent callers see the same cold
 * key, only the first one runs `compute()`; the rest await its result. Without
 * this, a poll cycle that finds 50 queued dispatches against the same template
 * would run 50 parallel `TemplateLoader.loadAsync` calls, each writing to its
 * own staging tmpdir.
 */
const inflight = new Map<string, Promise<ResolvedTemplate>>();

/** Stable hash of a JSON-serializable object — drives the cache key. */
export function hashContent(content: unknown): string {
  const json = JSON.stringify(content, sortObjectKeys);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function sortObjectKeys(this: unknown, _key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Return cached ResolvedTemplate for (templateId, contentHash) or compute,
 * cache, and return.
 */
export async function resolveCachedOrCompute(
  templateId: string,
  contentHash: string,
  compute: () => Promise<ResolvedTemplate>,
): Promise<ResolvedTemplate> {
  const key = `${templateId}:${contentHash}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.template;
  }

  // If a compute is already in flight for this key, await its result instead
  // of starting a duplicate. The cache-check + inflight-attach + compute-run
  // is single-threaded under Node's event loop, so this is race-free.
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const template = await compute();
      cache.set(key, { template, expiresAt: Date.now() + TTL_MS });
      return template;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Drop all cache entries for a given templateId regardless of contentHash.
 * Call when the underlying team_template resource changes.
 */
export function evictTemplate(templateId: string): void {
  const prefix = `${templateId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Test-only: reset the entire cache (including any in-flight promises). */
export function _resetCacheForTest(): void {
  cache.clear();
  inflight.clear();
}
