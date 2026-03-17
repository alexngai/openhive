/**
 * MAP OpenTasks Request Handler
 *
 * Handles map/opentasks/* JSON-RPC 2.0 requests from MAP-connected agents.
 * Resolves the target resource, validates access, and proxies to the local
 * OpenTasks daemon (or JSONL fallback).
 */

import { resolve, join, normalize } from 'node:path';
import { existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { MAP_OPENTASKS_METHODS } from './opentasks-types.js';
import type {
  OpenTasksResourceTarget,
  OpenTasksSummaryParams,
  OpenTasksReadyParams,
  OpenTasksQueryParams,
  OpenTasksStatusParams,
  OpenTasksSummaryResult,
  OpenTasksReadyResult,
  OpenTasksQueryResult,
  OpenTasksStatusResult,
} from './opentasks-types.js';
import { OpenHiveOpenTasksClient } from '../opentasks-client/index.js';
import * as resourcesDAL from '../db/dal/syncable-resources.js';
import type { SyncableResource } from '../types.js';

// ============================================================================
// Errors
// ============================================================================

export class OpenTasksRequestError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenTasksRequestError';
  }

  toJsonRpcError(): { code: number; message: string } {
    return { code: this.code, message: this.message };
  }
}

// ============================================================================
// Resource Resolution
// ============================================================================

const REMOTE_URL_PREFIXES = ['http', 'git://', 'ssh://'];

/**
 * Canonicalize a local path: resolve symlinks if path exists,
 * otherwise fall back to resolve() for consistent comparison.
 */
function canonicalPath(p: string): string {
  const resolved = resolve(normalize(p));
  try {
    if (existsSync(resolved)) {
      return realpathSync(resolved);
    }
  } catch { /* fall through */ }
  return resolved;
}

function resolveLocalPath(resource: SyncableResource): string | null {
  const url = resource.git_remote_url;
  for (const prefix of REMOTE_URL_PREFIXES) {
    if (url.startsWith(prefix)) return null;
  }
  return canonicalPath(url);
}

/**
 * Validate that a resolved resource is a local OpenTasks directory.
 */
function validateOpenTasksResource(
  resource: SyncableResource,
  agentId: string,
  label: string,
): string {
  if (!resourcesDAL.canAccessResource(agentId, resource)) {
    throw new OpenTasksRequestError(-32003, `Access denied to resource: ${label}`);
  }

  const meta = resource.metadata as Record<string, unknown> | null;
  if (resource.resource_type !== 'task' || !meta?.opentasks) {
    throw new OpenTasksRequestError(-32602, `Resource is not an OpenTasks resource: ${label}`);
  }

  const localPath = resolveLocalPath(resource);
  if (!localPath) {
    throw new OpenTasksRequestError(-32002, `Resource is not local to this instance: ${label}`);
  }

  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new OpenTasksRequestError(-32001, `Resource path does not exist: ${label}`);
  }

  return localPath;
}

/**
 * Check if a path is a valid .opentasks directory (has config.json or graph.jsonl).
 */
function isValidOpenTasksDir(dirPath: string): boolean {
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return false;
  return existsSync(join(dirPath, 'config.json')) || existsSync(join(dirPath, 'graph.jsonl'));
}

/**
 * Read metadata from an .opentasks directory for auto-registration.
 */
function readOpenTasksMeta(opentasksDir: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { opentasks: true };
  const configPath = join(opentasksDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.location?.hash) meta.location_hash = config.location.hash;
      if (config.location?.name) meta.location_name = config.location.name;
    } catch { /* ignore parse errors */ }
  }
  return meta;
}

/**
 * Auto-register a local .opentasks directory as a syncable resource.
 * Called when an agent provides a path that doesn't match any existing resource.
 */
function autoRegisterResource(opentasksPath: string, agentId: string): SyncableResource {
  const meta = readOpenTasksMeta(opentasksPath);
  const { resource } = resourcesDAL.upsertDiscoveredResource({
    resource_type: 'task',
    name: `auto/${opentasksPath.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 60)}`,
    description: `Auto-registered OpenTasks store at ${opentasksPath}`,
    git_remote_url: opentasksPath,
    visibility: 'private',
    owner_agent_id: agentId,
    scope: 'agent',
    metadata: meta,
  });
  return resource;
}

/**
 * Resolve a resource from resource_id, path, or location_hash.
 * Priority: resource_id > path > location_hash.
 *
 * - resource_id: direct lookup by OpenHive ID (instance-local)
 * - path: lookup by local filesystem path (resolves symlinks), auto-registers if new
 * - location_hash: lookup by OpenTasks location hash (stable across instances)
 */
function resolveResource(
  params: OpenTasksResourceTarget,
  agentId: string,
): { resource: SyncableResource; localPath: string } {
  // Strategy 1: resolve by resource_id (existing behavior)
  if (params.resource_id) {
    const resource = resourcesDAL.findResourceById(params.resource_id);
    if (!resource) {
      throw new OpenTasksRequestError(-32001, `Resource not found: ${params.resource_id}`);
    }
    const localPath = validateOpenTasksResource(resource, agentId, params.resource_id);
    return { resource, localPath };
  }

  // Strategy 2: resolve by path (canonicalized via realpath)
  if (params.path) {
    const normalizedPath = canonicalPath(params.path);

    // Check the path itself, and also check if it's a parent containing .opentasks/
    let opentasksPath = normalizedPath;
    if (!isValidOpenTasksDir(normalizedPath)) {
      const nested = join(normalizedPath, '.opentasks');
      if (isValidOpenTasksDir(nested)) {
        opentasksPath = canonicalPath(nested);
      } else {
        throw new OpenTasksRequestError(-32001, `No valid .opentasks directory at path: ${params.path}`);
      }
    }

    // Try to find an existing resource matching this path
    const existing = resourcesDAL.findResourceByLocalPath(opentasksPath, agentId, 'task');
    if (existing) {
      const localPath = validateOpenTasksResource(existing, agentId, params.path);
      return { resource: existing, localPath };
    }

    // Auto-register the resource for this agent
    const resource = autoRegisterResource(opentasksPath, agentId);
    const localPath = validateOpenTasksResource(resource, agentId, params.path);
    return { resource, localPath };
  }

  // Strategy 3: resolve by OpenTasks location hash (stable across instances)
  if (params.location_hash) {
    const resource = resourcesDAL.findResourceByLocationHash(params.location_hash, agentId, 'task');
    if (!resource) {
      throw new OpenTasksRequestError(-32001, `Resource not found with location_hash: ${params.location_hash}`);
    }
    const localPath = validateOpenTasksResource(resource, agentId, params.location_hash);
    return { resource, localPath };
  }

  throw new OpenTasksRequestError(-32602, 'Invalid params: missing resource_id, path, or location_hash');
}

// ============================================================================
// Request Context
// ============================================================================

export interface OpenTasksRequestContext {
  swarmId: string;
  agentId: string;
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle a map/opentasks/* JSON-RPC request.
 * Returns the result object on success, throws OpenTasksRequestError on error.
 */
export async function handleOpenTasksRequest(
  method: string,
  params: unknown,
  context: OpenTasksRequestContext,
): Promise<OpenTasksSummaryResult | OpenTasksReadyResult | OpenTasksQueryResult | OpenTasksStatusResult> {
  switch (method) {
    case MAP_OPENTASKS_METHODS.SUMMARY: {
      const p = params as OpenTasksSummaryParams;
      const { localPath } = resolveResource(p ?? {}, context.agentId);
      const client = new OpenHiveOpenTasksClient(localPath);
      await client.connectDaemon();
      try {
        const summary = await client.getGraphSummary();
        return { ...summary, daemon_connected: client.connected };
      } finally {
        client.disconnect();
      }
    }

    case MAP_OPENTASKS_METHODS.READY: {
      const p = params as OpenTasksReadyParams;
      const { localPath } = resolveResource(p ?? {}, context.agentId);
      const limit = Math.min(Math.max(p?.limit || 50, 1), 200);
      const client = new OpenHiveOpenTasksClient(localPath);
      await client.connectDaemon();
      try {
        const ready = await client.getReady({ limit });
        return { items: ready, total: ready.length, daemon_connected: client.connected };
      } finally {
        client.disconnect();
      }
    }

    case MAP_OPENTASKS_METHODS.QUERY: {
      const p = params as OpenTasksQueryParams;
      const { localPath } = resolveResource(p ?? {}, context.agentId);
      const client = new OpenHiveOpenTasksClient(localPath);
      const connected = await client.connectDaemon();
      try {
        if (!connected) {
          // Fallback: return summary from JSONL when daemon unavailable
          const summary = await client.getGraphSummary();
          return {
            items: [],
            daemon_connected: false,
            _fallback: 'Daemon not running; use map/opentasks/ready for JSONL-based results',
            task_counts: summary.task_counts,
          } as OpenTasksQueryResult & { _fallback: string; task_counts: Record<string, number> };
        }

        const result = await client.queryNodes({
          type: p?.filter?.type || 'task',
          status: p?.filter?.status,
          archived: p?.filter?.archived ?? false,
          limit: Math.min(Math.max(p?.limit || 50, 1), 200),
          offset: p?.offset || 0,
        });

        return {
          items: result?.items || [],
          daemon_connected: true,
        };
      } finally {
        client.disconnect();
      }
    }

    case MAP_OPENTASKS_METHODS.STATUS: {
      const p = params as OpenTasksStatusParams;
      const { localPath } = resolveResource(p ?? {}, context.agentId);
      const client = new OpenHiveOpenTasksClient(localPath);
      const daemonRunning = await client.isDaemonRunning();
      const graphPath = join(localPath, 'graph.jsonl');
      const graphExists = existsSync(graphPath);
      const graphModified = graphExists ? statSync(graphPath).mtime.toISOString() : null;

      return {
        daemon_running: daemonRunning,
        graph_file_exists: graphExists,
        graph_last_modified: graphModified,
      };
    }

    default:
      throw new OpenTasksRequestError(-32601, `Unknown opentasks method: ${method}`);
  }
}
