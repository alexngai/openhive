/**
 * Shared SkillBank serving-layer cache.
 *
 * Centralizes the (resourceId → SkillGraphServer) cache so that both the
 * existing skill-management routes and the openteams resolver call into
 * the same instance. Without sharing, two parallel caches with their own
 * eviction timers would race when a skill mutation happens on either side.
 *
 * Cache TTL mirrors `skill-management.ts` legacy default (10 minutes).
 */

import {
  createSkillBank,
  type SkillBank,
  type SkillGraphServer,
} from 'skill-tree';
import * as resourcesDAL from '../db/dal/syncable-resources.js';
import { resolveLocalPath } from '../api/routes/_resource-helpers.js';
import { getSyncOrchestrator } from '../sync/sync-orchestrator.js';

interface CachedServingLayer {
  bank: SkillBank;
  server: SkillGraphServer;
  timer: ReturnType<typeof setTimeout>;
}

const cache = new Map<string, CachedServingLayer>();
const SERVING_CACHE_TTL = 10 * 60 * 1000;

export function evictServingLayer(resourceId: string): void {
  const cached = cache.get(resourceId);
  if (cached) {
    cached.bank.shutdown().catch(() => {});
    clearTimeout(cached.timer);
    cache.delete(resourceId);
  }
}

/**
 * Get (or create) a serving layer for a skill bank pinned at `localPath`.
 * Used by the legacy skill-management routes which already resolved the
 * path via _resource-helpers.
 */
export async function getServingLayer(
  resourceId: string,
  localPath: string,
): Promise<{ bank: SkillBank; server: SkillGraphServer }> {
  const cached = cache.get(resourceId);
  if (cached) {
    clearTimeout(cached.timer);
    cached.timer = setTimeout(() => evictServingLayer(resourceId), SERVING_CACHE_TTL);
    return { bank: cached.bank, server: cached.server };
  }

  const bank = createSkillBank({ storage: { basePath: localPath } });
  await bank.initialize();
  const { server } = await bank.createServingLayer();

  const timer = setTimeout(() => evictServingLayer(resourceId), SERVING_CACHE_TTL);
  cache.set(resourceId, { bank, server, timer });
  return { bank, server };
}

/**
 * Resolve a skill bank by resource id (looking up the resource + its
 * filesystem path internally), and return the serving layer.
 *
 * Used by callers that have a resourceId without a request context
 * (e.g. the openteams resolver). Throws on missing resource, wrong type,
 * or unresolvable filesystem path.
 */
export async function getServingLayerByResourceId(
  resourceId: string,
): Promise<{ bank: SkillBank; server: SkillGraphServer; localPath: string }> {
  const resource = resourcesDAL.findResourceById(resourceId);
  if (!resource) {
    throw new Error(`Skill bank resource not found: ${resourceId}`);
  }
  if (resource.resource_type !== 'skill') {
    throw new Error(
      `Resource ${resourceId} is not a skill bank (got '${resource.resource_type}')`,
    );
  }

  let localPath = resolveLocalPath(resource);
  if (!localPath && (resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror')) {
    try {
      const contentPath = await getSyncOrchestrator().ensureContent(resource);
      if (contentPath) localPath = contentPath;
    } catch { /* clone failed */ }
  }

  if (!localPath) {
    throw new Error(`Skill bank ${resourceId} has no resolvable local path`);
  }

  const { bank, server } = await getServingLayer(resourceId, localPath);
  return { bank, server, localPath };
}
