/**
 * MAP Spec Request Handler
 *
 * Handles `map/specs/*` MAP protocol methods. Mirrors `task-handler.ts`
 * but for spec authoring. Per D9 the hub does not gate per-agent — any
 * registered MAP agent can author. The agent's `agentId` is recorded
 * as the dispatch initiator on every action via the broadcast event.
 */

import * as resourcesDAL from '../db/dal/syncable-resources.js';
import { resolveLocalPath } from '../api/routes/_resource-helpers.js';
import { daemonCreateSpec, resolveDaemonSocket, TaskDaemonError } from './task-daemon-client.js';
import { dispatchSpecToSwarms } from '../api/routes/specs.js';
import { isAutonomousDispatchPaused } from './dispatch-policy.js';

// ============================================================================
// Method Constants
// ============================================================================

export const MAP_SPEC_METHODS = {
  AUTHOR: 'map/specs/author',
  DISPATCH: 'map/specs/dispatch',
} as const;

export const MAP_SPEC_METHOD_SET = new Set<string>(Object.values(MAP_SPEC_METHODS));

// ============================================================================
// Errors
// ============================================================================

export class MAPSpecRequestError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = 'MAPSpecRequestError';
  }
}

// Re-export for consumers
export { TaskDaemonError };

// ============================================================================
// Context
// ============================================================================

export interface SpecRequestContext {
  swarmId: string;
  agentId: string;
}

// ============================================================================
// Handler
// ============================================================================

export async function handleSpecRequest(
  method: string,
  params: unknown,
  context: SpecRequestContext,
): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    case MAP_SPEC_METHODS.AUTHOR: {
      const resourceId = p.resource_id as string | undefined;
      const spec = p.spec as Record<string, unknown> | undefined;
      if (!resourceId) {
        throw new MAPSpecRequestError(-32602, 'Invalid params: missing resource_id');
      }
      if (!spec || typeof spec !== 'object') {
        throw new MAPSpecRequestError(-32602, 'Invalid params: missing spec object');
      }
      if (typeof spec.title !== 'string' || spec.title.length === 0) {
        throw new MAPSpecRequestError(-32602, 'Invalid params: spec.title must be a non-empty string');
      }

      const resource = resourcesDAL.findResourceById(resourceId);
      if (!resource) throw new MAPSpecRequestError(-32001, 'Resource not found');
      if (!resourcesDAL.canAccessResource(context.agentId, resource)) {
        throw new MAPSpecRequestError(-32001, 'No access to resource');
      }
      const meta = resource.metadata as Record<string, unknown> | null;
      if (resource.resource_type !== 'task' || !meta?.opentasks) {
        throw new MAPSpecRequestError(-32001, 'Resource is not an OpenTasks task graph');
      }

      const localPath = resolveLocalPath(resource);
      if (!localPath) {
        throw new MAPSpecRequestError(
          -32003,
          'Spec authoring requires a local opentasks daemon for the target resource',
        );
      }

      const node = await daemonCreateSpec(
        resolveDaemonSocket(localPath),
        {
          title: spec.title,
          content: typeof spec.content === 'string' ? spec.content : undefined,
          priority: typeof spec.priority === 'number' ? spec.priority : undefined,
        },
        localPath,
      );

      // Broadcast for hub WS subscribers (frontend invalidation).
      // Reuses the existing `map:tasks` channel — specs and tasks are both
      // opentasks graph nodes, so subscribing surfaces share the same channel.
      try {
        const { broadcastToChannel } = await import('../realtime/index.js');
        broadcastToChannel('map:tasks', {
          type: 'spec.created',
          data: {
            spec: { id: (node as Record<string, unknown>).id, title: (node as Record<string, unknown>).title },
            resource_id: resourceId,
            initiator: { type: 'agent', id: context.agentId },
          },
        });
      } catch {
        /* best effort */
      }

      return { spec: node };
    }

    case MAP_SPEC_METHODS.DISPATCH: {
      // Per D9 we don't gate per-agent capability. The single safety net is
      // the global kill switch (D9 retrofit path) — when toggled on, agent-
      // initiated dispatches are refused while user-initiated dispatches via
      // REST continue. Restarts default the toggle back to "not paused."
      if (isAutonomousDispatchPaused()) {
        throw new MAPSpecRequestError(
          -32004,
          'Autonomous dispatch is paused by hub admin. User-initiated dispatch via REST is unaffected.',
        );
      }

      const resourceId = p.resource_id as string | undefined;
      const specId = p.spec_id as string | undefined;
      const targetSwarmsRaw = p.target_swarms;
      const prompt = typeof p.prompt === 'string' ? (p.prompt as string) : undefined;

      if (!resourceId) {
        throw new MAPSpecRequestError(-32602, 'Invalid params: missing resource_id');
      }
      if (!specId) {
        throw new MAPSpecRequestError(-32602, 'Invalid params: missing spec_id');
      }
      if (!Array.isArray(targetSwarmsRaw) || targetSwarmsRaw.length === 0) {
        throw new MAPSpecRequestError(
          -32602,
          'Invalid params: target_swarms must be a non-empty array',
        );
      }
      const targetSwarms = targetSwarmsRaw.filter((s): s is string => typeof s === 'string');
      if (targetSwarms.length === 0) {
        throw new MAPSpecRequestError(
          -32602,
          'Invalid params: target_swarms entries must be strings',
        );
      }

      const result = await dispatchSpecToSwarms({
        resourceId,
        specId,
        agentId: context.agentId,
        initiatorType: 'agent',
        targetSwarms,
        prompt,
      });

      if (!result.ok) {
        // Map fetchSpecForDispatch / swarm-not-found / unreachable error codes to JSON-RPC.
        // 503 (no transport) → -32003 (server error, non-retryable for the caller)
        const codeMap: Record<number, number> = {
          404: -32001,
          403: -32001,
          400: -32602,
          503: -32003,
        };
        const rpcCode = codeMap[result.statusCode] ?? -32000;
        throw new MAPSpecRequestError(rpcCode, result.message);
      }

      return { dispatches: result.dispatches };
    }

    default:
      throw new MAPSpecRequestError(-32601, `Unknown method: ${method}`);
  }
}
