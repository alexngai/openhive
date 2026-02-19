/**
 * MAP Hub Service
 *
 * High-level operations for the MAP coordination plane.
 * Handles swarm registration (with pre-auth key support), node discovery,
 * peer list generation, and swarm health monitoring.
 */

import { EventEmitter } from 'events';
import * as mapDal from '../db/dal/map.js';
import { findHiveByName } from '../db/dal/hives.js';
import { getDatabase } from '../db/index.js';
import { broadcastToChannel } from '../realtime/index.js';

/** Event bus for MAP Hub lifecycle events (used by SwarmCraft bridge) */
export const mapHubEvents = new EventEmitter();
import type {
  RegisterSwarmInput,
  RegisterNodeInput,
  MapSwarm,
  MapNode,
  PeerList,
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
  // Check for duplicate endpoint
  const existing = mapDal.findSwarmByEndpoint(input.map_endpoint);
  if (existing) {
    throw new MapHubError('DUPLICATE_ENDPOINT', `A swarm is already registered at ${input.map_endpoint}`);
  }

  let autoJoinedHive: string | null = null;

  // If pre-auth key is provided, validate and consume it
  if (input.preauth_key) {
    const key = mapDal.consumePreauthKey(input.preauth_key);
    if (!key) {
      throw new MapHubError('INVALID_PREAUTH_KEY', 'Pre-auth key is invalid, expired, or exhausted');
    }
    // Remember the hive to auto-join after swarm creation
    if (key.hive_id) {
      autoJoinedHive = key.hive_id;
    }
  }

  // Create the swarm
  const swarm = mapDal.createSwarm(ownerAgentId, input);

  // Auto-join hive if pre-auth key specified one
  if (autoJoinedHive) {
    mapDal.joinHive(swarm.id, autoJoinedHive);
  }

  // Broadcast swarm registration event
  broadcastToChannel('map:discovery', {
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

  return { swarm, auto_joined_hive: autoJoinedHive };
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

  // Broadcast node registration
  broadcastToChannel(`map:swarm:${input.swarm_id}`, {
    type: 'node_registered',
    data: {
      node_id: node.id,
      swarm_id: node.swarm_id,
      map_agent_id: node.map_agent_id,
      role: node.role,
    },
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
 * Call this periodically (e.g. via setInterval or cron).
 */
export function markStaleSwarms(staleThresholdMinutes: number = 5): number {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE map_swarms
    SET status = 'offline', updated_at = datetime('now')
    WHERE status = 'online'
      AND last_seen_at < datetime('now', ?)
  `).run(`-${staleThresholdMinutes} minutes`);

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
