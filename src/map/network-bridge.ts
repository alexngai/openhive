/**
 * Network Bridge — L3/L4 ↔ L7 coordination
 *
 * Coordinates between the network provider (Tailscale/Headscale) and the
 * MAP swarm lifecycle. Handles:
 *
 * - Opt-in network provisioning at swarm registration time
 * - Network info cleanup on swarm deletion
 * - Auth key revocation when swarms are removed
 *
 * The network provider gives swarms WireGuard connectivity (NAT traversal,
 * mesh IPs). This bridge ensures that connectivity info flows into the
 * MAP layer (peer lists, sendToSwarm addresses) automatically.
 */

import type { NetworkProvider, AuthKeyResult } from '../network/types.js';
import * as mapDal from '../db/dal/map.js';

// ============================================================================
// Types
// ============================================================================

export interface NetworkProvisionOptions {
  /** Hive name — used as the network namespace */
  hive_name: string;
  /** Allow key to register multiple devices */
  reusable?: boolean;
  /** Devices auto-deregister when offline */
  ephemeral?: boolean;
  /** Key expiry in hours */
  expiration_hours?: number;
}

export interface NetworkProvisionResult extends AuthKeyResult {
  /** Swarm ID that was provisioned */
  swarm_id: string;
}

// ============================================================================
// Bridge State
// ============================================================================

let networkProvider: NetworkProvider | null = null;

/**
 * Initialize the network bridge with the active network provider.
 * Call at server startup after the provider is started.
 */
export function initNetworkBridge(provider: NetworkProvider): void {
  networkProvider = provider;
}

/**
 * Stop the network bridge. Called on server shutdown.
 */
export function stopNetworkBridge(): void {
  networkProvider = null;
}

/**
 * Check if a network provider is available and ready.
 */
export function isNetworkAvailable(): boolean {
  return networkProvider !== null
    && networkProvider.type !== 'none'
    && networkProvider.isReady();
}

// ============================================================================
// Provisioning
// ============================================================================

/**
 * Provision network access for a swarm.
 * Creates an auth key via the network provider and returns join instructions.
 *
 * This is called either:
 * - At registration time if `provision_network` is set in the input
 * - Explicitly via POST /map/swarms/:id/network
 */
export async function provisionSwarmNetwork(
  swarmId: string,
  opts: NetworkProvisionOptions,
): Promise<NetworkProvisionResult> {
  if (!networkProvider || !isNetworkAvailable()) {
    throw new NetworkBridgeError(
      'PROVIDER_NOT_AVAILABLE',
      'No mesh network provider configured or not ready',
    );
  }

  const swarm = mapDal.findSwarmById(swarmId);
  if (!swarm) {
    throw new NetworkBridgeError('SWARM_NOT_FOUND', 'Swarm not found');
  }

  const result = await networkProvider.createAuthKey({
    hiveName: opts.hive_name,
    swarmName: swarm.name || swarmId,
    reusable: opts.reusable,
    ephemeral: opts.ephemeral,
    expirationHours: opts.expiration_hours,
  });

  return { ...result, swarm_id: swarmId };
}

/**
 * Refresh stored network info for a swarm from the network provider.
 * Queries the provider for device info and updates the swarm record.
 */
export async function refreshSwarmNetworkInfo(
  swarmId: string,
): Promise<{ ips: string[]; dnsName: string | null } | null> {
  if (!networkProvider || !isNetworkAvailable()) return null;

  const swarm = mapDal.findSwarmById(swarmId);
  if (!swarm) return null;

  // Use the swarm's first hive as the namespace (matches existing convention)
  const hives = mapDal.getSwarmHiveNames(swarmId);

  try {
    const deviceInfo = await networkProvider.getDeviceInfo(swarm.name, hives[0]);

    if (deviceInfo.id) {
      mapDal.updateSwarm(swarmId, {
        headscale_node_id: deviceInfo.id,
        tailscale_ips: deviceInfo.ips,
        tailscale_dns_name: deviceInfo.dnsName || undefined,
      });

      return { ips: deviceInfo.ips, dnsName: deviceInfo.dnsName };
    }
  } catch (err) {
    console.error(`[network-bridge] Failed to refresh network info for swarm ${swarmId}:`, err);
  }

  return null;
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Revoke network access for a swarm.
 * Called when a swarm is deleted to clean up auth keys and device registrations.
 */
export async function revokeSwarmNetwork(swarmId: string): Promise<void> {
  if (!networkProvider || !isNetworkAvailable()) return;

  const swarm = mapDal.findSwarmById(swarmId);
  if (!swarm) return;

  // If we have a headscale node ID, try to revoke it
  if (swarm.headscale_node_id) {
    try {
      await networkProvider.revokeAuthKey(swarm.headscale_node_id);
    } catch (err) {
      // Non-fatal — the swarm is being deleted anyway
      console.error(`[network-bridge] Failed to revoke auth key for swarm ${swarmId}:`, err);
    }
  }
}

/**
 * Get network info for a swarm from the DB (no provider call).
 */
export function getSwarmNetworkInfo(swarmId: string): {
  headscale_node_id: string | null;
  tailscale_ips: string[] | null;
  tailscale_dns_name: string | null;
  mesh_peer_id: string | null;
} | null {
  const swarm = mapDal.findSwarmById(swarmId);
  if (!swarm) return null;

  return {
    headscale_node_id: swarm.headscale_node_id,
    tailscale_ips: swarm.tailscale_ips,
    tailscale_dns_name: swarm.tailscale_dns_name,
    mesh_peer_id: swarm.mesh_peer_id,
  };
}

// ============================================================================
// Error Type
// ============================================================================

export type NetworkBridgeErrorCode =
  | 'PROVIDER_NOT_AVAILABLE'
  | 'SWARM_NOT_FOUND';

export class NetworkBridgeError extends Error {
  code: NetworkBridgeErrorCode;

  constructor(code: NetworkBridgeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'NetworkBridgeError';
  }
}
