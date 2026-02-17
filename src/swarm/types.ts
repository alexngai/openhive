/**
 * Swarm Hosting Types
 *
 * Types for spawning and managing OpenSwarm instances from OpenHive.
 * Supports multiple hosting providers (local sidecar, docker, remote compute).
 */

// ============================================================================
// Hosting Provider Types
// ============================================================================

export type HostingProviderType = 'local' | 'docker' | 'fly' | 'ssh' | 'k8s';

export type HostedSwarmState =
  | 'provisioning'  // Provider is setting up the instance
  | 'starting'      // Process/container is starting, waiting for health
  | 'running'       // Healthy and registered in MAP hub
  | 'unhealthy'     // Failed health check, may auto-restart
  | 'stopping'      // Graceful shutdown in progress
  | 'stopped'       // Fully stopped
  | 'failed';       // Unrecoverable error

// ============================================================================
// Bootstrap Token
// ============================================================================

/**
 * Bootstrap token passed to a spawned OpenSwarm instance.
 * Contains everything the swarm needs to start and register itself
 * with the OpenHive MAP hub.
 */
export interface BootstrapToken {
  version: 1;
  /** The OpenHive instance URL the swarm should register with */
  openhive_url: string;
  /** Single-use pre-auth key for MAP hub registration + auto hive join */
  preauth_key: string;
  /** Name for the swarm */
  swarm_name: string;
  /** OpenSwarm adapter to use (e.g. 'macro-agent') */
  adapter: string;
  /** Adapter-specific configuration */
  adapter_config?: Record<string, unknown>;
  /** Extra metadata to attach to the swarm registration */
  metadata?: Record<string, unknown>;
  /** When this token was issued */
  issued_at: string;
  /** When this token expires (short TTL, just for bootstrapping) */
  expires_at: string;
}

// ============================================================================
// Spawn Configuration
// ============================================================================

/** What the caller provides when requesting a swarm spawn */
export interface SpawnSwarmInput {
  /** Human-readable name for the swarm */
  name: string;
  /** Optional description */
  description?: string;
  /** OpenSwarm adapter to use */
  adapter?: string;
  /** Adapter-specific configuration */
  adapter_config?: Record<string, unknown>;
  /** Hive to auto-join after registration */
  hive?: string;
  /** Hosting provider to use (defaults to config default) */
  provider?: HostingProviderType;
  /** Extra metadata */
  metadata?: Record<string, unknown>;
}

/** Internal config passed to the hosting provider */
export interface SwarmProvisionConfig {
  name: string;
  adapter: string;
  adapter_config?: Record<string, unknown>;
  /** Base64-encoded bootstrap token */
  bootstrap_token: string;
  /** Port assigned by the manager (local/docker only) */
  assigned_port: number;
  /** Data directory for this swarm instance */
  data_dir: string;
}

// ============================================================================
// Provider Interface
// ============================================================================

export interface ProvisionResult {
  /** Provider-specific instance identifier */
  instance_id: string;
  /** Whether the swarm is already running or still deploying */
  state: 'running' | 'deploying';
  /** Process ID (local provider) */
  pid?: number;
  /** Container ID (docker provider) */
  container_id?: string;
  /** The MAP endpoint where this swarm is reachable */
  endpoint?: string;
  /** Provider-specific deployment ID (remote providers) */
  deployment_id?: string;
}

export interface InstanceStatus {
  state: HostedSwarmState;
  pid?: number;
  container_id?: string;
  uptime_ms?: number;
  last_health_check?: string;
  error?: string;
}

export interface LogOptions {
  /** Number of lines to return (from end) */
  lines?: number;
  /** Return logs since this ISO timestamp */
  since?: string;
}

/**
 * Hosting provider interface.
 * Implementations handle the actual spawning/stopping of OpenSwarm processes.
 */
export interface HostingProvider {
  readonly type: HostingProviderType;

  /** Provision and start a new OpenSwarm instance */
  provision(config: SwarmProvisionConfig): Promise<ProvisionResult>;

  /** Stop and tear down an instance */
  deprovision(instanceId: string): Promise<void>;

  /** Check the current status of an instance */
  getStatus(instanceId: string): Promise<InstanceStatus>;

  /** Retrieve logs from an instance */
  getLogs(instanceId: string, opts?: LogOptions): Promise<string>;

  /** Restart an instance (not all providers support this) */
  restart?(instanceId: string): Promise<ProvisionResult>;
}

// ============================================================================
// Hosted Swarm Record (DB)
// ============================================================================

export interface HostedSwarm {
  id: string;
  /** References map_swarms.id — NULL until the swarm registers with the hub */
  swarm_id: string | null;
  /** Which provider is managing this instance */
  provider: HostingProviderType;
  /** Current lifecycle state */
  state: HostedSwarmState;
  /** Process ID (local provider) */
  pid: number | null;
  /** Container ID (docker provider) */
  container_id: string | null;
  /** Provider-specific deployment ID (remote providers) */
  deployment_id: string | null;
  /** SHA256 hash of the bootstrap token (to correlate callback registrations) */
  bootstrap_token_hash: string | null;
  /** Port assigned to this instance */
  assigned_port: number | null;
  /** The MAP endpoint once known */
  endpoint: string | null;
  /** The provision config used to spawn this swarm */
  config: SwarmProvisionConfig | null;
  /** Last error message if unhealthy/failed */
  error: string | null;
  /** Agent that requested the spawn */
  spawned_by: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Swarm Hosting Config (for openhive.config.js)
// ============================================================================

export interface SwarmHostingConfig {
  enabled: boolean;
  /** Default hosting provider */
  default_provider: HostingProviderType;
  /** Command to run OpenSwarm (e.g. 'npx openswarm' or path to binary) */
  openswarm_command: string;
  /** Base directory for swarm instance data */
  data_dir: string;
  /** Port range for locally spawned swarms [min, max] */
  port_range: [number, number];
  /** Maximum number of concurrent hosted swarms */
  max_swarms: number;
  /** Health check interval in ms */
  health_check_interval: number;
  /** How many consecutive health failures before marking unhealthy */
  max_health_failures: number;
}
