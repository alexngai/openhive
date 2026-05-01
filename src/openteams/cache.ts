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

  const template = await compute();
  cache.set(key, { template, expiresAt: Date.now() + TTL_MS });
  return template;
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

/** Test-only: reset the entire cache. */
export function _resetCacheForTest(): void {
  cache.clear();
}
