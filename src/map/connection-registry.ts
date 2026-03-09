/**
 * MAP Inbound Connection Registry
 *
 * In-memory registry tracking swarms that have connected inbound to the hub
 * via /ws/map. Separated from ws-map.ts to avoid circular imports with
 * sync-listener.ts (which needs getInbound for dual-transport delivery).
 */

import type { WebSocket } from 'ws';

export interface MapInboundConnection {
  ws: WebSocket;
  agentId: string;
  swarmId: string;
  connectedAt: string;
  lastMessageAt: string;
}

const inboundConnections: Map<string, MapInboundConnection> = new Map();

export function registerInbound(swarmId: string, conn: MapInboundConnection): void {
  // Close existing connection for this swarm if present
  const existing = inboundConnections.get(swarmId);
  if (existing && existing.ws !== conn.ws) {
    try { existing.ws.close(); } catch { /* ignore */ }
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
