/**
 * Resource Bridge
 *
 * Enriches SwarmCraft agents with OpenHive resource metadata (memories, skills).
 * Since SwarmCraft has no native resource concept, we attach resource data
 * to the owning agent's stateMetadata.
 */

import { mapHubEvents } from '../map/service.js';
import { listAccessibleResources } from '../db/dal/syncable-resources.js';
import { agentIdFromSwarm } from './constants.js';
import type { BridgeContext } from './types.js';

interface ResourceBridgeHandle {
  teardown(): void;
}

export async function setupResourceBridge(ctx: BridgeContext): Promise<ResourceBridgeHandle> {
  const listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  function on(event: string, fn: (...args: unknown[]) => void) {
    mapHubEvents.on(event, fn);
    listeners.push({ event, fn });
  }

  // ── Real-time: resource published ────────────────────────────────────

  on('resource_published', async (e: unknown) => {
    const ev = e as { resource_id: string; resource_type: string; name: string; owner_agent_id: string };
    if (ev.resource_type !== 'memory_bank' && ev.resource_type !== 'skill') return;
    await enrichAgentResources(ctx, ev.owner_agent_id);
  });

  on('resource_updated', async (e: unknown) => {
    const ev = e as { resource_id: string; owner_agent_id: string };
    await enrichAgentResources(ctx, ev.owner_agent_id);
  });

  on('resource_synced', async (e: unknown) => {
    const ev = e as { resource_id: string; pusher_agent_id: string };
    await enrichAgentResources(ctx, ev.pusher_agent_id);
  });

  return {
    teardown() {
      for (const { event, fn } of listeners) {
        mapHubEvents.removeListener(event, fn);
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Query OpenHive resources owned by the given agent and update all matching
 * SwarmCraft agents' stateMetadata with a resources summary.
 */
async function enrichAgentResources(ctx: BridgeContext, ownerAgentId: string): Promise<void> {
  try {
    // Fetch memories and skills owned by this agent
    const { data: memories } = listAccessibleResources({
      agentId: ownerAgentId,
      resourceType: 'memory_bank',
      owned: true,
      limit: 50,
    });
    const { data: skills } = listAccessibleResources({
      agentId: ownerAgentId,
      resourceType: 'skill',
      owned: true,
      limit: 50,
    });

    const resourcesSummary = {
      memory_banks: memories.map(r => ({
        id: r.id,
        name: r.name,
        visibility: r.visibility,
        lastPushAt: r.last_push_at,
      })),
      skills: skills.map(r => ({
        id: r.id,
        name: r.name,
        visibility: r.visibility,
        lastPushAt: r.last_push_at,
      })),
    };

    // Find all SC agents that might correspond to this OpenHive agent.
    // Try common ID patterns used by the swarm/node bridges.
    const candidateIds = [
      agentIdFromSwarm(ownerAgentId),
      // Node agents: we don't know the swarm ID here, so we use a
      // broadcast approach — update any agent whose stateMetadata
      // references this ownerAgentId.
    ];

    for (const scAgentId of candidateIds) {
      const existing = await ctx.db.agents.get(scAgentId);
      if (existing) {
        const meta = (existing as { stateMetadata?: Record<string, unknown> }).stateMetadata || {};
        await ctx.db.agents.update(scAgentId, {
          stateMetadata: { ...meta, resources: resourcesSummary },
        });
        ctx.wsHub.broadcast({
          type: 'agent.resources.updated',
          payload: { agentId: scAgentId, resources: resourcesSummary },
        }, 'agents');
      }
    }
  } catch (err) {
    console.warn(`[swarmcraft-bridge] enrichAgentResources failed for ${ownerAgentId}: ${(err as Error).message}`);
  }
}
