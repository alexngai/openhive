/**
 * Mesh Inbound Handler
 *
 * Handles mesh-connected swarms connecting to the hub via agentic-mesh.
 * This is the mesh equivalent of ws-map.ts — listens for peer connections,
 * authenticates them, registers them in the connection registry, and routes
 * messages through the shared message dispatch.
 */

import { getHubMeshPeer, isMeshEnabled } from './mesh-peer.js';
import { dispatchMapMessage, type ReplyFunctions } from './message-dispatch.js';
import { registerInbound, unregisterInbound, initMeshPeerRef } from './connection-registry.js';
import { cleanupSubscriptions } from './event-subscriptions.js';
import { getInboxStorage } from './inbox-bridge.js';
import {
  findSwarmByMeshPeerId, createSwarm, heartbeatSwarm, updateSwarm, getSwarmHives,
} from '../db/dal/map.js';
import { findHiveById } from '../db/dal/hives.js';
import { getOrCreateLocalAgent } from '../db/dal/agents.js';
import { joinHiveScope } from './hive-scopes.js';
import { flushAllQueues } from './mesh-channels.js';
import { cacheMeshPeer, uncacheMeshPeer } from './sync-listener.js';

/**
 * Initialize mesh handler — listens for peer connections on the hub's MeshPeer.
 * Call after initMeshPeer() has succeeded.
 */
export function setupMeshHandler(): void {
  if (!isMeshEnabled()) return;

  // Pre-load mesh-peer module reference for connection registry's sendToInbound
  initMeshPeerRef();

  const hubPeer = getHubMeshPeer();

  hubPeer.on('peer:connected', (remotePeerId: unknown) => {
    handlePeerConnected(String(remotePeerId)).catch(err => {
      console.error(`[mesh-handler] Error handling peer connection ${remotePeerId}:`, err);
    });
  });

  hubPeer.on('peer:disconnected', (remotePeerId: unknown) => {
    handlePeerDisconnected(String(remotePeerId));
  });

  console.log('[openhive] Mesh handler registered for peer connections');
}

/**
 * Stop mesh handler — cleanup connections.
 */
export function stopMeshHandler(): void {
  // MeshPeer cleanup handles event listener removal
  console.log('[mesh-handler] Mesh handler stopped');
}

// ─── Peer Connection Handling ───────────────────────────────────────────────

async function handlePeerConnected(remotePeerId: string): Promise<void> {
  // Find or create a swarm for this mesh peer
  let swarm = findSwarmByMeshPeerId(remotePeerId);

  if (!swarm) {
    // Auto-register the swarm for this mesh peer
    // Use the local system agent as owner (required for FK constraint)
    const systemAgent = await getOrCreateLocalAgent();
    swarm = createSwarm(systemAgent.id, {
      name: `mesh-${remotePeerId}`,
      map_endpoint: `mesh://${remotePeerId}`,
      map_transport: 'mesh',
      mesh_peer_id: remotePeerId,
      auth_method: 'none',
    });
    console.log(`[mesh-handler] Auto-registered mesh swarm ${swarm.id} for peer ${remotePeerId}`);
  }

  // Mark swarm online
  heartbeatSwarm(swarm.id);

  // Auto-join hive scopes for this swarm's memberships
  const swarmHives = getSwarmHives(swarm.id);
  const agentId = swarm.owner_agent_id;
  for (const sh of swarmHives) {
    try {
      const hive = findHiveById(sh.hive_id);
      if (hive) {
        joinHiveScope(hive.name, agentId);
      }
    } catch (err) {
      console.error(`[mesh-handler] Failed to join hive scope for hive ${sh.hive_id}:`, err);
    }
  }

  // Cache mesh peer mapping for fast sendToSwarm lookups
  if (swarm.mesh_peer_id) {
    cacheMeshPeer(swarm.id, swarm.mesh_peer_id, swarm.owner_agent_id);
  }

  // Register in connection registry
  const now = new Date().toISOString();
  registerInbound(swarm.id, {
    transport: { type: 'mesh', peerId: remotePeerId },
    agentId: swarm.owner_agent_id,
    swarmId: swarm.id,
    connectedAt: now,
    lastMessageAt: now,
  });

  // Flush any queued channel messages for this swarm
  const flushed = flushAllQueues(swarm.id);
  if (flushed > 0) {
    console.log(`[mesh-handler] Flushed ${flushed} queued message(s) for swarm ${swarm.id}`);
  }

  // Set up message handler for this peer on the MapServer
  const hubPeer = getHubMeshPeer();
  const server = hubPeer.server;

  // Register a catch-all message handler for the hub agent that routes
  // messages from this peer through the standard dispatch pipeline
  server.setMessageHandler(`hub-relay-${remotePeerId}`, (msg: unknown) => {
    const message = msg as Record<string, unknown>;
    const reply: ReplyFunctions = {
      sendNotification: (method, params) => {
        hubPeer.send('openhive-hub', remotePeerId, { jsonrpc: '2.0', method, params }).catch(() => {});
      },
      sendError: (code, errorMsg, id) => {
        hubPeer.send('openhive-hub', remotePeerId, {
          jsonrpc: '2.0', id: id ?? null, error: { code, message: errorMsg },
        }).catch(() => {});
      },
      sendResult: (id, result) => {
        hubPeer.send('openhive-hub', remotePeerId, {
          jsonrpc: '2.0', id: id ?? null, result,
        }).catch(() => {});
      },
    };

    dispatchMapMessage(message, swarm!.id, reply, null).catch(err => {
      console.error(`[mesh-handler] Dispatch error for peer ${remotePeerId}:`, err);
    });
  });

  // Send welcome
  hubPeer.send('openhive-hub', remotePeerId, {
    jsonrpc: '2.0',
    method: 'hub/welcome',
    params: {
      swarm_id: swarm.id,
      agent_id: swarm.owner_agent_id,
      capabilities: {
        mail: { enabled: true },
        addressing: { hive: true, swarm: true, hub: true },
        transport: 'mesh',
      },
    },
  }).catch(() => {});

  // Replay unread messages
  try {
    const inbox = getInboxStorage();
    const unread = inbox.getInbox(swarm.owner_agent_id, { unreadOnly: true, limit: 50 });
    if (unread.length > 0) {
      hubPeer.send('openhive-hub', remotePeerId, {
        jsonrpc: '2.0',
        method: 'map/replay',
        params: { messages: unread, count: unread.length },
      }).catch(() => {});
      console.log(`[mesh-handler] Replayed ${unread.length} unread messages to peer ${remotePeerId}`);
    }
  } catch {
    // Inbox bridge may not be initialized yet — non-fatal
  }

  console.log(`[mesh-handler] Peer ${remotePeerId} connected (swarm: ${swarm.id})`);
}

function handlePeerDisconnected(remotePeerId: string): void {
  const swarm = findSwarmByMeshPeerId(remotePeerId);
  if (!swarm) return;

  // Invalidate mesh peer cache
  uncacheMeshPeer(swarm.id);

  // Unregister from connection registry
  unregisterInbound(swarm.id);
  cleanupSubscriptions(swarm.id);

  // Remove message handler
  try {
    const server = getHubMeshPeer().server;
    server.removeMessageHandler(`hub-relay-${remotePeerId}`);
  } catch { /* peer may already be stopped */ }

  // Mark swarm offline
  updateSwarm(swarm.id, { status: 'offline' });

  // Mark agent offline in inbox
  try {
    const inboxStorage = getInboxStorage();
    const inboxAgent = inboxStorage.getAgent(swarm.owner_agent_id);
    if (inboxAgent) {
      inboxAgent.status = 'offline';
      inboxAgent.last_active_at = new Date().toISOString();
      inboxStorage.putAgent(inboxAgent);
    }
  } catch { /* non-fatal */ }

  console.log(`[mesh-handler] Peer ${remotePeerId} disconnected (swarm: ${swarm.id})`);
}
