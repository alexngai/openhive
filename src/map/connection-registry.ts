/**
 * MAP Inbound Connection Registry
 *
 * In-memory registry tracking swarms that have connected inbound to the hub
 * via /ws/map. Separated from ws-map.ts to avoid circular imports with
 * sync-listener.ts (which needs getInbound for dual-transport delivery).
 */

import type { WebSocket } from 'ws';

export interface RegisteredAgent {
  id: string;
  name: string;
  role: string;
  state: string;
  scopes: string[];
}

export interface MapInboundConnection {
  ws: WebSocket;
  agentId: string;
  swarmId: string;
  connectedAt: string;
  lastMessageAt: string;
  /** ISO timestamp when the agent-iam token expires (verified mode only). */
  tokenExpiresAt?: string;
  /** Whether an auth.expiring notification has already been sent for this session. */
  expiryNotified?: boolean;
  /** Agents registered on this connection (keyed by agent ID). */
  registeredAgents: Map<string, RegisteredAgent>;
  /** Agent capabilities declared during MAP registration. */
  capabilities?: Record<string, unknown>;
  /** Default OpenTasks graph for this connection (set via metadata.task_graph on registration). */
  defaultTaskGraph?: { resource_id?: string; path?: string; location_hash?: string };
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

export function setDefaultTaskGraph(swarmId: string, target: { resource_id?: string; path?: string; location_hash?: string }): void {
  const conn = inboundConnections.get(swarmId);
  if (conn) conn.defaultTaskGraph = target;
}

export function getDefaultTaskGraph(swarmId: string): { resource_id?: string; path?: string; location_hash?: string } | undefined {
  return inboundConnections.get(swarmId)?.defaultTaskGraph;
}
