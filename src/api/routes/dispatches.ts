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
import {
  materializeLoadoutById,
  LoadoutBundleNotFoundError,
} from '../../openteams/loadout-materializer.js';
import { getMailJsonRpc } from '../../mail/index.js';
import { ensureDispatchConversation } from '../../dispatch/dispatch-conversation.js';
import { findSwarmById } from '../../db/dal/map.js';
import { getInbound, getInboundIncludingStale } from '../../map/connection-registry.js';
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
   * GET /dispatches/:id/loadout
   *
   * Materialized openteams loadout artifact for a dispatch — the
   * permissions / mcpServers / prompt addendum the runtime would inject.
   *
   * Used by swarm sidecars to fetch the loadout's permission rules and
   * apply them locally (write `.claude/settings.local.json`, etc.). The
   * hub doesn't enforce permissions; the consumer policy lives at the
   * runtime per openteams's design (see `team-map-sync-design.md` §"Trust").
   *
   * Returns 200 + `{ materialized: null }` when the dispatch has no
   * loadout binding, or 200 + `{ materialized: MaterializedLoadout }` when
   * a bundle was pinned and resolved successfully. 404 if the dispatch is
   * unknown; 410 if the pinned bundle is missing from the store.
   */
  fastify.get<{ Params: { id: string } }>(
    '/dispatches/:id/loadout',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const dispatch = dispatchesDAL.findDispatchById(request.params.id);
      if (!dispatch) {
        return reply.status(404).send({ error: 'Not Found', message: 'Dispatch not found' });
      }
      if (!dispatch.loadout_bundle_id) {
        return reply.send({
          materialized: null,
          team_bundle_id: dispatch.team_bundle_id,
          role: dispatch.role,
        });
      }
      try {
        const materialized = await materializeLoadoutById(dispatch.loadout_bundle_id);
        return reply.send({
          materialized,
          team_bundle_id: dispatch.team_bundle_id,
          role: dispatch.role,
        });
      } catch (err) {
        if (err instanceof LoadoutBundleNotFoundError) {
          return reply.status(410).send({
            error: 'Gone',
            message: `Pinned loadout bundle ${dispatch.loadout_bundle_id} no longer in store`,
          });
        }
        throw err;
      }
    },
  );

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

  /**
   * POST /dispatches/:id/thread/turns
   *
   * User posts a message to the dispatch coordination thread. Lazily creates
   * the conversation on first message. Returns the conversation_id so the
   * frontend can subscribe to updates.
   *
   * Body: { content: string }
   */
  fastify.post<{
    Params: { id: string };
    Body: { content: string; importance?: string };
  }>('/dispatches/:id/thread/turns', { preHandler: authOrAdminKey }, async (request, reply) => {
    const dispatch = dispatchesDAL.findDispatchById(request.params.id);
    if (!dispatch) {
      return reply.status(404).send({ error: 'Not Found', message: 'Dispatch not found' });
    }
    if (dispatch.status === 'cancelled') {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Dispatch is cancelled',
      });
    }

    const content = request.body?.content;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.status(400).send({ error: 'Bad Request', message: 'content is required' });
    }

    // Resolve user identity
    const userId = request.agent?.id ?? 'user:admin-key';

    // Resolve executor from latest running attempt
    const currentAttempt = dispatch.attempts_history
      .filter((a) => a.status === 'running')
      .pop();
    const executorAgentId = currentAttempt?.agent_id ?? `executor-${dispatch.target_swarm_id}`;

    // Resolve swarm name for conversation subject
    const swarm = findSwarmById(dispatch.target_swarm_id);
    const swarmName = swarm?.name ?? dispatch.target_swarm_id;

    try {
      const linkedTasks = dispatchesDAL.getDispatchLinkedTasks(dispatch.id);
      const conversationId = await ensureDispatchConversation(
        {
          dispatchId: dispatch.id,
          specId: dispatch.spec_id ?? '',
          specResourceId: dispatch.spec_resource_id ?? '',
          specTitle: dispatch.spec_id ? `Spec ${dispatch.spec_id}` : `Dispatch ${dispatch.id}`,
          targetSwarmId: dispatch.target_swarm_id,
          swarmName,
          linkedTasks,
          initiator: { type: dispatch.initiator_type, id: dispatch.initiator_id },
          executorAgentId,
        },
        { getMailJsonRpc },
      );

      // Add the user's turn — default to 'high' importance for user-posted
      // dispatch thread messages since they typically expect a reply.
      const mailRpc = getMailJsonRpc();
      const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const validImportance = ['low', 'normal', 'high', 'urgent'];
      const turnImportance =
        typeof request.body.importance === 'string' && validImportance.includes(request.body.importance)
          ? request.body.importance
          : 'high';
      await mailRpc.handleRequest({
        jsonrpc: '2.0',
        id: turnId,
        method: 'mail/turn',
        params: {
          conversationId,
          participantId: userId,
          content: content.trim(),
          contentType: 'text',
          importance: turnImportance,
        },
      } as Parameters<typeof mailRpc.handleRequest>[0]);

      // Broadcast to WS subscribers
      try {
        broadcastToChannel('map:dispatches', {
          type: 'dispatch.thread.turn',
          data: {
            dispatch_id: dispatch.id,
            conversation_id: conversationId,
            sender: userId,
            content_preview: content.length > 200 ? content.slice(0, 200) + '...' : content,
          },
        });
      } catch { /* best effort */ }

      return reply.status(201).send({
        conversation_id: conversationId,
        dispatch_id: dispatch.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to post thread turn';
      return reply.status(500).send({ error: 'Internal Error', message });
    }
  });

  /**
   * GET /dispatches/:id/thread/presence
   *
   * Returns the participant list for a dispatch's coordination thread,
   * enriched with live presence status from the MAP connection registry.
   *
   * Presence values:
   * - `online`  — the agent's swarm has an active MAP connection
   * - `stale`   — the swarm WS closed but metadata is retained (reconnect window)
   * - `offline` — no connection found
   */
  fastify.get<{
    Params: { id: string };
  }>('/dispatches/:id/thread/presence', { preHandler: authOrAdminKey }, async (request, reply) => {
    const dispatch = dispatchesDAL.findDispatchById(request.params.id);
    if (!dispatch) {
      return reply.status(404).send({ error: 'Not Found', message: 'Dispatch not found' });
    }
    if (!dispatch.conversation_id) {
      return reply.send({
        dispatch_id: dispatch.id,
        conversation_id: null,
        participants: [],
      });
    }

    // Query conversation participants via mail RPC
    try {
      const mailRpc = getMailJsonRpc();
      const reqId = `presence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const response = (await mailRpc.handleRequest({
        jsonrpc: '2.0',
        id: reqId,
        method: 'mail/presence',
        params: { conversationId: dispatch.conversation_id },
      })) as {
        result?: {
          participants?: Array<{
            agent_id: string;
            role?: string;
            joined_at?: string;
            presence?: string;
          }>;
        };
      };

      const rawParticipants = response?.result?.participants ?? [];

      // Enrich with MAP connection registry presence for more accurate status.
      // The mail/presence method returns registry-based status if a registry
      // was provided; here we overlay MAP-level swarm connectivity which is
      // authoritative for OpenHive's context.
      const participants = rawParticipants.map((p) => {
        let presence: 'online' | 'stale' | 'offline' = 'offline';

        // Check if the agent's swarm has an active connection
        const conn = getInbound(dispatch.target_swarm_id);
        if (conn) {
          presence = 'online';
        } else {
          const stale = getInboundIncludingStale(dispatch.target_swarm_id);
          if (stale) {
            presence = 'stale';
          }
        }

        return {
          agent_id: p.agent_id,
          role: p.role ?? null,
          joined_at: p.joined_at ?? null,
          presence,
        };
      });

      return reply.send({
        dispatch_id: dispatch.id,
        conversation_id: dispatch.conversation_id,
        participants,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to query presence';
      return reply.status(500).send({ error: 'Internal Error', message });
    }
  });

}
