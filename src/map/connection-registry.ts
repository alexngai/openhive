/**
 * MAP Inbound Connection Registry
 *
 * In-memory registry tracking swarms that have connected inbound to the hub
 * via /ws/map or mesh transport. Separated from ws-map.ts to avoid circular
 * imports with sync-listener.ts (which needs getInbound for dual-transport delivery).
 */

import type { WebSocket } from 'ws';

export type ConnectionTransport =
  | { type: 'websocket'; ws: WebSocket }
  | { type: 'mesh'; peerId: string };

export interface MapInboundConnection {
  transport: ConnectionTransport;
  agentId: string;
  swarmId: string;
  connectedAt: string;
  lastMessageAt: string;
}

const inboundConnections: Map<string, MapInboundConnection> = new Map();

// Lazy-loaded mesh-peer module to avoid circular dependency at import time
let _meshPeerModule: typeof import('./mesh-peer.js') | null = null;

/**
 * Pre-load the mesh-peer module for sendToInbound mesh transport.
 * Called by mesh-handler.ts after initMeshPeer() completes.
 */
export function initMeshPeerRef(): void {
  import('./mesh-peer.js').then(mod => { _meshPeerModule = mod; }).catch(() => {});
}

export function registerInbound(swarmId: string, conn: MapInboundConnection): void {
  // Close existing connection for this swarm if present
  const existing = inboundConnections.get(swarmId);
  if (existing && existing !== conn) {
    if (existing.transport.type === 'websocket') {
      try { existing.transport.ws.close(); } catch { /* ignore */ }
    }
  }
  inboundConnections.set(swarmId, conn);
}

export function unregisterInbound(swarmId: string): void {
  inboundConnections.delete(swarmId);
}

export function getInbound(swarmId: string): MapInboundConnection | undefined {
  return inboundConnections.get(swarmId);
}

export function getAllInbound(): Map<string, MapInboundConnection> {
  return inboundConnections;
}

export function getInboundCount(): number {
  return inboundConnections.size;
}

/**
 * Send a JSON-RPC message to an inbound connection, abstracting over transport type.
 * Returns true if sent, false if the connection is not available.
 */
export function sendToInbound(swarmId: string, message: object): boolean {
  const conn = inboundConnections.get(swarmId);
  if (!conn) return false;

  if (conn.transport.type === 'websocket') {
    const { ws } = conn.transport;
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  if (conn.transport.type === 'mesh') {
    // Mesh send is handled via the hub's MeshPeer — import lazily to avoid circular deps.
    // Use the cached module reference if available, otherwise trigger async cache fill.
    try {
      if (!_meshPeerModule) {
        // Fire-and-forget: load the module for next call
        import('./mesh-peer.js').then(mod => { _meshPeerModule = mod; }).catch(() => {});
        return false;
      }
      if (!_meshPeerModule.isMeshEnabled()) return false;
      const peer = _meshPeerModule.getHubMeshPeer();
      peer.send('openhive-hub', conn.transport.peerId, message).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
