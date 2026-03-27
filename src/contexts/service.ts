/**
 * Contexts Service
 *
 * High-level service for ephemeral shared contexts between swarms.
 * Persists via DAL, delivers JSON-RPC notifications, and broadcasts WebSocket events.
 */

import { sendToSwarm } from '../map/sync-listener.js';
import { broadcastToChannel } from '../realtime/index.js';
import * as coordinationDal from '../db/dal/coordination.js';
import { createCoordinationNotification } from '../coordination/types.js';
import type { SharedContext, CreateContextInput } from './types.js';

export class ContextsService {
  shareContext(hiveId: string, input: CreateContextInput): SharedContext {
    const ctx = coordinationDal.createContext(hiveId, input);

    // Deliver JSON-RPC notification to target swarms
    const targetSwarmIds = input.target_swarm_ids ?? [];
    for (const swarmId of targetSwarmIds) {
      sendToSwarm(
        swarmId,
        createCoordinationNotification('x-openhive/context.share', {
          context_id: ctx.id,
          source_swarm_id: input.source_swarm_id,
          target_swarm_ids: targetSwarmIds,
          hive_id: hiveId,
          context_type: input.context_type,
          data: input.data,
          ttl_seconds: input.ttl_seconds,
        }),
      );
    }

    // Broadcast to local WebSocket channel
    broadcastToChannel(`coordination:${hiveId}`, {
      type: 'context_shared',
      data: ctx,
    });

    return ctx;
  }

  getContext(contextId: string): SharedContext | null {
    return coordinationDal.findContextById(contextId);
  }

  listContexts(
    hiveId: string,
    opts?: { type?: string; swarm_id?: string; limit?: number; offset?: number },
  ): { data: SharedContext[]; total: number } {
    return coordinationDal.listContexts({
      hive_id: hiveId,
      context_type: opts?.type,
      source_swarm_id: opts?.swarm_id,
      limit: opts?.limit,
      offset: opts?.offset,
    });
  }

  cleanupExpiredContexts(): number {
    return coordinationDal.deleteExpiredContexts();
  }
}
