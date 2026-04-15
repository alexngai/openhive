/**
 * MAP Server Setup
 *
 * Initializes and configures the MAPServer singleton from @multi-agent-protocol/sdk.
 * The MAPServer handles standard MAP protocol methods (connect, authenticate,
 * agents/register, etc.) while OpenHive-specific handlers (sync, coordination,
 * trajectory, mail) are registered as additionalHandlers.
 */

// @ts-expect-error — server subpath export has no .d.ts in SDK v0.1.7
import { MAPServer } from '@multi-agent-protocol/sdk/server';
import { verifyToken } from './token-service.js';
import { MAP_TASK_METHOD_SET, handleTaskRequest, MAPTaskRequestError, TaskDaemonError } from './task-handler.js';
import { MAP_SPEC_METHOD_SET, handleSpecRequest, MAPSpecRequestError } from './spec-handler.js';
import { TRAJECTORY_METHOD_SET } from './trajectory-types.js';
import { handleTrajectoryRequest, TrajectoryRequestError } from './trajectory-handler.js';
import type { Config } from '../config.js';

let mapServer: any | null = null;

/**
 * Custom authenticator for x-agent-iam tokens.
 * Wraps the existing verifyToken() service.
 */
class OpenHiveIAMAuthenticator {
  readonly methods = ['x-agent-iam'];

  async authenticate(
    credentials: { method: string; credential?: string; token?: string },
    _context: unknown,
  ) {
    const credential = credentials.credential || credentials.token || '';
    const result = verifyToken(credential);

    if (!result.valid || !result.token) {
      return {
        success: false as const,
        error: {
          code: 'invalid_credentials',
          message: result.error || 'Authentication failed',
        },
      };
    }

    const token = result.token;
    return {
      success: true as const,
      principal: {
        id: token.agentId,
        claims: {
          scopes: token.scopes,
          delegationDepth: token.currentDepth,
        },
        expiresAt: token.expiresAt
          ? new Date(token.expiresAt).getTime()
          : undefined,
      },
    };
  }
}

/**
 * Build additionalHandlers for OpenHive-specific JSON-RPC methods.
 *
 * These methods are NOT standard MAP protocol (no `map/` prefix), so they
 * need to be registered explicitly. The MAPServer's router dispatches by
 * exact method name, so we register each custom method.
 */
function buildAdditionalHandlers(): Record<string, (params: any, ctx: any) => Promise<any>> {
  const handlers: Record<string, (params: any, ctx: any) => Promise<any>> = {};

  // ── MAP Task Methods (standard MAP spec) ────────────────────────
  for (const method of MAP_TASK_METHOD_SET) {
    handlers[method] = async (params: any, ctx: any) => {
      const swarmId = ctx.session?.metadata?.swarmId;
      const agentId = ctx.session?.metadata?.agentId;
      try {
        return await handleTaskRequest(method, params, { swarmId, agentId });
      } catch (err) {
        if (err instanceof MAPTaskRequestError) {
          throw Object.assign(new Error(err.message), { code: err.code });
        } else if (err instanceof TaskDaemonError) {
          const codeMap: Record<string, number> = { DAEMON_NOT_RUNNING: -32003, NOT_FOUND: -32001, OPERATION_FAILED: -32000 };
          const code = codeMap[err.code] ?? -32000;
          throw Object.assign(new Error(err.message), { code });
        }
        throw err;
      }
    };
  }

  // ── MAP Spec Methods ────────────────────────────────────────────
  for (const method of MAP_SPEC_METHOD_SET) {
    handlers[method] = async (params: any, ctx: any) => {
      const swarmId = ctx.session?.metadata?.swarmId;
      const agentId = ctx.session?.metadata?.agentId;
      try {
        return await handleSpecRequest(method, params, { swarmId, agentId });
      } catch (err) {
        if (err instanceof MAPSpecRequestError) {
          throw Object.assign(new Error(err.message), { code: err.code });
        } else if (err instanceof TaskDaemonError) {
          const codeMap: Record<string, number> = { DAEMON_NOT_RUNNING: -32003, NOT_FOUND: -32001, OPERATION_FAILED: -32000 };
          const code = codeMap[err.code] ?? -32000;
          throw Object.assign(new Error(err.message), { code });
        }
        throw err;
      }
    };
  }

  // ── Trajectory Methods ──────────────────────────────────────────
  for (const method of TRAJECTORY_METHOD_SET) {
    handlers[method] = async (params: any, ctx: any) => {
      const swarmId = ctx.session?.metadata?.swarmId;
      const agentId = ctx.session?.metadata?.agentId || ctx.session?.metadata?.hubAgentId;
      try {
        return handleTrajectoryRequest(method, params, { swarmId, agentId });
      } catch (err) {
        if (err instanceof TrajectoryRequestError) {
          throw Object.assign(new Error(err.message), { code: err.code });
        }
        throw err;
      }
    };
  }

  // ── Mail Methods (mail/*) ────────────────────────────────────────
  // We register a catch-all approach via method prefix in the message handler
  // (see ws-map.ts), but also register individual methods if the mail module
  // exposes them. For now, mail is handled at the ws-map notification level.

  // ── Resource Sync Methods (x-openhive/memory.sync, x-openhive/skill.sync) ──
  // These are vendor-prefixed JSON-RPC methods used by swarms to notify
  // the hub that a memory bank or skill resource has been updated.
  // If no resource_id is provided, auto-resolves or creates the resource.
  const SYNC_RESOURCE_TYPES: Record<string, 'memory_bank' | 'skill'> = {
    'x-openhive/memory.sync': 'memory_bank',
    'x-openhive/skill.sync': 'skill',
  };
  const syncMethods = ['x-openhive/memory.sync', 'x-openhive/skill.sync'] as const;
  for (const method of syncMethods) {
    handlers[method] = async (params: any, ctx: any) => {
      const swarmId = ctx.session?.metadata?.swarmId || '';
      const agentId = ctx.session?.metadata?.agentId || ctx.session?.metadata?.hubAgentId || '';
      const resourceType = SYNC_RESOURCE_TYPES[method];

      // Resolve resource_id following the same pattern as opentasks task-handler:
      //   1. Explicit resource_id → use directly
      //   2. By path → findResourceByLocalPath (if path provided by sidecar)
      //   3. By agent ownership → find existing resource owned by this agent
      //   4. Auto-create with local path if available
      let resourceId = params.resource_id;
      if (!resourceId) {
        const dal = await import('../db/dal/syncable-resources.js');
        const resourcePath = params.path || '';

        // 2. By path — if the sidecar sent the memory directory path
        if (resourcePath) {
          const existing = dal.findResourceByLocalPath(resourcePath, agentId, resourceType);
          if (existing) {
            resourceId = existing.id;
          }
        }

        // 3. By agent ownership — find any resource of this type owned by the agent
        if (!resourceId && agentId) {
          const { data: owned } = dal.listAccessibleResources({ agentId, resourceType, owned: true, limit: 1, offset: 0 });
          if (owned.length > 0) {
            resourceId = owned[0].id;
          }
        }

        // 4. Auto-create with the best available metadata
        //    Only set sync_strategy='local' if the path actually exists on this machine.
        //    Remote swarms send their local path which won't be reachable here.
        if (!resourceId) {
          const { existsSync } = await import('node:fs');
          const { resolve } = await import('node:path');
          const typeName = resourceType === 'memory_bank' ? 'minimem-memory' : 'skilltree';
          const isLocallyReachable = resourcePath && existsSync(resolve(resourcePath));
          const { resource } = dal.upsertDiscoveredResource({
            resource_type: resourceType,
            name: `swarm/${swarmId || 'unknown'}/${typeName}`,
            description: `Auto-created from ${method} sync notification`,
            git_remote_url: isLocallyReachable ? resourcePath : `map://${resourceType}/${swarmId || 'unknown'}`,
            owner_agent_id: agentId || 'system',
            scope: isLocallyReachable ? 'agent' : 'manual',
            sync_strategy: isLocallyReachable ? 'local' : 'metadata',
            local_path: isLocallyReachable ? resolve(resourcePath) : undefined,
            metadata: resourceType === 'memory_bank' ? { minimem: true } : undefined,
          });
          resourceId = resource.id;
        }
      }

      // Dispatch to sync listener with resolved resource_id
      params.resource_id = resourceId;
      const { handleSyncMessage } = await import('./sync-listener.js');
      handleSyncMessage({ jsonrpc: '2.0', method, params }, swarmId);
      return { ok: true, resource_id: resourceId };
    };
  }

  // ── Ping/Pong ────────────────────────────────────────────────────
  // Ping is a notification (no id), handled in the notification interceptor.
  // But if sent as a request, handle it here.
  handlers['ping'] = async () => ({ pong: true });

  return handlers;
}

/**
 * Initialize the MAPServer singleton.
 *
 * In verified mode: configures auth with the OpenHiveIAMAuthenticator.
 * In open mode: no auth required (hub access is via query param API key).
 */
export function initMapServer(config: Config): any {
  if (mapServer) return mapServer;

  const isVerified = config.mapHub.trustModel === 'verified';

  const additionalHandlers = buildAdditionalHandlers();

  mapServer = new MAPServer({
    name: config.instance.name || 'OpenHive',
    version: '0.1.0',
    additionalHandlers,
    ...(isVerified
      ? {
          auth: {
            required: true,
            authenticators: [new OpenHiveIAMAuthenticator()],
          },
        }
      : {}),
  });

  return mapServer;
}

/**
 * Get the MAPServer singleton. Throws if not initialized.
 */
export function getMapServer(): any {
  if (!mapServer) throw new Error('MAPServer not initialized — call initMapServer() first');
  return mapServer;
}

/**
 * Reset the MAPServer singleton (for tests).
 */
export function _resetMapServer(): void {
  if (mapServer) {
    try { mapServer.close({ force: true }); } catch { /* ignore */ }
  }
  mapServer = null;
}
