/**
 * MAP OpenTasks Request Handler
 *
 * Handles map/opentasks/* JSON-RPC 2.0 requests from MAP-connected agents.
 * Resolves the target resource, validates access, and proxies to the local
 * OpenTasks daemon (or JSONL fallback).
 */

import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAP_OPENTASKS_METHODS } from './opentasks-types.js';
import type {
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

function resolveLocalPath(resource: SyncableResource): string | null {
  const url = resource.git_remote_url;
  for (const prefix of REMOTE_URL_PREFIXES) {
    if (url.startsWith(prefix)) return null;
  }
  return resolve(url);
}

function resolveResource(resourceId: string, agentId: string): { resource: SyncableResource; localPath: string } {
  const resource = resourcesDAL.findResourceById(resourceId);
  if (!resource) {
    throw new OpenTasksRequestError(-32001, `Resource not found: ${resourceId}`);
  }

  if (!resourcesDAL.canAccessResource(agentId, resource)) {
    throw new OpenTasksRequestError(-32003, `Access denied to resource: ${resourceId}`);
  }

  const meta = resource.metadata as Record<string, unknown> | null;
  if (resource.resource_type !== 'task' || !meta?.opentasks) {
    throw new OpenTasksRequestError(-32602, `Resource is not an OpenTasks resource: ${resourceId}`);
  }

  const localPath = resolveLocalPath(resource);
  if (!localPath) {
    throw new OpenTasksRequestError(-32002, `Resource is not local to this instance: ${resourceId}`);
  }

  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new OpenTasksRequestError(-32001, `Resource path does not exist: ${resourceId}`);
  }

  return { resource, localPath };
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
      if (!p?.resource_id) {
        throw new OpenTasksRequestError(-32602, 'Invalid params: missing resource_id');
      }
      const { localPath } = resolveResource(p.resource_id, context.agentId);
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
      if (!p?.resource_id) {
        throw new OpenTasksRequestError(-32602, 'Invalid params: missing resource_id');
      }
      const limit = Math.min(Math.max(p.limit || 50, 1), 200);
      const { localPath } = resolveResource(p.resource_id, context.agentId);
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
      if (!p?.resource_id) {
        throw new OpenTasksRequestError(-32602, 'Invalid params: missing resource_id');
      }
      const { localPath } = resolveResource(p.resource_id, context.agentId);
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
          type: p.filter?.type || 'task',
          status: p.filter?.status,
          archived: p.filter?.archived ?? false,
          limit: Math.min(Math.max(p.limit || 50, 1), 200),
          offset: p.offset || 0,
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
      if (!p?.resource_id) {
        throw new OpenTasksRequestError(-32602, 'Invalid params: missing resource_id');
      }
      const { localPath } = resolveResource(p.resource_id, context.agentId);
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
