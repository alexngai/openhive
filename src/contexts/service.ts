/**
 * Contexts Service
 *
 * High-level service for ephemeral shared contexts between swarms.
 * Persists via DAL and broadcasts WebSocket events.
 *
 * Context delivery to swarm agents uses agent-inbox (not MAP notifications).
 * The hub persists the context and broadcasts to local UI; actual delivery
 * to agents happens through agent-inbox's routing layer.
 */

import { broadcastToChannel } from '../realtime/index.js';
import * as coordinationDal from '../db/dal/coordination.js';
import type { SharedContext, CreateContextInput } from './types.js';

export class ContextsService {
  shareContext(hiveId: string, input: CreateContextInput): SharedContext {
    const ctx = coordinationDal.createContext(hiveId, input);

    // Broadcast to local WebSocket channel (UI subscribers)
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
