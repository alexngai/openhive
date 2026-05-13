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
import { MAP_DISPATCH_METHOD_SET, handleDispatchRequest, MAPDispatchRequestError } from './dispatch-handler.js';
import { MAP_SCHEDULE_METHOD_SET, handleScheduleRequest, MAPScheduleRequestError } from './schedule-handler.js';
import { TRAJECTORY_METHOD_SET } from './trajectory-types.js';
import { handleTrajectoryRequest, TrajectoryRequestError } from './trajectory-handler.js';
import { CASCADE_METHOD_SET, CascadeRequestError } from './cascade-types.js';
import { handleCascadeRequest } from './cascade-handler.js';
import { consumeCascadeToken } from './cascade-rate-limit.js';
import { SPAWN_METHOD, handleSpawnRequest } from './spawn-handler.js';
import {
  getOpenteamsMapHandlers,
  getOpenteamsResourceKinds,
  setOpenteamsBundleEmitter,
} from '../openteams/map-handlers.js';
import {
  registerRepoHandlers,
  type RepoMethodServer,
  type RepoHandlerContext,
  type WorkspaceCapability,
} from 'agent-workspace/kinds/repo';
import { OpenHiveRepoHandler } from './workspace-handler.js';
import { handleResourceList, handleResourceGet, getAdvertisedKinds } from './resource-handler.js';
import type { Config } from '../config.js';

/**
 * Register the four `x-workspace/repo.*` methods on `handlers` by wrapping
 * `agent-workspace/kinds/repo`'s `registerRepoHandlers` with a tiny shim that
 * extracts `agentId`/`swarmId` from openhive's session-based context.
 *
 * The package's `RepoHandlerContext` ({ agentId, swarmId, capabilities? })
 * is built from `ctx.session?.metadata?.{swarmId, agentId, ...}`. Calls
 * without authenticated agent + swarm are rejected with -32004.
 */
function registerRepoMethods(
  handlers: Record<string, (params: any, ctx: any) => Promise<any>>,
): void {
  const repoHandler = new OpenHiveRepoHandler();
  const adapter: RepoMethodServer = {
    addHandler(method, fn) {
      handlers[method] = async (params: any, ctx: any) => {
        const swarmId = ctx.session?.metadata?.swarmId;
        const agentId = ctx.session?.metadata?.agentId
          || ctx.session?.metadata?.hubAgentId;
        if (!agentId || !swarmId) {
          throw Object.assign(
            new Error(`${method} requires authenticated agent + swarm context`),
            { code: -32004 },
          );
        }
        const capabilities = ctx.session?.metadata?.workspaceCapability as
          | WorkspaceCapability
          | undefined;
        const repoCtx: RepoHandlerContext = { agentId, swarmId, ...(capabilities && { capabilities }) };
        return fn(params, repoCtx);
      };
    },
  };
  registerRepoHandlers(adapter, repoHandler);
}

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
/**
 * Build the additionalHandlers map passed to `new MAPServer({...})`. Exported
 * for the shape-check test in `src/__tests__/scheduler/map-registration.test.ts`
 * (and as a hook for any future test that wants to verify a method is wired).
 */
export function buildAdditionalHandlers(config: Config): Record<string, (params: any, ctx: any) => Promise<any>> {
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

  // ── MAP Dispatch Methods (Stream 2 D11 — agent feedback channel) ─
  for (const method of MAP_DISPATCH_METHOD_SET) {
    handlers[method] = async (params: any, ctx: any) => {
      const swarmId = ctx.session?.metadata?.swarmId;
      const agentId = ctx.session?.metadata?.agentId;
      try {
        return await handleDispatchRequest(method, params, { swarmId, agentId });
      } catch (err) {
        if (err instanceof MAPDispatchRequestError) {
          throw Object.assign(new Error(err.message), { code: err.code });
        }
        throw err;
      }
    };
  }

  // ── MAP Schedule Methods (cron-style recurring dispatches) ──────
  for (const method of MAP_SCHEDULE_METHOD_SET) {
    handlers[method] = async (params: any, ctx: any) => {
      const swarmId = ctx.session?.metadata?.swarmId;
      // MAP SDK convention: the session's owning-agent id lives at
      // metadata.hubAgentId, NOT metadata.agentId. The sibling handler
      // blocks above (specs/tasks/dispatches) read `agentId` and "work"
      // only because their handlers don't strictly require the value;
      // schedules MUST persist initiator_id and would silently bind
      // null otherwise (caught by map-live-wire.test.ts).
      const agentId = ctx.session?.metadata?.hubAgentId;
      try {
        return await handleScheduleRequest(method, params, {
          swarmId,
          agentId,
          maxSchedulesPerAgent: config.scheduler.maxSchedulesPerAgent,
        });
      } catch (err) {
        if (err instanceof MAPScheduleRequestError) {
          throw Object.assign(new Error(err.message), { code: err.code });
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

  // ── Cascade Methods (x-cascade/*) ─────────────────────────────────
  // Emitted by git-cascade-backed runtimes. The hub projects these events
  // into lightweight read-only indexes for cross-swarm observability.
  for (const method of CASCADE_METHOD_SET) {
    handlers[method] = async (params: any, ctx: any) => {
      const swarmId = ctx.session?.metadata?.swarmId;
      const agentId = ctx.session?.metadata?.agentId || ctx.session?.metadata?.hubAgentId;
      // Reject before dispatch if this swarm has exhausted its token bucket.
      // -32005 is outside MAP's reserved JSON-RPC range, reserved here for
      // "server throttled — back off and retry".
      if (!consumeCascadeToken(swarmId ?? '')) {
        throw Object.assign(
          new Error(`Cascade rate limit exceeded for swarm ${swarmId}`),
          { code: -32005 },
        );
      }
      try {
        return handleCascadeRequest(method, params, { swarmId, agentId });
      } catch (err) {
        if (err instanceof CascadeRequestError) {
          throw Object.assign(new Error(err.message), { code: err.code });
        }
        throw err;
      }
    };
  }

  // ── MAP Resource Protocol (map/resources/*) ──────────────────────
  handlers['map/resources/list'] = handleResourceList;
  handlers['map/resources/get'] = handleResourceGet;

  // ── Repo Methods (x-workspace/repo.*) ────────────────────────────
  // OpenHive consumer-side adapter for `agent-workspace/kinds/repo`. The
  // package owns the wire format and dispatch; OpenHive supplies persistence
  // (repos + workspaces DALs) + realtime fan-out via the OpenHiveRepoHandler.
  registerRepoMethods(handlers);

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

  // ── map/agents/spawn — native MAP delegation primitive ─────────
  // Overrides the ts-sdk's built-in spawn handler because:
  //   1. The SDK's built-in uses an in-memory AgentRegistry; OpenHive
  //      uses its DB `agents` table for agent persistence.
  //   2. The SDK's built-in only wires delegation when MAPServer is
  //      configured with an AuthManager, which OpenHive doesn't use
  //      (we have a custom OpenHiveIAMAuthenticator instead).
  // Our handler does the scope check, creates the DB agent row, and
  // mints a delegated credential via delegateForSpawn.
  //
  // See docs/RFC_AGENT_CAPABILITIES.md v4.
  handlers[SPAWN_METHOD] = async (params: any, ctx: any) => {
    // ws-map.ts stores the connection's swarm + hub agent under these
    // metadata keys when it calls `mapServer.accept(...)`.
    const swarmId = ctx.session?.metadata?.swarmId;
    const hubAgentId = ctx.session?.metadata?.hubAgentId;
    if (!swarmId || !hubAgentId) {
      throw Object.assign(
        new Error('spawn requires an authenticated MAP session'),
        { code: -32000 },
      );
    }
    return await handleSpawnRequest(params, { swarmId, hubAgentId });
  };

  // ── OpenTeams Resource Protocol (map/resources/*) ─────────────────
  // Layer 2 of the openteams MAP-sync integration: expose
  // `x-openteams/loadout` and `x-openteams/team` as content-addressed
  // resources fetched by `sha256:<hex>` id. Composed handler factories
  // come from the openteams package; the bundle store is an in-memory
  // singleton seeded on boot from `syncable_resources` (see
  // `src/openteams/seed.ts`).
  //
  // Today openhive doesn't ship its own `map/resources/list`/`get`, so
  // the composed dispatcher owns both methods. When openhive grows its
  // own resource kinds, pass them as the `fallback` option to
  // openteams's `composeResourceHandlers` — the cooperative shape is
  // already in place upstream.
  const openteamsComposed = getOpenteamsMapHandlers();
  for (const [method, handler] of Object.entries(openteamsComposed.handlers)) {
    handlers[method] = handler as (params: any, ctx: any) => Promise<any>;
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

  const additionalHandlers = buildAdditionalHandlers(config);
  const openteamsKinds = getOpenteamsResourceKinds();

  mapServer = new MAPServer({
    name: config.instance.name || 'OpenHive',
    version: '0.1.0',
    additionalHandlers,
    // Advertise resource kinds so connected agents can discover them via
    // the standard MAP capability handshake. Merges native MAP advertised
    // kinds (per the resource handler) with the openteams kinds the
    // hub serves over the bundle store.
    resources: {
      enabled: true,
      kinds: [...getAdvertisedKinds(), ...openteamsKinds],
    },
    ...(isVerified
      ? {
          auth: {
            required: true,
            authenticators: [new OpenHiveIAMAuthenticator()],
          },
        }
      : {}),
  });

  // Bridge openteams kind-handler lifecycle events to the MAP server's
  // event bus, so subscribers of `resource.added/updated/removed` on
  // `x-openteams/*` types receive the same shape as native MAP resource
  // events (matches `docs/map-integration.md:103-115`).
  setOpenteamsBundleEmitter((event) => {
    try {
      mapServer.eventBus?.emit({
        type: event.type,
        data: {
          resource_type: event.resource_type,
          resource_id: event.resource_id,
          resource_name: event.resource_name,
          origin_hub_id: event.origin_hub_id,
          timestamp: event.timestamp,
        },
      });
    } catch (err) {
      // Best-effort: missing event bus shouldn't crash the publish path.
      console.warn('[openteams] failed to emit bundle event', (err as Error).message);
    }
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
  setOpenteamsBundleEmitter(null);
  if (mapServer) {
    try { mapServer.close({ force: true }); } catch { /* ignore */ }
  }
  mapServer = null;
}
