/**
 * Swarm Bridge
 *
 * Projects OpenHive MAP Hub swarms and their nodes into SwarmCraft agents.
 * Each swarm becomes a parent agent; each node becomes a child agent.
 * Also handles the MAP client auto-connect that was previously inline in server.ts.
 */

import { mapHubEvents } from '../map/service.js';
import { listSwarms, discoverNodes } from '../db/dal/map.js';
import {
  agentIdFromSwarm,
  agentIdFromNode,
  mapSwarmStatusToState,
  mapNodeStateToState,
} from './constants.js';
import type { BridgeContext } from './types.js';
import type { MapSwarm } from '../map/types.js';

interface SwarmBridgeHandle {
  teardown(): void;
}

/**
 * Setup the swarm bridge: hydrate existing data, register real-time listeners,
 * and optionally auto-connect SwarmCraft's MAP client to registered swarms.
 */
export async function setupSwarmBridge(
  ctx: BridgeContext,
  mapClientManager?: { connect(opts: Record<string, unknown>): Promise<void> },
): Promise<SwarmBridgeHandle> {
  const listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  function on(event: string, fn: (...args: unknown[]) => void) {
    mapHubEvents.on(event, fn);
    listeners.push({ event, fn });
  }

  // ── Startup hydration ────────────────────────────────────────────────

  const { data: onlineSwarms } = listSwarms({ status: 'online', limit: 500 });
  for (const swarm of onlineSwarms) {
    await hydrateSwarm(ctx, swarm);

    // Auto-connect SwarmCraft MAP client
    if (mapClientManager) {
      await connectMapClient(mapClientManager, swarm);
    }
  }

  // ── Real-time event listeners ────────────────────────────────────────

  on('swarm_registered', async (e: unknown) => {
    const ev = e as { swarm_id: string; name: string; map_endpoint: string; auth_method?: string };
    try {
      const agentId = agentIdFromSwarm(ev.swarm_id);
      // Use the swarm's own ID as mapServerId so SwarmCraft's ACP manager
      // can find the correct MAP ClientConnection via getClient(serverId)
      const serverId = ev.swarm_id;
      await ctx.db.agents.create({
        id: agentId,
        name: ev.name,
        type: 'swarm',
        mapServerId: serverId,
        state: 'active',
        capabilities: ['observation', 'messaging', 'lifecycle'],
        stateMetadata: {
          source: 'openhive-hub',
          swarmId: ev.swarm_id,
          endpoint: ev.map_endpoint,
        },
      });
      ctx.wsHub.broadcastAgentRegistered({ id: agentId, name: ev.name, type: 'swarm' });

      // Auto-connect MAP client to the swarm's MAP endpoint
      if (mapClientManager) {
        await connectMapClient(mapClientManager, {
          id: ev.swarm_id,
          name: ev.name,
          map_endpoint: ev.map_endpoint,
          auth_method: ev.auth_method,
        } as MapSwarm);
      }
    } catch (err) {
      console.warn(`[swarmcraft-bridge] swarm_registered handler failed: ${(err as Error).message}`);
    }
  });

  on('node_registered', async (e: unknown) => {
    const ev = e as { node_id: string; swarm_id: string; map_agent_id: string; name: string | null; role: string | null; state: string };
    try {
      const agentId = agentIdFromNode(ev.swarm_id, ev.map_agent_id);
      const parentAgentId = agentIdFromSwarm(ev.swarm_id);
      const name = ev.name || ev.map_agent_id;
      // Use the swarm's ID as mapServerId so ACP streams route through
      // the correct MAP ClientConnection for this swarm
      const serverId = ev.swarm_id;
      await ctx.db.agents.create({
        id: agentId,
        name,
        type: ev.role || 'agent',
        capabilities: [],
        mapServerId: serverId,
        parentAgentId,
        state: mapNodeStateToState(ev.state),
        stateMetadata: {
          source: 'openhive-hub',
          swarmId: ev.swarm_id,
          mapAgentId: ev.map_agent_id,
        },
      });
      ctx.wsHub.broadcastAgentRegistered({ id: agentId, name, type: ev.role || 'agent' });
    } catch (err) {
      console.warn(`[swarmcraft-bridge] node_registered handler failed: ${(err as Error).message}`);
    }
  });

  on('swarm_offline', async (e: unknown) => {
    const ev = e as { swarm_id: string };
    try {
      const agentId = agentIdFromSwarm(ev.swarm_id);
      const existing = await ctx.db.agents.get(agentId);
      if (existing) {
        const previousState = (existing as { state?: string }).state || 'active';
        await ctx.db.agents.update(agentId, { state: 'stopped' });
        ctx.wsHub.broadcastAgentStateChanged(agentId, previousState, 'stopped');
      }
    } catch (err) {
      console.warn(`[swarmcraft-bridge] swarm_offline handler failed: ${(err as Error).message}`);
    }
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

async function hydrateSwarm(ctx: BridgeContext, swarm: MapSwarm): Promise<void> {
  try {
    const agentId = agentIdFromSwarm(swarm.id);
    const swarmMeta = {
      source: 'openhive-hub',
      swarmId: swarm.id,
      endpoint: swarm.map_endpoint,
      agentCount: swarm.agent_count,
      capabilities: swarm.capabilities,
    };
    const caps = swarm.capabilities
      ? Object.keys(swarm.capabilities).filter(k => (swarm.capabilities as Record<string, unknown>)[k])
      : [];

    // Use the swarm's own ID as mapServerId so SwarmCraft's ACP manager
    // can find the correct MAP ClientConnection via getClient(serverId)
    const serverId = swarm.id;

    const existing = await ctx.db.agents.get(agentId);
    if (existing) {
      await ctx.db.agents.update(agentId, {
        name: swarm.name,
        state: mapSwarmStatusToState(swarm.status),
        mapServerId: serverId,
        stateMetadata: swarmMeta,
      });
    } else {
      await ctx.db.agents.create({
        id: agentId,
        name: swarm.name,
        type: 'swarm',
        mapServerId: serverId,
        state: mapSwarmStatusToState(swarm.status),
        capabilities: caps,
        stateMetadata: swarmMeta,
      });
    }

    // Hydrate nodes
    const { data: nodes } = discoverNodes({ swarm_id: swarm.id, limit: 500 });
    for (const node of nodes) {
      const nodeAgentId = agentIdFromNode(swarm.id, node.map_agent_id);
      const nodeMeta = {
        source: 'openhive-hub',
        swarmId: swarm.id,
        mapAgentId: node.map_agent_id,
      };
      const existingNode = await ctx.db.agents.get(nodeAgentId);
      if (existingNode) {
        await ctx.db.agents.update(nodeAgentId, {
          name: node.name || node.map_agent_id,
          state: mapNodeStateToState(node.state),
          mapServerId: serverId,
          stateMetadata: nodeMeta,
        });
      } else {
        await ctx.db.agents.create({
          id: nodeAgentId,
          name: node.name || node.map_agent_id,
          type: node.role || 'agent',
          capabilities: [],
          mapServerId: serverId,
          parentAgentId: agentId,
          state: mapNodeStateToState(node.state),
          stateMetadata: nodeMeta,
        });
      }
    }
  } catch (err) {
    console.warn(`[swarmcraft-bridge] hydrateSwarm ${swarm.name} failed: ${(err as Error).message}`);
  }
}

/**
 * Derive the MAP server URL from a swarm's base endpoint.
 *
 * Hosted swarms (OpenSwarm + macro-agent) expose:
 *   - ACP WebSocket on the base port ({endpoint}/acp)
 *   - MAP server on base port + 2 ({endpoint_port+2}/map)
 *
 * The map_endpoint stored in the hub is the base port URL. We derive
 * the MAP server URL by bumping the port by 2 and appending /map.
 */
function deriveMapServerUrl(baseEndpoint: string): string {
  try {
    const url = new URL(baseEndpoint);
    const basePort = parseInt(url.port, 10);
    if (Number.isFinite(basePort)) {
      url.port = String(basePort + 2);
    }
    // Ensure /map path
    url.pathname = url.pathname.replace(/\/?$/, '/map');
    return url.toString();
  } catch {
    // If URL parsing fails, return as-is
    return baseEndpoint;
  }
}

async function connectMapClient(
  mcm: { connect(opts: Record<string, unknown>): Promise<void> },
  swarm: Pick<MapSwarm, 'id' | 'name' | 'map_endpoint' | 'auth_method'>,
): Promise<void> {
  // Only connect to swarms with real WebSocket endpoints.
  // Swarms that connected inbound to the hub get map_endpoint='hub-inbound'
  // which is a marker, not a connectable URL.
  if (!swarm.map_endpoint || (!swarm.map_endpoint.startsWith('ws://') && !swarm.map_endpoint.startsWith('wss://'))) {
    return;
  }

  const mapUrl = deriveMapServerUrl(swarm.map_endpoint);

  // Wait for the swarm's MAP server to be healthy before connecting.
  // The sidecar connects inbound to the hub immediately on startup, but
  // the swarm's own MAP server (port+2) may take a few seconds to start.
  // Without this check, the MAPClientManager connection fails and the
  // swarm gets a new identity on reconnection.
  const healthUrl = deriveHealthUrl(swarm.map_endpoint);
  if (healthUrl) {
    const healthy = await waitForHealth(healthUrl, 15_000);
    if (!healthy) {
      console.warn(`[swarmcraft-bridge] MAP server health check failed for ${swarm.name} at ${healthUrl}, skipping connect`);
      return;
    }
  }

  try {
    await mcm.connect({
      id: swarm.id,
      name: swarm.name,
      url: mapUrl,
      auth: !swarm.auth_method || swarm.auth_method === 'none'
        ? { method: 'none' }
        : { method: swarm.auth_method, token: undefined },
    });
    console.log(`[swarmcraft-bridge] MAP client connected to ${swarm.name} at ${mapUrl}`);
  } catch (err) {
    console.warn(`[swarmcraft-bridge] MAP client connect to ${swarm.name} failed: ${(err as Error).message}`);
  }
}

/** Derive the health check URL from a swarm's MAP endpoint. */
function deriveHealthUrl(baseEndpoint: string): string | null {
  try {
    const url = new URL(baseEndpoint);
    const basePort = parseInt(url.port, 10);
    if (!Number.isFinite(basePort)) return null;
    // MAP server is at port+2, health endpoint is HTTP on the same port
    return `http://${url.hostname}:${basePort + 2}/health`;
  } catch {
    return null;
  }
}

/** Poll a health endpoint until it returns 200 or timeout. */
async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
