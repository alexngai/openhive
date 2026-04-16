/**
 * Swarm Bridge
 *
 * Projects OpenHive MAP Hub swarms and their nodes into SwarmCraft agents.
 * Each swarm becomes a parent agent; each node becomes a child agent.
 * Also handles the MAP client auto-connect that was previously inline in server.ts.
 */

import { mapHubEvents } from '../map/service.js';
import { listSwarms, discoverNodes, updateSwarm, findSwarmById } from '../db/dal/map.js';
import {
  agentIdFromSwarm,
  agentIdFromNode,
  mapSwarmStatusToState,
  mapNodeStateToState,
} from './constants.js';
import { broadcastToChannel } from '../realtime/index.js';
import type { BridgeContext } from './types.js';
import type { MapSwarm } from '../map/types.js';
import type { EventEmitter } from 'events';

/**
 * Periodic interval for retrying outbound bridge connections to swarms in
 * `unreachable` status. Long enough to avoid log spam for genuinely-down
 * swarms; short enough that recovery feels responsive once the underlying
 * process comes back.
 */
const BRIDGE_RETRY_MS = 30_000;

function markSwarmStatus(swarmId: string, status: 'online' | 'unreachable'): void {
  try {
    updateSwarm(swarmId, { status });
    broadcastToChannel('map:discovery', {
      type: 'swarm.status_changed',
      data: { swarm_id: swarmId, status },
    });
  } catch { /* non-critical */ }
}

interface SwarmBridgeHandle {
  teardown(): void;
}

/**
 * Setup the swarm bridge: hydrate existing data, register real-time listeners,
 * and optionally auto-connect SwarmCraft's MAP client to registered swarms.
 */
export async function setupSwarmBridge(
  ctx: BridgeContext,
  mapClientManager?: { connect(opts: Record<string, unknown>): Promise<void> } & Partial<EventEmitter>,
): Promise<SwarmBridgeHandle> {
  const listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  const mcmListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

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

      // Read actual capabilities from the hub's swarm record (set during MAP registration)
      // instead of hardcoding, so ACP/mail/messaging capabilities are preserved.
      const swarmRecord = findSwarmById(ev.swarm_id);
      const hubCaps = swarmRecord?.capabilities as Record<string, unknown> | null;
      const caps = hubCaps
        ? Object.keys(hubCaps).filter(k => hubCaps[k])
        : ['observation', 'messaging', 'lifecycle'];

      await ctx.db.agents.create({
        id: agentId,
        name: ev.name,
        type: 'swarm',
        mapServerId: serverId,
        state: 'active',
        capabilities: caps,
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
          // SwarmCraft's capability resolver reads peerMapId from the nested
          // `agentMetadata` slot — it uses this to target the agent on the
          // peer's MAP server for ACP routing.
          agentMetadata: {
            peerMapId: ev.map_agent_id,
          },
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

  // ── Forward remote agent capabilities to hub swarm record ──────────
  // When SwarmCraft's MAPClientManager connects outbound to a swarm's
  // MAP server, it syncs the agent list and receives agent_registered events.
  // Merge the remote agents' declared capabilities (e.g., protocols: ['acp'],
  // mail, messaging) into the hub's swarm record so capability-gated features
  // (ACP chat, mail chat) work for outbound-connected swarms.
  if (mapClientManager?.on) {
    const mergeAgentCaps = (serverId: string, agentCaps: Record<string, unknown>) => {
      try {
        const swarm = findSwarmById(serverId);
        if (!swarm) return;

        const existing = (swarm.capabilities || {}) as Record<string, unknown>;
        const merged = { ...existing };
        let changed = false;

        for (const [key, val] of Object.entries(agentCaps)) {
          if (key === 'protocols' && Array.isArray(val)) {
            const existingProtos = Array.isArray(existing.protocols) ? existing.protocols as string[] : [];
            const union = [...new Set([...existingProtos, ...val as string[]])];
            if (union.length !== existingProtos.length) {
              merged.protocols = union;
              changed = true;
            }
          } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            const existingVal = existing[key];
            if (!existingVal || typeof existingVal !== 'object') {
              merged[key] = val;
              changed = true;
            } else {
              merged[key] = { ...(existingVal as Record<string, unknown>), ...(val as Record<string, unknown>) };
              changed = true;
            }
          } else if (!(key in existing)) {
            merged[key] = val;
            changed = true;
          }
        }

        if (changed) {
          updateSwarm(serverId, { capabilities: merged as any });
          console.log(`[swarmcraft-bridge] Merged remote agent capabilities into swarm ${swarm.name}: ${Object.keys(agentCaps).join(', ')}`);
        }
      } catch (err) {
        console.warn(`[swarmcraft-bridge] Failed to merge remote agent caps: ${(err as Error).message}`);
      }
    };

    // On individual agent registration
    const onRemoteAgent = (e: unknown) => {
      const ev = e as { serverId: string; agent: { capabilities?: Record<string, unknown> } };
      if (!ev?.serverId || !ev?.agent?.capabilities) return;
      mergeAgentCaps(ev.serverId, ev.agent.capabilities);
    };
    mapClientManager.on('agent.registered', onRemoteAgent);
    mcmListeners.push({ event: 'agent.registered', fn: onRemoteAgent });

    // On initial agent sync after connect — merge capabilities from all existing agents
    const onAgentsSynced = (e: unknown) => {
      const ev = e as { serverId: string; agents: Array<{ capabilities?: Record<string, unknown> }> };
      if (!ev?.serverId || !Array.isArray(ev.agents)) return;
      for (const agent of ev.agents) {
        if (agent.capabilities) {
          mergeAgentCaps(ev.serverId, agent.capabilities);
        }
      }
    };
    mapClientManager.on('agents.synced', onAgentsSynced);
    mcmListeners.push({ event: 'agents.synced', fn: onAgentsSynced });
  }

  // Periodic retry sweep: when an outbound bridge connection fails (process
  // not yet up, transient network), the swarm is marked unreachable. Try to
  // reconnect every BRIDGE_RETRY_MS so recovery is automatic once the peer
  // comes back. We only retry swarms with a real ws:// endpoint — hub-inbound
  // and local-hub markers are not connectable URLs.
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  if (mapClientManager) {
    retryTimer = setInterval(() => {
      try {
        const { data: candidates } = listSwarms({ status: 'unreachable', limit: 100 });
        for (const swarm of candidates) {
          if (!swarm.map_endpoint) continue;
          if (!swarm.map_endpoint.startsWith('ws://') && !swarm.map_endpoint.startsWith('wss://')) continue;
          // Fire-and-forget; connectMapClient updates status itself.
          connectMapClient(mapClientManager, swarm).catch(() => { /* logged inside */ });
        }
      } catch (err) {
        console.warn(`[swarmcraft-bridge] retry sweep failed: ${(err as Error).message}`);
      }
    }, BRIDGE_RETRY_MS);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  return {
    teardown() {
      if (retryTimer) clearInterval(retryTimer);
      for (const { event, fn } of listeners) {
        mapHubEvents.removeListener(event, fn);
      }
      if (mapClientManager?.removeListener) {
        for (const { event, fn } of mcmListeners) {
          mapClientManager.removeListener(event, fn);
        }
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
        // SwarmCraft reads peerMapId from `agentMetadata` for ACP routing.
        agentMetadata: {
          peerMapId: node.map_agent_id,
        },
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
  const healthUrls = deriveHealthUrls(swarm.map_endpoint);
  if (healthUrls.length > 0) {
    const reached = await waitForAnyHealth(healthUrls, 15_000);
    if (!reached) {
      console.warn(`[swarmcraft-bridge] MAP server health check failed for ${swarm.name} (tried ${healthUrls.join(', ')}), marking unreachable`);
      markSwarmStatus(swarm.id, 'unreachable');
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
      // Skip the event subscription on this connection. The subscription's
      // async event iterator interferes with RPC request/response correlation,
      // causing map/send and map/subscribe to time out. ACP streams create
      // their own subscriptions which must be the only active iterator.
      skipSubscription: true,
    });
    console.log(`[swarmcraft-bridge] MAP client connected to ${swarm.name} at ${mapUrl}`);
    // Promote unreachable → online once outbound bridge is live. Inbound
    // sidecars manage their own status via heartbeat; this only matters when
    // the bridge is the only signal we have (e.g., after a hub restart that
    // dropped the inbound WS but the swarm's MAP server is up again).
    const current = findSwarmById(swarm.id);
    if (current && current.status === 'unreachable') {
      markSwarmStatus(swarm.id, 'online');
    }
  } catch (err) {
    console.warn(`[swarmcraft-bridge] MAP client connect to ${swarm.name} failed: ${(err as Error).message}`);
    markSwarmStatus(swarm.id, 'unreachable');
  }
}

/**
 * Candidate health-check URLs derived from a swarm's MAP endpoint.
 *
 * openswarm/macro-agent layouts:
 *   gateway HTTP at base port, management HTTP at base+1, MAP WS at base+2.
 *   /health is exposed on multiple of these; we probe the most-likely set.
 *
 * Hand-registered swarms may register with any of those ports as their
 * `map_endpoint`, so deriving a single offset breaks. We instead probe a
 * handful of candidates and accept the first that responds.
 */
function deriveHealthUrls(baseEndpoint: string): string[] {
  try {
    const url = new URL(baseEndpoint);
    const basePort = parseInt(url.port, 10);
    if (!Number.isFinite(basePort)) return [];
    const offsets = [2, 1, 0, -1, -2];
    const seen = new Set<number>();
    const urls: string[] = [];
    for (const off of offsets) {
      const port = basePort + off;
      if (port <= 0 || port > 65_535) continue;
      if (seen.has(port)) continue;
      seen.add(port);
      urls.push(`http://${url.hostname}:${port}/health`);
    }
    return urls;
  } catch {
    return [];
  }
}

/**
 * Poll candidate health URLs until one returns 200 or timeout. Each polling
 * cycle probes all candidates in parallel; first 200 wins.
 */
async function waitForAnyHealth(urls: string[], timeoutMs: number): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const probes = urls.map(async (u) => {
      try {
        const res = await fetch(u);
        if (res.ok) return u;
      } catch { /* not ready yet */ }
      return null;
    });
    const results = await Promise.all(probes);
    const hit = results.find((r) => r !== null);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
