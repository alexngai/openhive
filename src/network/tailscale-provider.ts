/**
 * Tailscale Cloud Network Provider
 *
 * Uses the Tailscale SaaS API (api.tailscale.com) for mesh networking.
 * No local binary, no port forwarding, no TLS certs — Tailscale handles
 * all the infrastructure. Just needs an API key or OAuth credentials.
 *
 * Mapping:
 *   - Hive → ACL tag group (tag:hive-<name>)
 *   - Swarm → Auth key with tag (tag:swarm-<name>)
 *   - Swarm host → Tailscale device
 *
 * Unlike headscale (which has "users" as namespace boundaries), Tailscale
 * Cloud uses a single tailnet with ACL tags for access control. So hive
 * isolation is enforced via ACL rules, not separate namespaces.
 */

import type {
  NetworkProvider,
  NetworkProviderType,
  CreateAuthKeyOptions,
  AuthKeyResult,
  DeviceInfo,
  ConnectivityResult,
} from './types.js';
import { TailscaleClient, type TailscaleClientOptions, type TailscaleDevice } from './tailscale-client.js';

export interface TailscaleProviderOptions extends TailscaleClientOptions {
  /** Tag prefix for hive groups (default: 'hive') */
  hiveTagPrefix?: string;
  /** Tag prefix for swarm devices (default: 'swarm') */
  swarmTagPrefix?: string;
}

export class TailscaleCloudProvider implements NetworkProvider {
  readonly type: NetworkProviderType = 'tailscale-cloud';

  private client: TailscaleClient;
  private ready = false;
  private hiveTagPrefix: string;
  private swarmTagPrefix: string;

  constructor(opts: TailscaleProviderOptions) {
    this.client = new TailscaleClient(opts);
    this.hiveTagPrefix = opts.hiveTagPrefix || 'hive';
    this.swarmTagPrefix = opts.swarmTagPrefix || 'swarm';
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    // Verify API access by listing devices
    try {
      await this.client.listDevices('default');
      this.ready = true;
      console.log('[tailscale] Connected to Tailscale API');
    } catch (err) {
      throw new Error(`Failed to connect to Tailscale API: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  // --------------------------------------------------------------------------
  // Namespace (hive → ACL tag group)
  // --------------------------------------------------------------------------

  async ensureNamespace(hiveName: string): Promise<string> {
    // In Tailscale Cloud, namespaces are ACL tag groups.
    // We ensure the ACL policy has a tag:hive-<name> defined.
    // For now, just return the tag name — actual ACL sync happens in syncPolicy().
    return `tag:${this.hiveTagPrefix}-${this.sanitize(hiveName)}`;
  }

  // --------------------------------------------------------------------------
  // Auth Keys
  // --------------------------------------------------------------------------

  async createAuthKey(opts: CreateAuthKeyOptions): Promise<AuthKeyResult> {
    const hiveTag = `tag:${this.hiveTagPrefix}-${this.sanitize(opts.hiveName)}`;
    const swarmTag = `tag:${this.swarmTagPrefix}-${this.sanitize(opts.swarmName)}`;
    const expirySeconds = (opts.expirationHours || 720) * 3600;

    const key = await this.client.createAuthKey({
      capabilities: {
        devices: {
          create: {
            reusable: opts.reusable ?? false,
            ephemeral: opts.ephemeral ?? false,
            preauthorized: true, // auto-approve — no manual step
            tags: [hiveTag, swarmTag],
          },
        },
      },
      expirySeconds,
      description: `OpenHive: swarm "${opts.swarmName}" in hive "${opts.hiveName}"`,
    });

    const expiration = new Date(key.expires).toISOString();
    const joinCommand = `tailscale up --authkey ${key.key}`;

    return {
      keyId: key.id,
      key: key.key,
      reusable: opts.reusable ?? false,
      expiration,
      joinCommand,
      instructions: [
        'Run on the swarm host to join the mesh network:',
        '',
        `  ${joinCommand}`,
        '',
        `This connects your host to the Tailscale network with tags ${hiveTag}, ${swarmTag}.`,
        `Other swarms in the "${opts.hiveName}" hive will be able to reach you via Tailscale IPs.`,
        '',
        'Note: You need the Tailscale client installed (https://tailscale.com/download).',
      ].join('\n'),
    };
  }

  async revokeAuthKey(keyId: string): Promise<void> {
    await this.client.deleteAuthKey(keyId);
  }

  // --------------------------------------------------------------------------
  // Devices
  // --------------------------------------------------------------------------

  async getDeviceInfo(swarmName: string, namespace?: string): Promise<DeviceInfo> {
    const swarmTag = `tag:${this.swarmTagPrefix}-${this.sanitize(swarmName)}`;
    const hiveTag = namespace ? `tag:${this.hiveTagPrefix}-${this.sanitize(namespace)}` : null;
    const devices = await this.client.listDevices('all');

    // Find by swarm tag first, then by hive tag + hostname
    const device = devices.find((d) =>
      d.tags?.includes(swarmTag) ||
      (hiveTag && d.tags?.includes(hiveTag) && d.hostname === swarmName) ||
      d.hostname === swarmName
    );

    if (!device) {
      return { id: '', name: swarmName, ips: [], online: false, dnsName: null, lastSeen: null, tags: [] };
    }

    return this.deviceToInfo(device);
  }

  async listDevices(namespace?: string): Promise<DeviceInfo[]> {
    const devices = await this.client.listDevices('all');

    if (namespace) {
      // Filter by hive tag
      const hiveTag = `tag:${this.hiveTagPrefix}-${this.sanitize(namespace)}`;
      return devices
        .filter((d) => d.tags?.includes(hiveTag))
        .map((d) => this.deviceToInfo(d));
    }

    return devices.map((d) => this.deviceToInfo(d));
  }

  // --------------------------------------------------------------------------
  // ACL Policy
  // --------------------------------------------------------------------------

  async syncPolicy(hiveNames: string[]): Promise<void> {
    // Build tag owners: OpenHive's auth keys can assign hive/swarm tags
    const tagOwners: Record<string, string[]> = {};
    const acls: Array<{ action: string; src: string[]; dst: string[] }> = [];

    for (const hiveName of hiveNames) {
      const hiveTag = `tag:${this.hiveTagPrefix}-${this.sanitize(hiveName)}`;
      // Tag owner must include autogroup:admin so the API can assign this tag
      tagOwners[hiveTag] = ['autogroup:admin'];

      // All devices in the same hive can communicate with each other
      acls.push({
        action: 'accept',
        src: [hiveTag],
        dst: [`${hiveTag}:*`],
      });
    }

    // Add swarm tag owners (any new swarm tag should be assignable)
    // Using a wildcard is not possible, so we'd need to track swarm names.
    // For now, add autogroup:admin as a catch-all tag owner.

    try {
      // Get existing policy to preserve any user-added rules
      const existing = await this.client.getPolicy();

      const policy: Record<string, unknown> = {
        ...existing,
        tagOwners: {
          ...(existing.tagOwners || {}),
          ...tagOwners,
        },
        acls: [
          ...acls,
          // Preserve any user-defined ACLs that aren't hive rules
          ...((existing.acls || []) as Array<{ src?: string[] }>).filter(
            (rule) => !rule.src?.some((s: string) => s.startsWith(`tag:${this.hiveTagPrefix}-`))
          ),
        ],
      };

      await this.client.setPolicy(policy);
    } catch (err) {
      console.warn(`[tailscale] Failed to sync ACL policy: ${(err as Error).message}`);
    }
  }

  // --------------------------------------------------------------------------
  // Connectivity
  // --------------------------------------------------------------------------

  async checkConnectivity(): Promise<ConnectivityResult> {
    // For Tailscale Cloud, the control server is always reachable (it's SaaS).
    // We just verify API access works.
    try {
      await this.client.listDevices('default');
      return {
        reachable: true,
        url: 'https://login.tailscale.com',
      };
    } catch (err) {
      return {
        reachable: false,
        url: 'https://login.tailscale.com',
        error: (err as Error).message,
      };
    }
  }

  getServerUrl(): string {
    // Tailscale Cloud — clients use the default server
    return 'https://login.tailscale.com';
  }

  getJoinInstructions(authKey: string): string {
    return [
      'Install Tailscale on the swarm host: https://tailscale.com/download',
      '',
      'Then run:',
      `  tailscale up --authkey ${authKey}`,
    ].join('\n');
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private deviceToInfo(device: TailscaleDevice): DeviceInfo {
    return {
      id: device.nodeId || device.id,
      name: device.hostname,
      ips: device.addresses || [],
      online: device.connectedToControl ?? this.isRecentlySeen(device.lastSeen),
      dnsName: device.name || null,
      lastSeen: device.lastSeen || null,
      tags: device.tags || [],
    };
  }

  private isRecentlySeen(lastSeen: string | undefined): boolean {
    if (!lastSeen) return false;
    const threshold = 5 * 60 * 1000; // 5 minutes
    return Date.now() - new Date(lastSeen).getTime() < threshold;
  }

  private sanitize(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 32);
  }
}
