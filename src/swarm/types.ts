/**
 * Swarm Hosting Types
 *
 * Types for spawning and managing OpenSwarm instances from OpenHive.
 * Supports multiple hosting providers (local sidecar, docker, remote compute).
 */

// ============================================================================
// Hosting Provider Types
// ============================================================================

export type HostingProviderType = 'local' | 'local-sandboxed' | 'docker' | 'fly' | 'ssh' | 'k8s';

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
  /** Injected resources available to the swarm */
  resources?: Array<{
    id: string;
    resource_type: string;
    name: string;
    git_remote_url: string;
    metadata: Record<string, unknown> | null;
  }>;
  /** When this token was issued */
  issued_at: string;
  /** When this token expires (short TTL, just for bootstrapping) */
  expires_at: string;
}

// ============================================================================
// Workspace Configuration
// ============================================================================

/** A git repository to clone into the swarm's working directory */
export interface WorkspaceRepo {
  /** Git remote URL (HTTPS or SSH) */
  url: string;
  /** Branch to checkout (defaults to the remote's default branch) */
  branch?: string;
  /** Relative path within the data directory to clone into (defaults to ".") */
  path?: string;
  /** Shallow clone depth (omit for full clone) */
  depth?: number;
}

/** Workspace setup configuration for a swarm instance */
export interface WorkspaceConfig {
  /** Git repositories to clone into the swarm's working directory */
  repos: WorkspaceRepo[];
}

// ============================================================================
// Spawn Configuration
// ============================================================================

/** What the caller provides when requesting a swarm spawn */
export interface SpawnSwarmInput {
  /** Human-readable name for the swarm (auto-generated if omitted) */
  name?: string;
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
  /** Per-spawn credential overrides (highest priority layer) */
  credential_overrides?: Record<string, string>;
  /** Workspace setup (e.g. repos to clone before the swarm starts) */
  workspace?: WorkspaceConfig;
  /** Resource IDs to inject into the swarm's bootstrap config */
  inject_resources?: string[];
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
  /** Resolved credentials to inject into the swarm process (NOT persisted to DB) */
  resolved_credentials?: ResolvedCredentials;
  /** Whether to inherit operator's process.env as a base */
  inherit_env?: boolean;
  /** Metadata for re-resolving credentials on auto-restart (persisted to DB) */
  credential_resolution?: CredentialResolutionMeta;
  /** Workspace setup (repos to clone before process starts) */
  workspace?: WorkspaceConfig;
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
  /** Automatically restart crashed swarms */
  auto_restart: boolean;
  /** Maximum number of restart attempts before giving up (0 = unlimited) */
  max_restart_attempts: number;
  /** Credential configuration for swarm processes */
  credentials?: SwarmCredentialConfig;
  /** Sandbox configuration for process isolation */
  sandbox?: SwarmSandboxConfig;
}

// ============================================================================
// Credential Configuration
// ============================================================================

/** Resolved credentials ready for injection into a swarm process */
export type ResolvedCredentials = Record<string, string>;

/** Metadata stored in DB for re-resolving credentials on auto-restart */
export interface CredentialResolutionMeta {
  credential_set?: string;
  hive?: string;
  inherit_env: boolean;
}

/**
 * A named set of credentials (env var name → value).
 * Injected into swarm processes via the hosting provider's native mechanism.
 */
export interface CredentialSetConfig {
  /**
   * Where credential values come from:
   * - 'static': literal values in `vars`
   * - 'env': `vars` values are env var names to read from process.env at spawn time
   * - 'env-fallback': use static values from `vars`, fall back to same-named env var if empty
   */
  source?: 'static' | 'env' | 'env-fallback';
  /** Key = env var name in the swarm process, Value = literal or env var name to read */
  vars: Record<string, string>;
}

export interface HiveCredentialOverride {
  /** Credential set to use for swarms in this hive (replaces default_set) */
  credential_set?: string;
  /** Additional vars to overlay on top of the resolved credential set */
  extra_vars?: Record<string, string>;
}

export interface SwarmCredentialConfig {
  /** Inherit operator's process.env into spawned swarms (default: true) */
  inherit_env?: boolean;
  /** Named credential sets */
  sets?: Record<string, CredentialSetConfig>;
  /** Default credential set applied to all swarms unless overridden */
  default_set?: string;
  /** Per-hive credential overrides */
  hive_overrides?: Record<string, HiveCredentialOverride>;
}

// ============================================================================
// Sandbox Configuration
// ============================================================================

/**
 * Sandbox policy applied to a hosted swarm process.
 * Powered by @anthropic-ai/sandbox-runtime (bubblewrap on Linux, seatbelt on macOS).
 */
export interface SwarmSandboxPolicy {
  /** Domains the swarm is allowed to reach (empty = no network access) */
  allowed_domains?: string[];
  /** Domains explicitly blocked (takes precedence over allowed_domains) */
  denied_domains?: string[];
  /** Allow the swarm process to bind to local ports (required for serving) */
  allow_local_binding?: boolean;
  /** Filesystem paths the swarm is allowed to write (empty = no writes) */
  allow_write?: string[];
  /** Filesystem paths denied for writing (overrides allow_write) */
  deny_write?: string[];
  /** Filesystem paths denied for reading */
  deny_read?: string[];
  /** Allow PTY allocation inside sandbox (for TUI adapters) */
  allow_pty?: boolean;
}

export interface SwarmSandboxConfig {
  /** Enable sandboxing for locally spawned swarms */
  enabled: boolean;
  /** Default sandbox policy applied to all swarms unless overridden */
  default_policy?: SwarmSandboxPolicy;
  /** Per-hive sandbox policy overrides */
  hive_overrides?: Record<string, SwarmSandboxPolicy>;
}
