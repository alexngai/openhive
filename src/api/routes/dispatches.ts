/**
 * Dispatches Routes
 *
 * Read-side endpoints + cancel for the dispatch primitive. Session bootstrap
 * and outcome reporting are handled by the swarm-dispatch orchestrator
 * (src/dispatch/setup.ts), not by these routes.
 */

import { FastifyInstance } from 'fastify';
import { createAuthOrAdminKey } from '../middleware/auth.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import { broadcastToChannel } from '../../realtime/index.js';
import type {
  DispatchInitiatorType,
  DispatchStatus,
  ListDispatchesOptions,
} from '../../db/dal/dispatches.js';
import type { Config } from '../../config.js';

const VALID_STATUSES: DispatchStatus[] = ['queued', 'running', 'complete', 'failed', 'cancelled'];
const VALID_INITIATORS: DispatchInitiatorType[] = ['user', 'agent'];

function parseStatusParam(raw: string | undefined): DispatchStatus[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is DispatchStatus => (VALID_STATUSES as string[]).includes(s));
  return parts.length > 0 ? parts : undefined;
}

export async function dispatchesRoutes(
  fastify: FastifyInstance,
  options: { config: Config },
): Promise<void> {
  const authOrAdminKey = createAuthOrAdminKey(options.config);
  /**
   * GET /dispatches
   *
   * Lists dispatches with optional filters. Sorted by created_at desc.
   */
  fastify.get<{
    Querystring: {
      status?: string;
      target_swarm_id?: string;
      spec_resource_id?: string;
      spec_id?: string;
      initiator_id?: string;
      initiator_type?: string;
      limit?: number;
      offset?: number;
    };
  }>('/dispatches', { preHandler: authOrAdminKey }, async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(request.query.offset) || 0, 0);

    const opts: ListDispatchesOptions = { limit, offset };
    const status = parseStatusParam(request.query.status);
    if (status) opts.status = status;
    if (request.query.target_swarm_id) opts.target_swarm_id = request.query.target_swarm_id;
    if (request.query.spec_resource_id) opts.spec_resource_id = request.query.spec_resource_id;
    if (request.query.spec_id) opts.spec_id = request.query.spec_id;
    if (request.query.initiator_id) opts.initiator_id = request.query.initiator_id;
    if (
      request.query.initiator_type &&
      (VALID_INITIATORS as string[]).includes(request.query.initiator_type)
    ) {
      opts.initiator_type = request.query.initiator_type as DispatchInitiatorType;
    }

    const result = dispatchesDAL.listDispatches(opts);

    return reply.send({ data: result.data, total: result.total, limit, offset });
  });

  /**
   * GET /dispatches/:id
   */
  fastify.get<{
    Params: { id: string };
  }>('/dispatches/:id', { preHandler: authOrAdminKey }, async (request, reply) => {
    const dispatch = dispatchesDAL.findDispatchById(request.params.id);
    if (!dispatch) {
      return reply.status(404).send({ error: 'Not Found', message: 'Dispatch not found' });
    }
    const linked_tasks = dispatchesDAL.getDispatchLinkedTasks(request.params.id);
    return reply.send({ dispatch, linked_tasks });
  });

  /**
   * POST /dispatches/:id/cancel
   *
   * Marks a dispatch as cancelled (D14). v1 does NOT proactively notify the
   * target swarm to stop work — that requires the agent feedback contract from
   * D11 to be in place on the receiver side. Once the contract matures we can
   * layer a `map/dispatches/cancel` notification in.
   *
   * Open to any authenticated agent (per D9). The operation is idempotent
   * relative to terminal states — cancelling a complete/failed/cancelled
   * dispatch returns 409.
   */
  fastify.post<{
    Params: { id: string };
  }>('/dispatches/:id/cancel', { preHandler: authOrAdminKey }, async (request, reply) => {
    const existing = dispatchesDAL.findDispatchById(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: 'Not Found', message: 'Dispatch not found' });
    }
    if (existing.status === 'cancelled') {
      return reply.status(200).send({ dispatch: existing });
    }
    if (existing.status === 'complete' || existing.status === 'failed') {
      return reply.status(409).send({
        error: 'Conflict',
        message: `Dispatch is already ${existing.status}; cannot cancel`,
      });
    }

    const cancelled = dispatchesDAL.cancelDispatch(request.params.id);
    if (!cancelled) {
      return reply.status(500).send({ error: 'Internal Error', message: 'Cancel failed' });
    }

    try {
      broadcastToChannel('map:dispatches', {
        type: 'dispatch.cancelled',
        data: {
          dispatch: { id: cancelled.id, status: cancelled.status },
          spec_ref: {
            resource_id: cancelled.spec_resource_id,
            spec_id: cancelled.spec_id,
            captured_at: cancelled.spec_captured_at,
          },
          target_swarm_id: cancelled.target_swarm_id,
          initiator: { type: cancelled.initiator_type, id: cancelled.initiator_id },
          cancelled_by: request.agent
            ? { type: 'user', id: request.agent.id }
            : { type: 'operator', id: 'admin-key' },
        },
      });
    } catch {
      /* best effort */
    }

    return reply.send({ dispatch: cancelled });
  });

}
