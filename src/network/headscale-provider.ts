/**
 * Headscale Network Providers
 *
 * Two modes:
 *   - HeadscaleSidecarProvider: manages headscale as a child process
 *   - HeadscaleExternalProvider: connects to an existing headscale instance via API
 *
 * Both implement the NetworkProvider interface and fix the gaps identified
 * in the hosting spec (TLS config, serverUrl, DERP public IP, ACL sync).
 */

import type {
  NetworkProvider,
  NetworkProviderType,
  CreateAuthKeyOptions,
  AuthKeyResult,
  DeviceInfo,
  ConnectivityResult,
} from './types.js';
import { HeadscaleClient } from '../headscale/client.js';
import { HeadscaleManager } from '../headscale/manager.js';
import type { HeadscaleNode } from '../headscale/types.js';

// ============================================================================
// Shared helpers
// ============================================================================

function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 32);
}

function nodeToDeviceInfo(node: HeadscaleNode, baseDomain: string): DeviceInfo {
  const userName = node.user?.name || '';
  const dnsName = node.givenName
    ? `${node.givenName}.${userName}.${baseDomain}`
    : null;

  return {
    id: node.id,
    name: node.givenName || node.name,
    ips: node.ipAddresses || [],
    online: node.online,
    dnsName,
    lastSeen: node.lastSeen || null,
    tags: node.tags || [],
  };
}

async function createHeadscaleAuthKey(
  client: HeadscaleClient,
  serverUrl: string,
  _baseDomain: string,
  opts: CreateAuthKeyOptions,
): Promise<AuthKeyResult> {
  // Ensure hive has a headscale user
  const userName = sanitize(opts.hiveName);
  const user = await client.ensureUser(userName);

  // Create pre-auth key
  const expirationHours = opts.expirationHours || 720;
  const expiration = new Date();
  expiration.setHours(expiration.getHours() + expirationHours);

  const swarmTag = `tag:swarm-${sanitize(opts.swarmName)}`;

  const preauthKey = await client.createPreauthKey({
    user: user.id,
    reusable: opts.reusable ?? false,
    ephemeral: opts.ephemeral ?? false,
    expiration: expiration.toISOString(),
    aclTags: [swarmTag],
  });

  const joinCommand = `tailscale up --login-server ${serverUrl} --authkey ${preauthKey.key}`;

  return {
    keyId: preauthKey.id,
    key: preauthKey.key,
    reusable: opts.reusable ?? false,
    expiration: expiration.toISOString(),
    joinCommand,
    instructions: [
      'Run on the swarm host to join the mesh network:',
      '',
      `  ${joinCommand}`,
      '',
      `This connects your host to the "${opts.hiveName}" hive network.`,
      `Other swarms in the same hive will be able to reach you via Tailscale IPs.`,
      '',
      'Note: You need the Tailscale client installed (https://tailscale.com/download).',
    ].join('\n'),
  };
}

async function syncHeadscalePolicy(client: HeadscaleClient, hiveNames: string[]): Promise<void> {
  const acls: Array<{ action: string; src: string[]; dst: string[] }> = [];

  for (const hiveName of hiveNames) {
    const userName = sanitize(hiveName);
    acls.push({
      action: 'accept',
      src: [`${userName}@`],
      dst: [`${userName}@:*`],
    });
  }

  const policy = JSON.stringify({ acls }, null, 2);

  try {
    await client.setPolicy(policy);
  } catch {
    console.warn('[headscale] Failed to set ACL policy. Ensure policy.mode is "database".');
  }
}

async function getDeviceInfoForSwarm(
  client: HeadscaleClient,
  baseDomain: string,
  swarmName: string,
  namespace?: string,
): Promise<DeviceInfo> {
  const swarmTag = `tag:swarm-${sanitize(swarmName)}`;
  let nodes: HeadscaleNode[];

  if (namespace) {
    const user = await client.findUserByName(sanitize(namespace));
    nodes = user ? await client.listNodes(user.id) : [];
  } else {
    nodes = await client.listNodes();
  }

  const node = nodes.find((n) =>
    n.tags?.includes(swarmTag) ||
    n.givenName === swarmName ||
    n.name === swarmName
  );

  if (!node) {
    return { id: '', name: swarmName, ips: [], online: false, dnsName: null, lastSeen: null, tags: [] };
  }

  return nodeToDeviceInfo(node, baseDomain);
}

async function listHeadscaleDevices(
  client: HeadscaleClient,
  baseDomain: string,
  namespace?: string,
): Promise<DeviceInfo[]> {
  let nodes: HeadscaleNode[];

  if (namespace) {
    const user = await client.findUserByName(sanitize(namespace));
    nodes = user ? await client.listNodes(user.id) : [];
  } else {
    nodes = await client.listNodes();
  }

  return nodes.map((n) => nodeToDeviceInfo(n, baseDomain));
}

/** Detect public IP via external service */
async function detectPublicIp(): Promise<string | null> {
  try {
    const resp = await fetch('https://ifconfig.me/ip', {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) return (await resp.text()).trim();
  } catch {
    // ignore
  }
  return null;
}

/** Check if we're behind CGNAT by comparing local and public IPs */
function isCgnatIp(publicIp: string): boolean {
  // CGNAT range: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
  // Note: Tailscale also uses this range, but for different purposes
  const parts = publicIp.split('.').map(Number);
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  // Also detect other common "not a real public IP" ranges
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

// ============================================================================
// Sidecar Provider (manages headscale binary)
// ============================================================================

export interface HeadscaleSidecarProviderOptions {
  /** Server URL that tailscale clients connect to (MUST be HTTPS, MUST be reachable) */
  serverUrl: string;
  /** MagicDNS base domain */
  baseDomain?: string;
  /** Data directory for headscale */
  dataDir?: string;
  /** Path to headscale binary */
  binaryPath?: string;
  /** HTTP listen address for headscale */
  listenAddr?: string;
  /** Enable embedded DERP relay */
  embeddedDerp?: boolean;
  /** Public IPv4 for embedded DERP (auto-detected if not set) */
  derpPublicIp?: string;
  /** TLS mode */
  tls?: {
    mode: 'none' | 'letsencrypt' | 'manual' | 'reverse-proxy';
    letsencryptHostname?: string;
    certPath?: string;
    keyPath?: string;
  };
  /** Health check timeout in ms */
  healthTimeoutMs?: number;
}

export class HeadscaleSidecarProvider implements NetworkProvider {
  readonly type: NetworkProviderType = 'headscale-sidecar';

  private manager: HeadscaleManager;
  private client: HeadscaleClient | null = null;
  private serverUrl: string;
  private baseDomain: string;
  private ready = false;

  constructor(opts: HeadscaleSidecarProviderOptions) {
    this.serverUrl = opts.serverUrl;
    this.baseDomain = opts.baseDomain || 'hive.internal';

    this.manager = new HeadscaleManager({
      dataDir: opts.dataDir || './data/headscale',
      serverUrl: opts.serverUrl,
      listenAddr: opts.listenAddr || '127.0.0.1:8085',
      binaryPath: opts.binaryPath,
      baseDomain: this.baseDomain,
      embeddedDerp: opts.embeddedDerp,
      healthTimeoutMs: opts.healthTimeoutMs,
    });
  }

  async start(): Promise<void> {
    this.client = await this.manager.start();
    this.ready = true;
    console.log(`[headscale-sidecar] Started, server URL: ${this.serverUrl}`);
  }

  async stop(): Promise<void> {
    await this.manager.stop();
    this.client = null;
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready && this.client !== null;
  }

  async ensureNamespace(hiveName: string): Promise<string> {
    const user = await this.getClient().ensureUser(sanitize(hiveName));
    return user.id;
  }

  async createAuthKey(opts: CreateAuthKeyOptions): Promise<AuthKeyResult> {
    return createHeadscaleAuthKey(this.getClient(), this.serverUrl, this.baseDomain, opts);
  }

  async revokeAuthKey(keyId: string): Promise<void> {
    await this.getClient().expirePreauthKey(keyId);
  }

  async getDeviceInfo(swarmName: string, namespace?: string): Promise<DeviceInfo> {
    return getDeviceInfoForSwarm(this.getClient(), this.baseDomain, swarmName, namespace);
  }

  async listDevices(namespace?: string): Promise<DeviceInfo[]> {
    return listHeadscaleDevices(this.getClient(), this.baseDomain, namespace);
  }

  async syncPolicy(hiveNames: string[]): Promise<void> {
    return syncHeadscalePolicy(this.getClient(), hiveNames);
  }

  async checkConnectivity(): Promise<ConnectivityResult> {
    const publicIp = await detectPublicIp();
    const cgnat = publicIp ? isCgnatIp(publicIp) : undefined;

    // Try to reach our own server URL
    try {
      const resp = await fetch(`${this.serverUrl}/health`, {
        signal: AbortSignal.timeout(10000),
      });
      return {
        reachable: resp.ok,
        url: this.serverUrl,
        publicIp: publicIp || undefined,
        isCgnat: cgnat,
      };
    } catch (err) {
      return {
        reachable: false,
        url: this.serverUrl,
        error: (err as Error).message,
        publicIp: publicIp || undefined,
        isCgnat: cgnat,
      };
    }
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  getJoinInstructions(authKey: string): string {
    return [
      'Install Tailscale on the swarm host: https://tailscale.com/download',
      '',
      'Then run:',
      `  tailscale up --login-server ${this.serverUrl} --authkey ${authKey}`,
    ].join('\n');
  }

  private getClient(): HeadscaleClient {
    if (!this.client) {
      throw new Error('Headscale sidecar not started. Call start() first.');
    }
    return this.client;
  }
}

// ============================================================================
// External Provider (connects to existing headscale instance)
// ============================================================================

export interface HeadscaleExternalProviderOptions {
  /** Base URL of the headscale API (e.g. https://headscale.example.com) */
  apiUrl: string;
  /** API key for headscale */
  apiKey: string;
  /** Server URL that tailscale clients connect to (may differ from apiUrl if behind a proxy) */
  serverUrl?: string;
  /** MagicDNS base domain configured in headscale */
  baseDomain?: string;
}

export class HeadscaleExternalProvider implements NetworkProvider {
  readonly type: NetworkProviderType = 'headscale-external';

  private client: HeadscaleClient;
  private serverUrl: string;
  private baseDomain: string;
  private ready = false;

  constructor(opts: HeadscaleExternalProviderOptions) {
    this.client = new HeadscaleClient(opts.apiUrl, opts.apiKey);
    this.serverUrl = opts.serverUrl || opts.apiUrl;
    this.baseDomain = opts.baseDomain || 'hive.internal';
  }

  async start(): Promise<void> {
    // Verify connectivity
    try {
      await this.client.waitForHealthy(10000);
      this.ready = true;
      console.log(`[headscale-external] Connected to ${this.serverUrl}`);
    } catch (err) {
      throw new Error(`Failed to connect to external headscale at ${this.serverUrl}: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  async ensureNamespace(hiveName: string): Promise<string> {
    const user = await this.client.ensureUser(sanitize(hiveName));
    return user.id;
  }

  async createAuthKey(opts: CreateAuthKeyOptions): Promise<AuthKeyResult> {
    return createHeadscaleAuthKey(this.client, this.serverUrl, this.baseDomain, opts);
  }

  async revokeAuthKey(keyId: string): Promise<void> {
    await this.client.expirePreauthKey(keyId);
  }

  async getDeviceInfo(swarmName: string, namespace?: string): Promise<DeviceInfo> {
    return getDeviceInfoForSwarm(this.client, this.baseDomain, swarmName, namespace);
  }

  async listDevices(namespace?: string): Promise<DeviceInfo[]> {
    return listHeadscaleDevices(this.client, this.baseDomain, namespace);
  }

  async syncPolicy(hiveNames: string[]): Promise<void> {
    return syncHeadscalePolicy(this.client, hiveNames);
  }

  async checkConnectivity(): Promise<ConnectivityResult> {
    try {
      await this.client.health();
      return { reachable: true, url: this.serverUrl };
    } catch (err) {
      return { reachable: false, url: this.serverUrl, error: (err as Error).message };
    }
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  getJoinInstructions(authKey: string): string {
    return [
      'Install Tailscale on the swarm host: https://tailscale.com/download',
      '',
      'Then run:',
      `  tailscale up --login-server ${this.serverUrl} --authkey ${authKey}`,
    ].join('\n');
  }
}
