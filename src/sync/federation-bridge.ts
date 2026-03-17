/**
 * Sync Federation Bridge
 *
 * Wraps agentic-mesh FederationGateway instances for sync peers that have
 * mesh_peer_id configured. Provides gateway-based push as an alternative
 * to HTTP fetch for hive content sync events.
 *
 * The bridge:
 * - Creates FederationGateway per mesh-enabled sync peer
 * - Routes outbound sync events via gateway.route() instead of HTTP POST
 * - Listens for inbound events via gateway 'message:received'
 * - Handles buffering during outages (gateway built-in)
 * - Tracks hop count to prevent loops in multi-hub topologies
 */

import { isMeshEnabled, getHubMeshPeer, type MeshPeerInstance } from '../map/mesh-peer.js';
import { getChannel } from '../map/mesh-channels.js';

// ============================================================================
// Types
// ============================================================================

export interface SyncGatewayConfig {
  localSystemId: string;
  remoteSystemId: string;
  remoteMeshPeerId: string;
  syncToken?: string;
  maxHops?: number;
}

export interface SyncGateway {
  peerId: string;
  remoteSystemId: string;
  gateway: unknown; // FederationGateway instance
  isConnected: boolean;
}

type InboundEventHandler = (events: unknown[], senderSeq: number, traceId: string) => void;

// ============================================================================
// Gateway Registry
// ============================================================================

const gateways: Map<string, SyncGateway> = new Map();
let inboundHandler: InboundEventHandler | null = null;

/**
 * Register a handler for inbound sync events received via federation gateways.
 */
export function onInboundSyncEvents(handler: InboundEventHandler): void {
  inboundHandler = handler;
}

/**
 * Create a FederationGateway for a mesh-enabled sync peer.
 * Returns true if gateway was created, false if mesh is not available.
 */
export async function createSyncGateway(config: SyncGatewayConfig): Promise<boolean> {
  if (!isMeshEnabled()) return false;

  // Dynamic import for agentic-mesh
  let agenticMesh: any;
  try {
    agenticMesh = await import('agentic-mesh');
  } catch {
    return false;
  }

  const hubPeer = getHubMeshPeer();

  try {
    const gateway = agenticMesh.createFederationGateway(hubPeer.server, {
      localSystemId: config.localSystemId,
      remoteSystemId: config.remoteSystemId,
      remoteEndpoint: `mesh://${config.remoteMeshPeerId}`,
      auth: config.syncToken
        ? { method: 'bearer' as const, credentials: config.syncToken }
        : undefined,
      routing: {
        maxHops: config.maxHops ?? 3,
        trackPath: true,
      },
      buffer: {
        enabled: true,
        maxMessages: 10_000,
        maxAgeMs: 43_200_000, // 12 hours
        overflowStrategy: 'drop-oldest' as const,
      },
      reconnection: {
        enabled: true,
        maxRetries: 10,
        initialDelayMs: 5_000,
        maxDelayMs: 60_000,
      },
    });

    // Listen for inbound sync events
    gateway.on('message:received', (envelope: any) => {
      const channel = getChannel('proto:federation');
      channel?.recordReceived(envelope, config.remoteMeshPeerId);

      if (inboundHandler) {
        const payload = envelope?.payload ?? envelope;
        const events = payload?.events ?? [];
        const senderSeq = payload?.sender_seq ?? 0;
        const traceId = payload?.trace_id ?? '';
        inboundHandler(events, senderSeq, traceId);
      }
    });

    gateway.on('error', (err: Error) => {
      console.error(`[sync-federation] Gateway error for ${config.remoteSystemId}:`, err.message);
    });

    gateway.on('connected', () => {
      console.log(`[sync-federation] Gateway connected to ${config.remoteSystemId}`);
      const entry = gateways.get(config.remoteMeshPeerId);
      if (entry) entry.isConnected = true;
    });

    gateway.on('disconnected', () => {
      console.log(`[sync-federation] Gateway disconnected from ${config.remoteSystemId}`);
      const entry = gateways.get(config.remoteMeshPeerId);
      if (entry) entry.isConnected = false;
    });

    gateways.set(config.remoteMeshPeerId, {
      peerId: config.remoteMeshPeerId,
      remoteSystemId: config.remoteSystemId,
      gateway,
      isConnected: false,
    });

    console.log(`[sync-federation] Created gateway for peer ${config.remoteMeshPeerId} (system: ${config.remoteSystemId})`);
    return true;
  } catch (err) {
    console.error(`[sync-federation] Failed to create gateway for ${config.remoteMeshPeerId}:`, err);
    return false;
  }
}

/**
 * Push sync events via a FederationGateway instead of HTTP.
 * Returns true if routed successfully, false to fall back to HTTP.
 */
export async function pushViaGateway(
  meshPeerId: string,
  events: Array<{
    id: string;
    event_type: string;
    origin_instance_id: string;
    origin_ts: string;
    payload: unknown;
    signature: string;
  }>,
  senderSeq: number,
  traceId: string,
): Promise<boolean> {
  const entry = gateways.get(meshPeerId);
  if (!entry) return false;

  try {
    const message = {
      jsonrpc: '2.0',
      method: 'sync/push',
      params: { events, sender_seq: senderSeq, trace_id: traceId },
    };

    // Route via gateway — it handles buffering if remote is offline
    const gw = entry.gateway as any;
    if (typeof gw.route === 'function') {
      await gw.route(message, []);
    } else {
      // Fallback: use hub peer send
      const hubPeer = getHubMeshPeer();
      await hubPeer.send('openhive-hub', meshPeerId, message);
    }

    // Track stats only — the gateway already delivered the message
    const channel = getChannel('proto:federation');
    if (channel) {
      channel.recordSent();
    }

    return true;
  } catch (err) {
    console.error(`[sync-federation] Push via gateway failed for ${meshPeerId}:`, err);
    return false;
  }
}

/**
 * Check if a gateway exists for a given mesh peer ID.
 */
export function hasGateway(meshPeerId: string): boolean {
  return gateways.has(meshPeerId);
}

/**
 * Get gateway connection status.
 */
export function getGatewayStatus(meshPeerId: string): { connected: boolean; buffered: number } | null {
  const entry = gateways.get(meshPeerId);
  if (!entry) return null;

  const gw = entry.gateway as any;
  return {
    connected: entry.isConnected,
    buffered: typeof gw.bufferedMessageCount === 'number' ? gw.bufferedMessageCount : 0,
  };
}

/**
 * Clean up all gateways.
 */
export async function closeAllGateways(): Promise<void> {
  for (const [peerId, entry] of gateways) {
    try {
      const gw = entry.gateway as any;
      if (typeof gw.disconnect === 'function') {
        await gw.disconnect('shutdown');
      }
    } catch {
      // Ignore cleanup errors
    }
  }
  gateways.clear();
  inboundHandler = null;
}
