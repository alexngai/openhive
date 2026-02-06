/**
 * Headscale Sync Layer
 *
 * @deprecated Use NetworkProvider (src/network/) instead. This module is kept
 * for backward compatibility but will be removed in a future release.
 * The NetworkProvider interface supports headscale-sidecar, headscale-external,
 * and tailscale-cloud backends with a unified API.
 *
 * Bridges OpenHive MAP hub entities to headscale:
 *   - Hive → Headscale User (namespace/discoverability boundary)
 *   - Swarm joining hive → Headscale pre-auth key (for the swarm's host to connect)
 *   - Headscale Node → Tailscale IP tracked on the MAP swarm
 *
 * Flow:
 *   1. Swarm registers with OpenHive and joins a hive
 *   2. Sync layer ensures the hive has a headscale user
 *   3. Sync layer creates a headscale pre-auth key for that user
 *   4. Swarm operator uses the key with `tailscale up --authkey <KEY>`
 *   5. Headscale assigns a 100.64.x.x IP to the swarm's host
 *   6. MAP peer lists include the tailscale IP so swarms can reach each other
 */

import type { HeadscaleClient } from './client.js';
import type { HeadscaleNode } from './types.js';

/**
 * Result of provisioning network access for a swarm joining a hive.
 */
export interface NetworkProvisionResult {
  /** Headscale user name (matches hive name) */
  headscale_user: string;
  /** Headscale pre-auth key for the swarm's host to use with `tailscale up` */
  auth_key: string;
  /** Whether the key is reusable */
  reusable: boolean;
  /** When the key expires */
  expiration: string;
  /** Instructions for the swarm operator */
  instructions: string;
}

/**
 * Tailscale network info for a swarm (after its host has connected).
 */
export interface SwarmNetworkInfo {
  /** Headscale node ID (if connected) */
  headscale_node_id: string | null;
  /** Tailscale-assigned IP addresses */
  tailscale_ips: string[];
  /** Whether the host is currently online on the tailnet */
  online: boolean;
  /** MagicDNS hostname */
  dns_name: string | null;
  /** Last seen timestamp */
  last_seen: string | null;
}

/** @deprecated Use NetworkProvider (src/network/) instead. */
export class HeadscaleSync {
  private client: HeadscaleClient;
  private baseDomain: string;
  private serverUrl: string;

  constructor(client: HeadscaleClient, baseDomain: string = 'hive.internal', serverUrl?: string) {
    this.client = client;
    this.baseDomain = baseDomain;
    this.serverUrl = serverUrl || '';
  }

  // ==========================================================================
  // Hive → Headscale User
  // ==========================================================================

  /**
   * Ensure a headscale user exists for a hive.
   * Headscale users map 1:1 with OpenHive hives -- they define the network
   * boundary (who can discover/reach whom).
   */
  async ensureHiveUser(hiveName: string): Promise<string> {
    // Sanitize hive name for headscale (alphanumeric + hyphen, max 32 chars)
    const userName = this.sanitizeUserName(hiveName);
    const user = await this.client.ensureUser(userName);
    return user.id;
  }

  // ==========================================================================
  // Swarm → Pre-Auth Key
  // ==========================================================================

  /**
   * Provision network access for a swarm joining a hive.
   * Creates a headscale pre-auth key scoped to the hive's user.
   * The swarm operator uses this key with `tailscale up` to join the mesh.
   */
  async provisionSwarmAccess(
    hiveName: string,
    swarmName: string,
    opts: {
      reusable?: boolean;
      ephemeral?: boolean;
      expirationHours?: number;
    } = {}
  ): Promise<NetworkProvisionResult> {
    // Ensure the hive has a headscale user
    const userId = await this.ensureHiveUser(hiveName);

    // Create a pre-auth key for this swarm
    const expirationHours = opts.expirationHours || 720; // 30 days default
    const expiration = new Date();
    expiration.setHours(expiration.getHours() + expirationHours);

    const preauthKey = await this.client.createPreauthKey({
      user: userId,
      reusable: opts.reusable ?? false,
      ephemeral: opts.ephemeral ?? false,
      expiration: expiration.toISOString(),
      aclTags: [`tag:swarm-${this.sanitizeTag(swarmName)}`],
    });

    const serverUrl = await this.getServerUrl();

    return {
      headscale_user: this.sanitizeUserName(hiveName),
      auth_key: preauthKey.key,
      reusable: opts.reusable ?? false,
      expiration: expiration.toISOString(),
      instructions: [
        `Run on the swarm host to join the mesh network:`,
        ``,
        `  tailscale up --login-server ${serverUrl} --authkey ${preauthKey.key}`,
        ``,
        `This connects your host to the "${hiveName}" hive network.`,
        `Other swarms in the same hive will be able to reach you via Tailscale IPs.`,
      ].join('\n'),
    };
  }

  // ==========================================================================
  // Node Tracking
  // ==========================================================================

  /**
   * Look up network info for a swarm's host by searching headscale nodes.
   * Tries to match by swarm name tag or hostname.
   */
  async getSwarmNetworkInfo(swarmName: string, hiveName?: string): Promise<SwarmNetworkInfo> {
    const tag = `tag:swarm-${this.sanitizeTag(swarmName)}`;
    let nodes: HeadscaleNode[];

    if (hiveName) {
      const user = await this.client.findUserByName(this.sanitizeUserName(hiveName));
      nodes = user ? await this.client.listNodes(user.id) : [];
    } else {
      nodes = await this.client.listNodes();
    }

    // Find node by tag match
    const node = nodes.find((n) =>
      n.tags?.includes(tag) ||
      n.givenName === swarmName ||
      n.name === swarmName
    );

    if (!node) {
      return {
        headscale_node_id: null,
        tailscale_ips: [],
        online: false,
        dns_name: null,
        last_seen: null,
      };
    }

    const userName = this.sanitizeUserName(hiveName || node.user?.name || '');
    const dnsName = node.givenName
      ? `${node.givenName}.${userName}.${this.baseDomain}`
      : null;

    return {
      headscale_node_id: node.id,
      tailscale_ips: node.ipAddresses || [],
      online: node.online,
      dns_name: dnsName,
      last_seen: node.lastSeen || null,
    };
  }

  /**
   * Get all nodes in a hive's network, with their IPs and online status.
   * Used to enrich MAP peer lists with tailscale routing info.
   */
  async getHiveNodes(hiveName: string): Promise<Array<{
    node_id: string;
    name: string;
    ips: string[];
    online: boolean;
    tags: string[];
  }>> {
    const userName = this.sanitizeUserName(hiveName);
    const user = await this.client.findUserByName(userName);
    if (!user) return [];

    const nodes = await this.client.listNodes(user.id);
    return nodes.map((n) => ({
      node_id: n.id,
      name: n.givenName || n.name,
      ips: n.ipAddresses || [],
      online: n.online,
      tags: n.tags || [],
    }));
  }

  /**
   * Generate an ACL policy that allows all nodes within each hive to communicate,
   * and optionally allows cross-hive communication for shared swarms.
   */
  async syncAclPolicy(hiveNames: string[]): Promise<void> {
    const acls: Array<{ action: string; src: string[]; dst: string[] }> = [];

    // Each hive's nodes can communicate freely
    for (const hiveName of hiveNames) {
      const userName = this.sanitizeUserName(hiveName);
      acls.push({
        action: 'accept',
        src: [`${userName}@`],
        dst: [`${userName}@:*`],
      });
    }

    const policy = JSON.stringify({ acls }, null, 2);

    try {
      await this.client.setPolicy(policy);
    } catch {
      // Policy might not be in database mode, or headscale version doesn't support it
      console.warn('[headscale-sync] Failed to set ACL policy. Ensure policy.mode is "database" in headscale config.');
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private sanitizeUserName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 32);
  }

  private sanitizeTag(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private async getServerUrl(): Promise<string> {
    if (this.serverUrl) return this.serverUrl;
    // Fallback: try health endpoint to verify connectivity, but we can't
    // derive the external URL from it. Return empty to signal misconfiguration.
    try {
      await this.client.health();
    } catch {
      // ignore
    }
    return this.serverUrl || '(server-url-not-configured)';
  }
}
