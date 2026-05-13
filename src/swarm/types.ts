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
  /**
   * Agent-iam delegated token for MAP hub authentication. The spawned
   * swarm subprocess presents this as its Bearer on `map/connect` and
   * any REST call it makes to the hub. Issued via
   * `delegateForSpawn` at hosted-swarm spawn time. Replaces the retired
   * preauth-key mechanism.
   */
  onboard_token: string;
  /** Name for the swarm */
  swarm_name: string;
  /** Pre-registered swarm ID for stable identity across reconnections */
  swarm_id?: string;
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
  /**
   * OpenTeams binding (Layer 4). Optional — present when the spawn was
   * initiated with a `loadout_bundle_id`. The loadout's MCP scope and
   * prompt addendum are materialized at the hub and forwarded here so
   * the openswarm sidecar can apply them to the spawned agent's first
   * session without an extra round-trip to fetch the bundle.
   *
   * `loadout_bundle_id` / `team_bundle_id` / `role` are recorded for the
   * sidecar to surface in the agent's registration metadata, matching
   * openteams's `Participant.metadata.{loadout,role,team}` contract.
   */
  openteams?: {
    loadout_bundle_id?: string;
    team_bundle_id?: string;
    role?: string;
    /** Materialized MCP server entries (ACP-shaped). */
    mcp_servers?: Array<{
      name: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      type?: 'stdio' | 'sse' | 'http';
      url?: string;
      headers?: Record<string, string>;
    }>;
    /** Prompt prefix applied ahead of the agent's first turn. */
    prompt_addendum?: string;
    /**
     * Inlined team content for wire delivery. When set, the spawned
     * swarm's adapter (macro-agent's bootV2) can hydrate a TeamRuntime
     * from this content via `TemplateLoader.fromObject` — no filesystem
     * write, no MAP fetch needed.
     *
     * Shape matches openteams's `TemplateLoader.fromObject` input. Sized
     * for inline transport: even the heaviest reference team (gsd, 12
     * roles) is ~30 KB after base64 — ~3% of macOS ARG_MAX (1 MB).
     * Larger teams should switch to a MAP-fetch path.
     */
    team_content?: {
      manifest: Record<string, unknown>;
      roles?: Record<string, Record<string, unknown>>;
      loadouts?: Record<string, Record<string, unknown>>;
      prompts?: Record<string, Record<string, unknown>>;
    };
  };
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

/**
 * Per-swarm workspace policy. Operators set this at spawn time; runtime
 * `x-workspace/repo.declare` (and trajectory-bootstrap and `repo.retract`)
 * calls are gated against it. Persisted on `map_swarms.workspace_policy`
 * and read by `findSwarmWorkspacePolicy`.
 *
 * - `open` (default): any declare succeeds.
 * - `allow_listed`: declares must match a canonical_url in `allowed_repos`.
 * - `pinned`: declares must match `pinned_repo`. NOTE: the hub-side
 *   "auto-attach a binding to `pinned_repo` at swarm register" half is
 *   not yet implemented (tracked under "Pending follow-ups" in
 *   src/map/CLAUDE.md). Today this mode behaves like a single-entry
 *   allow_list — it validates declares but doesn't pre-create a binding.
 *
 * Re-exported from `src/types.ts` (the canonical home) so existing
 * imports from `swarm/types.ts` keep working without dragging the type
 * back into the upward-import-only layer.
 */
export type { WorkspacePolicy } from '../types.js';
import type { WorkspacePolicy } from '../types.js';

// ============================================================================
// Spawn Configuration
// ============================================================================

/**
 * Boot-time agent provisioning. Forwarded to the swarm runtime via env
 * vars so the runtime can spawn a default agent without an explicit
 * `_macro/spawnAgent` call from a client.
 */
export interface SwarmBootstrap {
  /**
   * Auto-spawn a coordinator agent on swarm boot. When true, the runtime
   * spawns a default head-manager coordinator at `cwd` (or its own cwd
   * if unset) so the swarm is chat-ready without an explicit spawn.
   */
  coordinator?: boolean;
  /**
   * Project directory for the auto-spawned coordinator. This becomes the
   * agent's `cwd` — i.e. the directory it operates against. Typically set
   * to the user's project repo path on the host.
   */
  cwd?: string;
}

/** What the caller provides when requesting a swarm spawn */
export interface SpawnSwarmInput {
  /**
   * What kind of agent process to spawn. Defaults to 'openswarm' (existing
   * behavior). When set to 'claude-code', the manager routes to a separate
   * spawn pipeline that launches the Claude Code TUI alongside cc-swarm's
   * plugin-managed sidecar. See docs/HOSTED_SWARM_KINDS_DESIGN.md.
   */
  kind?: HostedSwarmKind;
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
  /**
   * Pre-attached repo resource (kinds/repo). When set, the manager looks up
   * the repo and injects `WORKSPACE_REPO_URL` / `WORKSPACE_LOCAL_PATH` /
   * `WORKSPACE_BRANCH` env vars so the spawned swarm's sidecar can declare
   * the repo on connect (per `agent-workspace/docs/design/agent-integration.md`).
   *
   * Independent of `workspace.repos` (which clones; this announces).
   */
  repo_id?: string;
  /**
   * Per-swarm workspace policy gating which repos this swarm's agents may
   * declare. Persisted on `map_swarms.workspace_policy` so runtime declares
   * can be gated. See CLAUDE.md "Repos and Workspaces" enforcement layers.
   */
  workspace_policy?: WorkspacePolicy;
  /**
   * Initial prompt to seed the spawned agent with.
   *
   * For `kind: 'claude-code'`, passed to `claude` as a positional arg so the
   * TUI opens with the prompt prefilled (claude treats it as the first user
   * turn). For `kind: 'openswarm'`, currently a no-op — the openswarm adapter
   * has its own prompt-injection path via the bootstrap-coordinator field.
   */
  initial_prompt?: string;
  /**
   * For `kind: 'codex'` only: which surface to spawn.
   *
   *   - `'rpc'` (default): spawn `codex app-server` and let openhive's chat
   *     UI drive it via JSON-RPC. The canonical interaction model — full
   *     streaming, mid-turn injection, dispatch hand-off, etc.
   *   - `'tui'`: spawn `codex` interactive TUI in a node-pty PTY. Operator
   *     drives it through the embedded terminal, openhive does NOT see the
   *     conversation programmatically (codex has no plugin sidecar yet).
   *
   * `'rpc'` and `'tui'` operate on independent threads — codex's app-server
   * and `codex resume` don't share live state. See
   * docs/HOSTED_SWARM_KINDS_DESIGN.md "codex — programmatic mode".
   *
   * Ignored for non-codex kinds.
   */
  mode?: 'rpc' | 'tui';
  /** Resource IDs to inject into the swarm's bootstrap config */
  inject_resources?: string[];
  /** Boot-time agent provisioning (e.g. auto-spawn coordinator) */
  bootstrap?: SwarmBootstrap;
  /**
   * Optional openteams binding. When `loadout_bundle_id` is supplied the
   * manager fetches the materialized loadout (MCP scope + prompt
   * addendum) from the openteams bundle store and forwards it through
   * the BootstrapToken so the sidecar can apply it on agent boot.
   * `team_bundle_id` and `role` are advisory — recorded so the spawned
   * agent's registration metadata can carry the team context.
   */
  loadout_bundle_id?: string;
  team_bundle_id?: string;
  role?: string;
  /**
   * Optional git-sync config for the swarm's OWN opentasks workspace.
   * When set, the manager writes `.opentasks/config.json` into the
   * spawn's `dataDir` BEFORE the subprocess starts, so the embedded
   * daemon reads it on first boot — no PATCH + hot-reload needed.
   *
   * Shape mirrors `metadata.git_sync` on a resource (see
   * `src/swarmkit/git-sync-config.ts` for the schema).
   */
  git_sync?: {
    enabled: boolean;
    remote?: string;
    autoCommit?: boolean;
    autoPush?: boolean;
    pullOnStartup?: boolean;
    pushDebounceMs?: number;
    pullOnSignal?: boolean;
  };
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
  /** Pre-attached repo resource (echoed from SpawnSwarmInput; passed for audit). */
  repo_id?: string;
  /** Per-swarm workspace policy (echoed from SpawnSwarmInput; passed for audit). */
  workspace_policy?: WorkspacePolicy;
  /** Boot-time agent provisioning (env-var bridged into the runtime) */
  bootstrap?: SwarmBootstrap;
  /**
   * When set, the provider spawns this command instead of its kind-default
   * (e.g. the local provider's `openswarm_command`). Used by non-openswarm
   * kinds (`claude-code`, future codex/gemini) to point the provider at the
   * right binary without making the provider itself kind-aware.
   *
   * The override is taken verbatim — provider does NOT append default args.
   */
  spawn_command_override?: string;
  /**
   * For `kind: 'codex'` only — which surface this row was spawned with.
   * `'rpc'` rows route through CodexAppServerManager; `'tui'` (and absent)
   * rows route through PtyManager. Persisted so restart/revive can pick
   * the right pipeline. Ignored for non-codex kinds.
   */
  mode?: 'rpc' | 'tui';
  /**
   * Args to pair with `spawn_command_override`. When the override is set
   * these REPLACE the provider's default args (not append). When the
   * override is unset, this field is ignored.
   */
  spawn_args_override?: string[];
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

/**
 * What flavour of agent process this hosted swarm is. Drives the spawn-plan
 * resolver — see docs/HOSTED_SWARM_KINDS_DESIGN.md. New rows must specify a
 * kind; legacy rows default to 'openswarm' on read.
 */
export type HostedSwarmKind =
  | 'openswarm'    // OpenSwarm hosting gateway (current default)
  | 'claude-code'  // claude TUI + cc-swarm plugin sidecar
  | 'codex';       // codex TUI (no plugin/sidecar in v1; future codex-swarm plugin will add MAP integration)

export interface HostedSwarm {
  id: string;
  /** What kind of agent process this is. */
  kind: HostedSwarmKind;
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
  /** Per-swarm stdout/stderr log persistence */
  logs?: SwarmLogsConfig;
}

/** Stdout/stderr persistence for each hosted swarm subprocess. */
export interface SwarmLogsConfig {
  /** Write a per-swarm log file. Disable to keep logs in-memory only. */
  enabled: boolean;
  /**
   * Where to place the file. `"tmp"` (default) uses `os.tmpdir()`,
   * `"data_dir"` co-locates with the swarm's data directory, anything else
   * is treated as an absolute directory path.
   */
  dir: string;
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
