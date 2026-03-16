/**
 * Mesh Peer — agentic-mesh integration for OpenHive MAP Hub
 *
 * Initializes an embedded MeshPeer so the hub can accept mesh transport
 * connections alongside WebSocket. The MeshPeer wraps a MapServer that
 * handles agent registration, message routing, and federation for
 * mesh-connected swarms.
 *
 * Dynamic import of agentic-mesh: the server boots cleanly without it.
 */

import { mapHubEvents } from './service.js';

// Types for agentic-mesh (dynamic import)
export type MeshPeerInstance = {
  peerId: string;
  server: {
    systemId: string;
    registerAgent(params: Record<string, unknown>): unknown;
    unregisterAgent(agentId: string, reason?: string): unknown;
    listAgents(filter?: Record<string, unknown>): unknown[];
    setMessageHandler(agentId: string, handler: (msg: unknown) => void): void;
    removeMessageHandler(agentId: string): void;
    send(from: string, to: unknown, payload: unknown, meta?: Record<string, unknown>): Promise<unknown>;
    getSystemInfo(): Record<string, unknown>;
  };
  start(transport?: unknown): Promise<void>;
  stop(): Promise<void>;
  connectToPeer(endpoint: { peerId: string; address: string; port?: number }): Promise<unknown>;
  disconnectFromPeer(peerId: string, reason?: string): Promise<void>;
  getPeerConnection(peerId: string): unknown | undefined;
  getLocalAgents(): unknown[];
  getAllAgents(): unknown[];
  send(from: string, to: unknown, payload: unknown, meta?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
};

let meshPeer: MeshPeerInstance | null = null;

export interface MeshPeerConfig {
  enabled: boolean;
  peerId?: string;
  transport?: {
    type?: 'tcp' | 'nebula' | 'tailscale' | 'headscale';
    listenAddr?: string;
    listenPort?: number;
  };
}

/**
 * Initialize the hub's MeshPeer with an embedded MapServer.
 * Dynamic import so the server boots without agentic-mesh installed.
 */
export async function initMeshPeer(config: MeshPeerConfig): Promise<void> {
  if (meshPeer) return; // Already initialized

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let agenticMesh: any;
  try {
    agenticMesh = await import('agentic-mesh');
  } catch {
    console.warn('[mesh-peer] agentic-mesh not installed — mesh transport disabled');
    return;
  }

  const peerId = config.peerId || 'openhive-hub';
  const transport = config.transport ?? {};

  // When no real network transport is specified (or tcp default), create the MeshPeer
  // without a transport — the embedded MapServer is fully functional for in-process
  // agent registration, message routing, and event delivery. Peer connections can be
  // established via linked streams or by emitting events directly.
  //
  // When a non-tcp transport is configured (nebula, tailscale, headscale), create
  // a full MeshPeer with that transport for real network connectivity.
  let peer: MeshPeerInstance;
  const hasNetworkTransport = transport.type && transport.type !== 'tcp';

  if (hasNetworkTransport) {
    peer = new agenticMesh.MeshPeer({
      peerId,
      peerName: 'OpenHive Hub',
      transport: {
        type: transport.type,
        config: {
          listenAddr: transport.listenAddr || '0.0.0.0',
          listenPort: transport.listenPort || 9090,
        },
      },
    });
  } else {
    // Embedded mode: in-process MapServer, no real networking required.
    peer = new agenticMesh.MeshPeer({ peerId, peerName: 'OpenHive Hub' });
  }

  // Wire MeshPeer events to OpenHive's mapHubEvents
  peer.on('peer:connected', (remotePeerId: unknown) => {
    console.log(`[mesh-peer] Peer connected: ${remotePeerId}`);
    mapHubEvents.emit('mesh_peer_connected', { peerId: remotePeerId });
  });

  peer.on('peer:disconnected', (remotePeerId: unknown) => {
    console.log(`[mesh-peer] Peer disconnected: ${remotePeerId}`);
    mapHubEvents.emit('mesh_peer_disconnected', { peerId: remotePeerId });
  });

  peer.on('agent:registered', (agent: unknown) => {
    mapHubEvents.emit('mesh_agent_registered', agent);
  });

  peer.on('agent:unregistered', (agent: unknown) => {
    mapHubEvents.emit('mesh_agent_unregistered', agent);
  });

  peer.on('error', (err: unknown) => {
    console.error('[mesh-peer] MeshPeer error:', err);
  });

  // Only call start() when a real network transport is configured.
  // In embedded mode the MapServer is already functional without start().
  if (hasNetworkTransport) {
    await peer.start();
  }
  meshPeer = peer;
  console.log(`[openhive] MeshPeer initialized (peerId: ${peerId}, mode: ${hasNetworkTransport ? transport.type : 'embedded'})`);
}

/**
 * Stop the hub's MeshPeer.
 */
export async function stopMeshPeer(): Promise<void> {
  if (!meshPeer) return;
  await meshPeer.stop();
  meshPeer = null;
  console.log('[mesh-peer] MeshPeer stopped');
}

/**
 * Get the hub's MeshPeer instance.
 */
export function getHubMeshPeer(): MeshPeerInstance {
  if (!meshPeer) throw new Error('MeshPeer not initialized. Call initMeshPeer() first.');
  return meshPeer;
}

/**
 * Get the hub's embedded MapServer.
 */
export function getHubMapServer(): MeshPeerInstance['server'] {
  return getHubMeshPeer().server;
}

/**
 * Check if mesh transport is available (initialized and running).
 */
export function isMeshEnabled(): boolean {
  return meshPeer !== null;
}
