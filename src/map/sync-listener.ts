/**
 * MAP Sync Listener
 *
 * Subscribes to registered swarms' MAP endpoints and listens for
 * `x-openhive/memory.sync` and `x-openhive/skill.sync` JSON-RPC 2.0
 * notifications. On receiving a sync notification:
 *
 * 1. Updates the syncable_resources sync state (bookkeeping)
 * 2. Creates a resource_sync_events audit entry
 * 3. Broadcasts to local WebSocket channels for UI/non-MAP clients
 * 4. Relays the notification to subscribed swarms' MAP endpoints
 *
 * This service is initialized at server startup and connects to all
 * online swarms. It also listens for new swarm registrations via
 * mapHubEvents to connect dynamically.
 */

import WebSocket from 'ws';
import { mapHubEvents } from './service.js';
import { listSwarms, findSwarmById, findSwarmsByOwnerAgentIds } from '../db/dal/map.js';
import { findResourceById, updateResourceSyncState, createSyncEvent, getResourceSubscribers } from '../db/dal/syncable-resources.js';
import { broadcastToChannel } from '../realtime/index.js';
import { onResourceSynced } from '../sync/resource-hooks.js';
import type { MapSyncMessage, MapTransport } from './types.js';
import { SYNC_METHODS, SYNC_MESSAGE_RESOURCE_TYPE } from './types.js';
import { isCoordinationMessage, handleCoordinationMessage } from '../coordination/listener.js';

interface SwarmConnection {
  swarmId: string;
  name: string;
  endpoint: string;
  transport: MapTransport;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
}

const connections: Map<string, SwarmConnection> = new Map();

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;

// ============================================================================
// Message Handling
// ============================================================================

function isMapSyncMessage(data: unknown): data is MapSyncMessage {
  if (!data || typeof data !== 'object') return false;
  const msg = data as Record<string, unknown>;
  if (msg.jsonrpc !== '2.0') return false;
  if (typeof msg.method !== 'string' || !SYNC_METHODS.has(msg.method)) return false;
  const params = msg.params;
  if (!params || typeof params !== 'object') return false;
  const p = params as Record<string, unknown>;
  return (
    typeof p.resource_id === 'string' &&
    typeof p.agent_id === 'string' &&
    typeof p.commit_hash === 'string' &&
    typeof p.timestamp === 'string'
  );
}

/**
 * Process an incoming sync notification from a swarm.
 * Performs bookkeeping and broadcasts to local WebSocket channels.
 */
export function handleSyncMessage(msg: MapSyncMessage, sourceSwarmId: string): void {
  const { resource_id, agent_id, commit_hash } = msg.params;

  const resource = findResourceById(resource_id);
  if (!resource) {
    console.warn(`[map-sync] Received ${msg.method} for unknown resource ${resource_id} from swarm ${sourceSwarmId}`);
    return;
  }

  const expectedType = SYNC_MESSAGE_RESOURCE_TYPE[msg.method];
  if (resource.resource_type !== expectedType) {
    console.warn(`[map-sync] Method ${msg.method} doesn't match resource type ${resource.resource_type} for ${resource_id}`);
    return;
  }

  // Skip if we've already seen this commit
  if (resource.last_commit_hash === commit_hash) {
    return;
  }

  // 1. Update sync state
  updateResourceSyncState(resource_id, commit_hash, agent_id);

  // 2. Create audit event
  const syncEvent = createSyncEvent({
    resource_id,
    commit_hash,
    pusher: `map:${agent_id}`,
  });

  // 3. Record cross-instance sync event for peers
  if (resource.visibility !== 'private') {
    onResourceSynced(resource_id, commit_hash, null, agent_id, 0, 0, 0);
  }

  // 4. Broadcast to local WebSocket channels for UI/non-MAP clients
  //    Convert JSON-RPC method back to internal WSEventType for local broadcast
  const wsEventType =
    msg.method === 'x-openhive/memory.sync' ? 'memory:sync'
    : msg.method === 'trajectory/checkpoint' ? 'trajectory:sync'
    : 'skill:sync';
  broadcastToChannel(`resource:${resource.resource_type}:${resource_id}`, {
    type: wsEventType as 'memory:sync' | 'skill:sync' | 'trajectory:sync',
    data: {
      resource_id,
      resource_type: resource.resource_type,
      commit_hash,
      agent_id,
      event_id: syncEvent.id,
      source_swarm_id: sourceSwarmId,
    },
  });

  // Legacy channel for memory_bank backward compat
  if (resource.resource_type === 'memory_bank') {
    broadcastToChannel(`memory-bank:${resource_id}`, {
      type: 'memory_bank_updated',
      data: {
        resource_id,
        commit_hash,
        agent_id,
        event_id: syncEvent.id,
      },
    });
  }

  // 5. Relay to subscribed swarms
  relaySyncMessage(msg, sourceSwarmId);

  console.log(`[map-sync] Processed ${msg.method} for ${resource.name} (${resource_id}) commit=${commit_hash.slice(0, 8)}`);
}

// ============================================================================
// Relay to Subscribed Swarms
// ============================================================================

/**
 * Relay a sync notification to all swarms whose owner agents are subscribed
 * to the resource, excluding the originating swarm.
 */
function relaySyncMessage(msg: MapSyncMessage, sourceSwarmId: string): void {
  // Get all subscribers for this resource
  const { data: subscribers } = getResourceSubscribers(msg.params.resource_id, 500, 0);
  if (subscribers.length === 0) return;

  // Collect subscriber agent IDs (exclude the agent who sent the message)
  const subscriberAgentIds = subscribers
    .map((s) => s.agent_id)
    .filter((id) => id !== msg.params.agent_id);

  if (subscriberAgentIds.length === 0) return;

  // Find online swarms owned by these agents
  const targetSwarms = findSwarmsByOwnerAgentIds(subscriberAgentIds);

  // Send to each target swarm (skip the source)
  const payload = JSON.stringify(msg);
  let relayed = 0;

  for (const swarm of targetSwarms) {
    if (swarm.id === sourceSwarmId) continue;

    const conn = connections.get(swarm.id);
    if (conn?.ws?.readyState === WebSocket.OPEN) {
      conn.ws.send(payload);
      relayed++;
    }
  }

  if (relayed > 0) {
    console.log(`[map-sync] Relayed ${msg.method} for ${msg.params.resource_id} to ${relayed} swarm(s)`);
  }
}

// ============================================================================
// WebSocket Connection Management
// ============================================================================

function connectToSwarm(swarmId: string, name: string, endpoint: string, transport: MapTransport): void {
  // Only WebSocket transport is supported for now
  if (transport !== 'websocket') {
    console.log(`[map-sync] Skipping swarm ${name} — transport ${transport} not yet supported for sync listening`);
    return;
  }

  // Don't create duplicate connections
  const existing = connections.get(swarmId);
  if (existing?.ws?.readyState === WebSocket.OPEN) {
    return;
  }

  const conn: SwarmConnection = existing || {
    swarmId,
    name,
    endpoint,
    transport,
    ws: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
  };

  // Update endpoint/name in case they changed
  conn.endpoint = endpoint;
  conn.name = name;

  connections.set(swarmId, conn);

  try {
    const ws = new WebSocket(endpoint);
    conn.ws = ws;

    ws.on('open', () => {
      conn.reconnectAttempts = 0;
      console.log(`[map-sync] Connected to swarm ${name} at ${endpoint}`);
    });

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (isMapSyncMessage(parsed)) {
          handleSyncMessage(parsed, swarmId);
        } else if (isCoordinationMessage(parsed)) {
          handleCoordinationMessage(parsed, swarmId);
        }
      } catch {
        // Ignore non-JSON or unrecognized messages
      }
    });

    ws.on('close', () => {
      conn.ws = null;
      scheduleReconnect(conn);
    });

    ws.on('error', (err) => {
      console.warn(`[map-sync] Connection error for swarm ${name}: ${err.message}`);
      // close event will fire after error, triggering reconnect
    });
  } catch (err) {
    console.warn(`[map-sync] Failed to connect to swarm ${name}: ${(err as Error).message}`);
    scheduleReconnect(conn);
  }
}

function scheduleReconnect(conn: SwarmConnection): void {
  if (conn.reconnectTimer) return;
  if (conn.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn(`[map-sync] Giving up reconnecting to swarm ${conn.name} after ${MAX_RECONNECT_ATTEMPTS} attempts`);
    return;
  }

  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, conn.reconnectAttempts),
    RECONNECT_MAX_MS,
  );
  conn.reconnectAttempts++;

  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null;
    connectToSwarm(conn.swarmId, conn.name, conn.endpoint, conn.transport);
  }, delay);
}

function disconnectFromSwarm(swarmId: string): void {
  const conn = connections.get(swarmId);
  if (!conn) return;

  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }

  if (conn.ws) {
    conn.ws.close();
    conn.ws = null;
  }

  connections.delete(swarmId);
}

// ============================================================================
// Send to Swarm (used by event dispatch)
// ============================================================================

/**
 * Send a JSON-RPC message to a specific swarm via its WebSocket connection.
 * Returns true if the message was sent, false if the swarm is not connected.
 */
export function sendToSwarm(swarmId: string, message: object): boolean {
  const conn = connections.get(swarmId);
  if (conn?.ws?.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Initialize the MAP sync listener.
 * Connects to all online swarms and subscribes to new registrations.
 */
export function initMapSyncListener(): void {
  // Connect to existing online swarms
  const { data: onlineSwarms } = listSwarms({ status: 'online', limit: 500 });
  for (const swarm of onlineSwarms) {
    connectToSwarm(swarm.id, swarm.name, swarm.map_endpoint, swarm.map_transport);
  }

  if (onlineSwarms.length > 0) {
    console.log(`[map-sync] Connecting to ${onlineSwarms.length} online swarm(s) for sync listening`);
  }

  // Subscribe to new swarm registrations
  mapHubEvents.on('swarm_registered', (e: { swarm_id: string; name: string; map_endpoint: string }) => {
    const swarm = findSwarmById(e.swarm_id);
    if (swarm) {
      connectToSwarm(swarm.id, swarm.name, swarm.map_endpoint, swarm.map_transport);
    }
  });

  console.log('[map-sync] Sync listener initialized');
}

/**
 * Stop all swarm connections and clean up.
 */
export function stopMapSyncListener(): void {
  for (const swarmId of connections.keys()) {
    disconnectFromSwarm(swarmId);
  }
  console.log('[map-sync] Sync listener stopped');
}

/**
 * Get the current connection status for monitoring.
 */
export function getSyncListenerStatus(): {
  connected: number;
  reconnecting: number;
  connections: Array<{ swarmId: string; name: string; status: string }>;
} {
  let connected = 0;
  let reconnecting = 0;
  const details: Array<{ swarmId: string; name: string; status: string }> = [];

  for (const conn of connections.values()) {
    const status = conn.ws?.readyState === WebSocket.OPEN
      ? 'connected'
      : conn.reconnectTimer
        ? 'reconnecting'
        : 'disconnected';

    if (status === 'connected') connected++;
    if (status === 'reconnecting') reconnecting++;

    details.push({ swarmId: conn.swarmId, name: conn.name, status });
  }

  return { connected, reconnecting, connections: details };
}
