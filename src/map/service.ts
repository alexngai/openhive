/**
 * MAP Hub Service
 *
 * High-level operations for the MAP coordination plane.
 * Handles swarm registration (with pre-auth key support), node discovery,
 * peer list generation, and swarm health monitoring.
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import * as mapDal from '../db/dal/map.js';
import { findHiveByName } from '../db/dal/hives.js';
import { getDatabase } from '../db/index.js';
import { broadcastToChannel } from '../realtime/index.js';
import { broadcastSwarmLifecycleEvent } from '../realtime/swarm-events.js';

/** Event bus for MAP Hub lifecycle events (used by SwarmCraft bridge) */
export const mapHubEvents = new EventEmitter();
import type {
  RegisterSwarmInput,
  RegisterNodeInput,
  MapSwarm,
  MapNode,
  PeerList,
  CoordinationCapability,
} from './types.js';

// ============================================================================
// Swarm Registration
// ============================================================================

export interface RegisterSwarmResult {
  swarm: MapSwarm;
  auto_joined_hive: string | null;
}

/**
 * Register a new MAP swarm with the hub.
 * Optionally uses a pre-auth key for automated registration + auto-join.
 */
export function registerSwarm(
  ownerAgentId: string,
  input: RegisterSwarmInput
): RegisterSwarmResult {
  // Phase 3: stable identity — upsert instead of insert when a canonical key is present
  if (input.stable_identity) {
    const canonicalKey = createHash('sha256').update(input.stable_identity).digest('hex');
    const swarm = mapDal.upsertSwarmByCanonicalKey(canonicalKey, ownerAgentId, input);

    broadcastSwarmLifecycleEvent(swarm.id, {
      type: 'swarm_registered',
      data: { swarm_id: swarm.id, name: swarm.name, map_endpoint: swarm.map_endpoint },
    });
    mapHubEvents.emit('swarm_registered', {
      swarm_id: swarm.id, name: swarm.name,
      map_endpoint: swarm.map_endpoint, auth_method: swarm.auth_method,
    });
    return { swarm, auto_joined_hive: null };
  }

  // Check for duplicate endpoint
  const existing = mapDal.findSwarmByEndpoint(input.map_endpoint);
  if (existing) {
    throw new MapHubError('DUPLICATE_ENDPOINT', `A swarm is already registered at ${input.map_endpoint}`);
  }

  // Create the swarm
  const swarm = mapDal.createSwarm(ownerAgentId, input);

  // Broadcast swarm registration event
  broadcastSwarmLifecycleEvent(swarm.id, {
    type: 'swarm_registered',
    data: {
      swarm_id: swarm.id,
      name: swarm.name,
      map_endpoint: swarm.map_endpoint,
    },
  });

  // Emit for SwarmCraft bridge (auto-connect MAP client)
  mapHubEvents.emit('swarm_registered', {
    swarm_id: swarm.id,
    name: swarm.name,
    map_endpoint: swarm.map_endpoint,
    auth_method: swarm.auth_method,
  });

  return { swarm, auto_joined_hive: null };
}

// ============================================================================
// Node Registration
// ============================================================================

/**
 * Register an agent node within a swarm.
 * The caller must own the swarm.
 */
export function registerNode(
  ownerAgentId: string,
  input: RegisterNodeInput
): MapNode {
  // Verify swarm ownership
  if (!mapDal.isSwarmOwner(input.swarm_id, ownerAgentId)) {
    throw new MapHubError('NOT_SWARM_OWNER', 'You do not own this swarm');
  }

  // Check for duplicate agent within swarm
  const existing = mapDal.findNodeBySwarmAndAgentId(input.swarm_id, input.map_agent_id);
  if (existing) {
    throw new MapHubError('DUPLICATE_NODE', `Agent ${input.map_agent_id} is already registered in this swarm`);
  }

  const node = mapDal.createNode(input);

  // Update swarm agent count
  const swarm = mapDal.findSwarmById(input.swarm_id);
  if (swarm) {
    const { total } = mapDal.discoverNodes({ swarm_id: input.swarm_id });
    mapDal.updateSwarm(input.swarm_id, { agent_count: total });
  }

  // Fan out to fleet (`map:discovery`) + per-swarm (`map:swarm:${id}`).
  // See realtime/swarm-events.ts for the routing contract.
  broadcastSwarmLifecycleEvent(input.swarm_id, {
    type: 'node_registered',
    data: {
      node_id: node.id,
      swarm_id: node.swarm_id,
      map_agent_id: node.map_agent_id,
      role: node.role,
    },
  });

  // Emit for SwarmCraft bridge
  mapHubEvents.emit('node_registered', {
    node_id: node.id,
    swarm_id: node.swarm_id,
    map_agent_id: node.map_agent_id,
    name: node.name,
    role: node.role,
    state: node.state,
  });

  return node;
}

// ============================================================================
// Peer Discovery
// ============================================================================

/**
 * Generate a peer list for a swarm.
 * Returns all other swarms that share at least one hive with the requesting swarm,
 * along with their MAP endpoints and connection info.
 *
 * This is the headscale-equivalent: "here are all the peers you can talk to."
 */
export function getPeerList(swarmId: string): PeerList {
  const swarm = mapDal.findSwarmById(swarmId);
  if (!swarm) {
    throw new MapHubError('SWARM_NOT_FOUND', 'Swarm not found');
  }

  const peers = mapDal.getPeerList(swarmId);

  // Log the peer list request for observability
  mapDal.logFederationEvent(swarmId, null, 'initiated');

  return {
    swarm_id: swarmId,
    peers,
    generated_at: new Date().toISOString(),
  };
}

// ============================================================================
// Capability-based Discovery
// ============================================================================

/**
 * Discover MAP nodes that have coordination capabilities matching the filter.
 * Queries nodes in swarms belonging to the given hive, then filters by parsing
 * their capabilities JSON for the coordination field.
 */
export function discoverByCapability(
  hiveId: string,
  filter: { task_type?: string; accepts_messages?: boolean }
): MapNode[] {
  const { data: nodes } = mapDal.discoverNodes({ hive_id: hiveId, limit: 500 });

  return nodes.filter((node) => {
    if (!node.capabilities) return false;
    const coord = (node.capabilities as Record<string, unknown>).coordination as CoordinationCapability | undefined;
    if (!coord) return false;

    if (filter.task_type !== undefined) {
      if (!coord.accepts_tasks) return false;
      if (coord.task_types && !coord.task_types.includes(filter.task_type)) return false;
    }

    if (filter.accepts_messages !== undefined && coord.accepts_messages !== filter.accepts_messages) {
      return false;
    }

    return true;
  }) as unknown as MapNode[];
}

// ============================================================================
// Hive Operations
// ============================================================================

/**
 * Join a hive by name. The hive must exist.
 */
export function joinHive(swarmId: string, hiveName: string): void {
  const hive = findHiveByName(hiveName);
  if (!hive) {
    throw new MapHubError('HIVE_NOT_FOUND', `Hive "${hiveName}" not found`);
  }

  mapDal.joinHive(swarmId, hive.id);

  // Broadcast to hive channel
  const swarm = mapDal.findSwarmById(swarmId);
  broadcastToChannel(`map:hive:${hive.id}`, {
    type: 'swarm_joined_hive',
    data: {
      swarm_id: swarmId,
      swarm_name: swarm?.name,
      hive_name: hiveName,
    },
  });
}

/**
 * Leave a hive by name.
 */
export function leaveHive(swarmId: string, hiveName: string): boolean {
  const hive = findHiveByName(hiveName);
  if (!hive) {
    throw new MapHubError('HIVE_NOT_FOUND', `Hive "${hiveName}" not found`);
  }

  const result = mapDal.leaveHive(swarmId, hive.id);

  if (result) {
    const swarm = mapDal.findSwarmById(swarmId);
    broadcastToChannel(`map:hive:${hive.id}`, {
      type: 'swarm_left_hive',
      data: {
        swarm_id: swarmId,
        swarm_name: swarm?.name,
        hive_name: hiveName,
      },
    });
  }

  return result;
}

// ============================================================================
// Health Monitoring
// ============================================================================

/**
 * Mark stale swarms as offline.
 * Sweeps both 'online' (missed heartbeats) and 'unreachable' (disconnected but not yet offline).
 * Call this periodically (e.g. via setInterval or cron).
 */
export function markStaleSwarms(staleThresholdMinutes: number = 5): number {
  const db = getDatabase();

  // Collect IDs of swarms about to go offline (for SwarmCraft bridge + learning engine)
  const staleRows = db.prepare(`
    SELECT id FROM map_swarms
    WHERE status IN ('online', 'unreachable')
      AND last_seen_at < datetime('now', ?)
  `).all(`-${staleThresholdMinutes} minutes`) as { id: string }[];

  if (staleRows.length === 0) return 0;

  const result = db.prepare(`
    UPDATE map_swarms
    SET status = 'offline', updated_at = datetime('now')
    WHERE status IN ('online', 'unreachable')
      AND last_seen_at < datetime('now', ?)
  `).run(`-${staleThresholdMinutes} minutes`);

  // Emit for SwarmCraft bridge and learning engine ingestion
  // + broadcast on map:discovery so WS subscribers (incl. swarmcraft) see the transition.
  // Also cascade presence=offline onto the swarm's nodes — backstop for
  // ungraceful disconnects where handleDisconnect never ran (SIGKILL,
  // network partition). The per-disconnect path already handles clean exits.
  for (const row of staleRows) {
    try { mapDal.bulkUpdateSwarmNodesPresence(row.id, 'offline'); } catch { /* non-critical */ }
    mapHubEvents.emit('swarm_offline', { swarm_id: row.id });
    try {
      broadcastSwarmLifecycleEvent(row.id, {
        type: 'swarm.status_changed',
        data: { swarm_id: row.id, status: 'offline' },
      });
    } catch { /* non-critical */ }
  }

  // Phase 2: archive swarms offline for > archiveDays
  const archiveResult = mapDal.archiveStaleSwarms(30);
  if (archiveResult > 0) {
    console.log(`[MAP] Archived ${archiveResult} offline swarm(s) older than 30 days`);
  }

  return result.changes;
}

// ============================================================================
// Well-Known Extension
// ============================================================================

/**
 * Returns MAP hub info to include in /.well-known/openhive.json
 */
export function getWellKnownMapInfo(): Record<string, unknown> {
  const stats = mapDal.getMapStats();
  return {
    map_hub: {
      enabled: true,
      protocol: 'MAP',
      protocol_version: '1.0',
      stats: {
        swarms: stats.swarms.total,
        swarms_online: stats.swarms.online,
        nodes: stats.nodes.total,
        nodes_active: stats.nodes.active,
      },
      endpoints: {
        swarms: '/api/v1/map/swarms',
        nodes: '/api/v1/map/nodes',
        peers: '/api/v1/map/peers',
      },
    },
  };
}

// ============================================================================
// Error Type
// ============================================================================

export type MapHubErrorCode =
  | 'DUPLICATE_ENDPOINT'
  | 'INVALID_PREAUTH_KEY'
  | 'NOT_SWARM_OWNER'
  | 'DUPLICATE_NODE'
  | 'SWARM_NOT_FOUND'
  | 'NODE_NOT_FOUND'
  | 'HIVE_NOT_FOUND';

export class MapHubError extends Error {
  code: MapHubErrorCode;

  constructor(code: MapHubErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'MapHubError';
  }
}
