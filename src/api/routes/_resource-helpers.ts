/**
 * Shared resource resolution helpers used by resource-content and skill-management routes.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { getSyncOrchestrator } from '../../sync/sync-orchestrator.js';
import type { SyncableResource } from '../../types.js';

// ============================================================================
// Path Helpers
// ============================================================================

const REMOTE_URL_PREFIXES = ['http', 'git://', 'ssh://'];

export function resolveLocalPath(resource: SyncableResource): string | null {
  if (resource.local_path) {
    return resolve(resource.local_path);
  }

  // ls-remote/mirror resources must go through ensureContent() to clone properly
  if (resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror') {
    return null;
  }

  const url = resource.git_remote_url;
  for (const prefix of REMOTE_URL_PREFIXES) {
    if (url.startsWith(prefix)) return null;
  }
  return resolve(url);
}

export function isPathWithin(filePath: string, baseDir: string): boolean {
  const resolved = resolve(filePath);
  const base = resolve(baseDir);
  return resolved === base || resolved.startsWith(base + '/');
}

// ============================================================================
// Resource Resolution
// ============================================================================

interface ResolveResult {
  resource: SyncableResource;
  localPath: string;
  isCloned: boolean;
}

interface ReplyLike {
  status: (code: number) => { send: (body: unknown) => unknown };
}

interface RequestLike {
  params: { id: string };
  agent?: { id: string };
}

/**
 * Resolve resource → check access → resolve local path.
 * Returns null (and sends error reply) if resolution fails.
 */
export async function resolveResourceAndPath(
  request: RequestLike,
  reply: ReplyLike,
): Promise<ResolveResult | null> {
  const resource = resourcesDAL.findResourceById(request.params.id);
  if (!resource) {
    reply.status(404).send({ error: 'Not Found', message: 'Resource not found' });
    return null;
  }
  if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
    reply.status(403).send({ error: 'Forbidden', message: 'You do not have access to this resource' });
    return null;
  }

  let localPath = resolveLocalPath(resource);

  // Trigger lazy clone (ls-remote) or verify eager clone (mirror)
  if (!localPath && (resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror')) {
    try {
      const contentPath = await getSyncOrchestrator().ensureContent(resource);
      if (contentPath) localPath = contentPath;
    } catch { /* clone failed */ }
  }

  if (!localPath) {
    reply.status(400).send({ error: 'Bad Request', message: 'Resource does not point to a local filesystem path' });
    return null;
  }
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    reply.status(404).send({ error: 'Not Found', message: 'Resource path does not exist on the filesystem' });
    return null;
  }

  return { resource, localPath, isCloned: resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror' };
}
