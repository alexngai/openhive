/**
 * Network Provider Interface
 *
 * Abstracts over different mesh networking backends (Tailscale Cloud, headscale
 * sidecar, external headscale). The MAP hub uses this interface to provision
 * network access and query connectivity info without caring which backend is
 * in use.
 */

// ============================================================================
// Provider interface
// ============================================================================

export type NetworkProviderType = 'tailscale-cloud' | 'headscale-sidecar' | 'headscale-external' | 'none';

export interface NetworkProvider {
  /** Which backend this is */
  readonly type: NetworkProviderType;

  /** Start the provider (connect to API, start sidecar process, etc.) */
  start(): Promise<void>;

  /** Stop the provider (stop sidecar process, cleanup) */
  stop(): Promise<void>;

  /** Whether the provider is ready to accept requests */
  isReady(): boolean;

  // --------------------------------------------------------------------------
  // Namespace management (hive → tailnet user/namespace)
  // --------------------------------------------------------------------------

  /** Ensure a namespace exists for the given hive. Returns the namespace ID. */
  ensureNamespace(hiveName: string): Promise<string>;

  // --------------------------------------------------------------------------
  // Auth key management (swarm → pre-auth key)
  // --------------------------------------------------------------------------

  /** Create a pre-auth key for a swarm to join the mesh */
  createAuthKey(opts: CreateAuthKeyOptions): Promise<AuthKeyResult>;

  /** Revoke a previously created auth key */
  revokeAuthKey(keyId: string): Promise<void>;

  // --------------------------------------------------------------------------
  // Device/node queries
  // --------------------------------------------------------------------------

  /** Look up network info for a specific swarm by name/tag */
  getDeviceInfo(swarmName: string, namespace?: string): Promise<DeviceInfo>;

  /** List all devices in a namespace */
  listDevices(namespace?: string): Promise<DeviceInfo[]>;

  // --------------------------------------------------------------------------
  // ACL / policy management
  // --------------------------------------------------------------------------

  /** Sync ACL policy so devices in the same hive can communicate */
  syncPolicy(hiveNames: string[]): Promise<void>;

  // --------------------------------------------------------------------------
  // Connectivity check
  // --------------------------------------------------------------------------

  /** Check if the control server is reachable from the internet */
  checkConnectivity(): Promise<ConnectivityResult>;

  /** Get the URL that tailscale clients should connect to */
  getServerUrl(): string;

  /** Get instructions for connecting a swarm host */
  getJoinInstructions(authKey: string): string;
}

// ============================================================================
// Shared types
// ============================================================================

export interface CreateAuthKeyOptions {
  /** Hive name (namespace/user) */
  hiveName: string;
  /** Swarm name (used for tagging) */
  swarmName: string;
  /** Whether the key can register multiple devices */
  reusable?: boolean;
  /** Whether devices auto-deregister when offline */
  ephemeral?: boolean;
  /** Key expiry in hours (default: 720 = 30 days) */
  expirationHours?: number;
}

export interface AuthKeyResult {
  /** Provider-specific key ID (for revocation) */
  keyId: string;
  /** The auth key value (only available at creation time) */
  key: string;
  /** Whether the key is reusable */
  reusable: boolean;
  /** When the key expires (ISO 8601) */
  expiration: string;
  /** Shell command to join the mesh */
  joinCommand: string;
  /** Human-readable instructions */
  instructions: string;
}

export interface DeviceInfo {
  /** Provider-specific device/node ID */
  id: string;
  /** Device hostname */
  name: string;
  /** Assigned mesh IPs (e.g. 100.64.x.y) */
  ips: string[];
  /** Whether the device is currently connected */
  online: boolean;
  /** MagicDNS hostname (if available) */
  dnsName: string | null;
  /** Last seen timestamp (ISO 8601) */
  lastSeen: string | null;
  /** Tags on the device */
  tags: string[];
}

export interface ConnectivityResult {
  /** Whether the control server is reachable */
  reachable: boolean;
  /** The URL that was checked */
  url: string;
  /** Error message if not reachable */
  error?: string;
  /** Detected public IP (if available) */
  publicIp?: string;
  /** Whether CGNAT was detected */
  isCgnat?: boolean;
}

// ============================================================================
// No-op provider (when networking is disabled)
// ============================================================================

export class NoopNetworkProvider implements NetworkProvider {
  readonly type: NetworkProviderType = 'none';

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isReady(): boolean { return false; }

  async ensureNamespace(): Promise<string> {
    throw new Error('Network provider not configured. Enable tailscale or headscale in config.');
  }

  async createAuthKey(): Promise<AuthKeyResult> {
    throw new Error('Network provider not configured. Enable tailscale or headscale in config.');
  }

  async revokeAuthKey(): Promise<void> {
    throw new Error('Network provider not configured. Enable tailscale or headscale in config.');
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    return { id: '', name: '', ips: [], online: false, dnsName: null, lastSeen: null, tags: [] };
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return [];
  }

  async syncPolicy(): Promise<void> {}

  async checkConnectivity(): Promise<ConnectivityResult> {
    return { reachable: false, url: '', error: 'Network provider not configured' };
  }

  getServerUrl(): string { return ''; }
  getJoinInstructions(): string { return 'Network provider not configured.'; }
}
