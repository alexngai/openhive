import { z } from "zod";
import * as path from "path";
import * as fs from "fs";
import { createRequire } from "node:module";
import { resolveDataDir, dataDirPaths } from "./data-dir.js";
import { writeConfigFile } from "./config-persistence.js";

// Storage configuration schema
const LocalStorageSchema = z.object({
  type: z.literal("local"),
  path: z.string().default("./uploads"),
  publicUrl: z.string().default("/uploads"),
});

const S3StorageSchema = z.object({
  type: z.literal("s3"),
  bucket: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  endpoint: z.string().optional(),
  publicUrl: z.string().optional(),
});

const StorageSchema = z
  .discriminatedUnion("type", [LocalStorageSchema, S3StorageSchema])
  .optional();

// Session storage configuration schema (for trajectory content caching)
const SessionStorageSchema = z
  .object({
    /** Storage backend: 'local' (disk), 's3', or 'none' (disable caching) */
    type: z.enum(["local", "s3", "none"]).default("local"),
    /** Custom path for local storage (default: <dataDir>/data/sessions) */
    path: z.string().optional(),
    /** S3 bucket for cloud storage */
    bucket: z.string().optional(),
    /** S3 region */
    region: z.string().optional(),
  })
  .default({});

// Database configuration schema
const SQLiteDatabaseSchema = z.object({
  type: z.literal("sqlite"),
  path: z.string().default("./data/openhive.db"),
});

const PostgresDatabaseSchema = z.object({
  type: z.literal("postgres"),
  connectionString: z.string().optional(),
  host: z.string().optional(),
  port: z.number().default(5432),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  ssl: z.boolean().optional(),
  pool: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .optional(),
});

const DatabaseSchema = z
  .union([
    z.string(), // Simple path for SQLite (backward compatible)
    SQLiteDatabaseSchema,
    PostgresDatabaseSchema,
  ])
  .default("./data/openhive.db");

// Configuration schema
export const ConfigSchema = z.object({
  port: z.number().default(7836),
  // Loopback by default — a fresh hub is NOT network-reachable until the
  // operator explicitly binds a public address (e.g. OPENHIVE_HOST=0.0.0.0).
  // Every container/PaaS deploy path already sets OPENHIVE_HOST=0.0.0.0.
  host: z.string().default("127.0.0.1"),

  /**
   * Deployment mode.
   *
   * - `'full'` (default) — serves the React SPA + admin UI alongside the API.
   *   The traditional deployment shape.
   * - `'server'` — headless hub. Skips the SPA; GET `/` returns a JSON pointer
   *   to the API + skill docs. skill.md omits human-facing (social) sections.
   *   Well-known and startup banner advertise the mode so agents can detect it.
   *
   * `mode: 'server'` composes fine with any auth mode, including `local`.
   */
  mode: z.enum(["server", "full"]).default("full"),

  database: DatabaseSchema,

  instance: z
    .object({
      name: z.string().default("OpenHive"),
      description: z.string().default("Agent swarm coordination hub"),
      url: z.string().url().optional(),
      public: z.boolean().default(true),
      /**
       * Extra Host header values the hostname guard accepts beyond `url`'s
       * host. Lets a hub whose `url` is its public domain still be reached over
       * LAN / Tailscale (by IP or MagicDNS name) in swarmhub auth mode, where
       * the guard is active. Ignored in local mode (guard is off there). e.g.
       * ['100.101.102.103:7836', 'mini.tailnet.ts.net:7836'].
       */
      allowedHosts: z.array(z.string()).optional(),
    })
    .default({}),

  admin: z
    .object({
      key: z.string().optional(),
      createOnStartup: z.boolean().default(true),
      /**
       * Trust the auto-authenticated local agent for admin-gated operations.
       *
       * When true AND `auth.mode === 'local'` AND the local agent is admin,
       * `createAdminAuth` accepts requests with NO credentials by treating
       * the local auto-auth agent as admin. This reverts to the pre-hardening
       * behavior where a single-operator hub on localhost could be managed
       * without ever typing the admin key.
       *
       * SECURITY: only enable on hubs that are bound to localhost or an
       * otherwise-trusted network. Any client that can reach the port
       * becomes effectively admin. Ignored in `token` / `swarmhub` auth
       * modes (those never auto-auth).
       */
      trustLocalMode: z.boolean().default(false),
    })
    .default({}),


  federation: z
    .object({
      enabled: z.boolean().default(false),
      peers: z.array(z.string().url()).default([]),
    })
    .default({}),

  // Session storage for trajectory content caching
  sessions: SessionStorageSchema,

  // Sessionlog configuration (for local Tier 3 transcript lookup)
  sessionlog: z
    .object({
      /** Path(s) to sessionlog session state directories.
       *  When a separate session repo is used, point this to the repo's
       *  sessionlog-sessions directory (e.g. '/path/to/session-repo/sessionlog-sessions').
       *  Supports multiple paths for multi-project setups.
       *  Falls back to .git/sessionlog-sessions/ in the working directory if not set. */
      sessionDirs: z.array(z.string()).default([]),
    })
    .default({}),

  cors: z
    .object({
      enabled: z.boolean().default(true),
      origin: z
        .union([z.string(), z.array(z.string()), z.boolean()])
        .default(true),
    })
    .default({}),

  storage: StorageSchema,

  auth: z
    .object({
      mode: z.enum(["local", "swarmhub"]).default("local"),
      /**
       * Who may call `POST /agents/register`:
       *   - 'admin'    (default): requires X-Admin-Key or an admin agent. On a
       *                loopback + local-auth hub the auto-trusted local admin
       *                still satisfies this, so `openhive init` keeps working.
       *   - 'open':    unauthenticated self-registration; new agents start
       *                UNVERIFIED (no operator has vouched for them).
       *   - 'disabled': the registration endpoint always refuses.
       * Defaults to 'admin' so a publicly-exposed hub is not open by default.
       */
      registration: z.enum(["open", "admin", "disabled"]).default("admin"),
    })
    .default({}),

  // Auto-pull configuration for remote task graphs
  autoPull: z
    .object({
      /** Poll interval in minutes for checking remote task graphs (default: 2) */
      intervalMinutes: z.number().min(0.5).default(2),
    })
    .default({}),

  // MAP Hub configuration (headscale-style coordination for MAP swarms)
  mapHub: z
    .object({
      enabled: z.boolean().default(true),
      // Minutes before an unresponsive swarm is marked offline
      staleThresholdMinutes: z.number().default(5),
      // Trust model for inbound WebSocket connections:
      //   'open'     — API key is sufficient, swarms can bring their own identity
      //   'verified' — MAP spec map/connect auth flow with agent-iam tokens
      // OPTIONAL (no hard default) so the server can distinguish an explicit
      // operator choice from "unset" and apply the migration guard at boot
      // (see the trust-model resolution in server.ts): a fresh hub defaults to
      // 'verified' (agents must present a signed token), while a hub that
      // already has agents is grandfathered to 'open' so existing tokenless
      // agents keep connecting. An explicit value here always wins.
      trustModel: z.enum(["open", "verified"]).optional(),
      // HMAC secret for agent-iam token signing/verification (verified mode).
      // Auto-generated and persisted to <dataDir>/data/iam-secret.key if not set.
      iamSecret: z.string().optional(),
      // Number of missed pongs before terminating a WebSocket connection (default 3).
      missedPongsBeforeTerminate: z.number().min(1).default(3),
      // Debounce interval (ms) for batching heartbeatSwarm() DB writes (default 10s).
      heartbeatDebounceMs: z.number().min(1000).default(10_000),
    })
    .default({}),

  // GitHub App configuration for automatic webhook handling
  githubApp: z
    .object({
      enabled: z.boolean().default(false),
      appId: z.string().optional(),
      webhookSecret: z.string().optional(),
      privateKey: z.string().optional(), // PEM format or path to file
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
    })
    .default({ enabled: false }),

  // Legacy headscale config (still supported, maps to network.headscaleSidecar)
  headscale: z
    .object({
      enabled: z.boolean().default(false),
      binaryPath: z.string().default("headscale"),
      dataDir: z.string().default("./data/headscale"),
      serverUrl: z.string().url().optional(),
      listenAddr: z.string().default("127.0.0.1:8085"),
      baseDomain: z.string().default("hive.internal"),
      embeddedDerp: z.boolean().default(false),
    })
    .default({ enabled: false }),

  // Hive sync configuration (cross-instance mesh sync)
  sync: z
    .object({
      enabled: z.boolean().default(false),
      instanceId: z.string().optional(),
      /** This instance's publicly reachable sync endpoint URL (e.g. https://myhive.example.com/sync/v1) */
      sync_endpoint: z.string().optional(),
      /** Optional pre-shared key required for handshake authentication (GAP-2) */
      handshake_secret: z.string().optional(),
      /**
       * Allow peer `sync_endpoint`s that point at private / loopback / link-local
       * hosts. Default false — handshake + gossip reject such endpoints to prevent
       * SSRF (cloud metadata at 169.254.169.254, internal services, RFC1918).
       * Enable only for a trusted private-network mesh (LAN/VPN you control).
       */
      allowPrivatePeers: z.boolean().default(false),
      /** Maximum pending events per sync group before oldest are dropped (GAP-12) */
      max_pending_events: z.number().default(1000),
      /** Maximum concurrent pull/push operations to prevent resource exhaustion on large meshes */
      max_concurrent_syncs: z.number().default(5),
      discovery: z.enum(["hub", "manual", "both"]).default("both"),
      peers: z
        .array(
          z.object({
            name: z.string(),
            sync_endpoint: z.string(),
            shared_hives: z.array(z.string()),
          }),
        )
        .default([]),
      heartbeat_interval: z.number().default(30000),
      peer_timeout: z.number().default(300000),
      gossip: z
        .object({
          enabled: z.boolean().default(true),
          default_ttl: z.number().default(2),
          hub_peer_ttl: z.number().default(1),
          exchange_interval: z.number().default(60000),
          max_gossip_peers: z.number().default(50),
          stale_timeout: z.number().default(300000),
          max_failures: z.number().default(3),
        })
        .default({}),
    })
    .default({ enabled: false }),

  // Swarm hosting: spawn and manage Swarm Runner instances
  swarmHosting: z
    .preprocess((raw) => {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const value = raw as Record<string, unknown>;
        if (value.swarm_runner_command === undefined && value.openswarm_command !== undefined) {
          return { ...value, swarm_runner_command: value.openswarm_command };
        }
      }
      return raw;
    }, z.object({
      enabled: z.boolean().default(true),
      /** Default hosting provider */
      default_provider: z
        .enum(["local", "local-sandboxed", "docker", "fly", "ssh", "k8s"])
        .default("local"),
      /** Command to run Swarm Runner (e.g. 'npx @swarmkit-ai/swarm-runner' or path to binary) */
      swarm_runner_command: z.string().default("npx @swarmkit-ai/swarm-runner serve"),
      /**
       * Named alternative swarm-runner gateways: `runner` name → spawn command.
       * Selected per-spawn via the `runner` field. The implicit `'swarmkit'`
       * runner always maps to `swarm_runner_command`; entries here add others.
       * Seeded with `openswarm` (our in-house harness — `openswarm host` speaks
       * the same OpenHive hosting contract). Override to point at a local build.
       */
      runners: z
        .record(z.string(), z.string())
        .default({ openswarm: "npx openswarm host" }),
      /** Base directory for swarm instance data */
      data_dir: z.string().default("./data/swarms"),
      /** Port range for locally spawned swarms [min, max] */
      port_range: z.tuple([z.number(), z.number()]).default([9000, 9100]),
      /** Maximum number of concurrent hosted swarms */
      max_swarms: z.number().default(10),
      /** Health check interval in ms */
      health_check_interval: z.number().default(30000),
      /** How many consecutive health failures before marking unhealthy */
      max_health_failures: z.number().default(3),
      /** Automatically restart crashed swarms */
      auto_restart: z.boolean().default(true),
      /** Maximum number of restart attempts before giving up (0 = unlimited) */
      max_restart_attempts: z.number().default(3),
      /**
       * Where to persist each hosted swarm's stdout/stderr.
       *
       * Default is `tmp`, which puts logs under `${os.tmpdir()}/openhive-swarm-logs/`
       * — ephemeral across reboots but survives restarts within a session, which is
       * the usual window for debugging crash-recover loops. Set `enabled: false` to
       * disable disk persistence entirely (in-memory ring buffer still works but
       * its contents are lost on every subprocess respawn). Use `dir: "data_dir"`
       * to co-locate logs with the swarm's state (`<data_dir>/swarm-runner.log`) so
       * they survive reboots, or give an absolute path for a custom location.
       */
      logs: z
        .object({
          enabled: z.boolean().default(true),
          /** `"tmp"` | `"data_dir"` | absolute path. */
          dir: z.string().default("tmp"),
        })
        .default({}),
      /** Credential configuration for swarm processes */
      credentials: z
        .object({
          /** Inherit operator's process.env into spawned swarms (default: true for local) */
          inherit_env: z.boolean().default(true),
          /** Named credential sets */
          sets: z
            .record(
              z.string(),
              z.object({
                source: z
                  .enum(["static", "env", "env-fallback"])
                  .default("static"),
                vars: z.record(z.string(), z.string()),
              }),
            )
            .default({}),
          /** Default credential set applied to all swarms */
          default_set: z.string().optional(),
          /** Per-hive credential overrides */
          hive_overrides: z
            .record(
              z.string(),
              z.object({
                credential_set: z.string().optional(),
                extra_vars: z.record(z.string(), z.string()).optional(),
              }),
            )
            .default({}),
        })
        .default({}),
      /** Sandbox configuration for process isolation (requires @anthropic-ai/sandbox-runtime) */
      sandbox: z
        .object({
          /** Enable OS-level sandboxing for locally spawned swarms */
          enabled: z.boolean().default(false),
          /** Default sandbox policy applied to all swarms */
          default_policy: z
            .object({
              /** Domains the swarm is allowed to reach (empty = no network) */
              allowed_domains: z.array(z.string()).default([]),
              /** Domains explicitly blocked */
              denied_domains: z.array(z.string()).default([]),
              /** Allow process to bind to local ports (default: true for swarm servers) */
              allow_local_binding: z.boolean().default(true),
              /** Filesystem paths the swarm can write to (data dir is always included) */
              allow_write: z.array(z.string()).default([]),
              /** Filesystem paths denied for writing */
              deny_write: z.array(z.string()).default([]),
              /** Filesystem paths denied for reading */
              deny_read: z
                .array(z.string())
                .default([
                  "~/.ssh",
                  "~/.gnupg",
                  "~/.aws",
                  "~/.config/gcloud",
                  "~/.azure",
                  "~/.kube",
                ]),
              /** Allow PTY allocation inside sandbox */
              allow_pty: z.boolean().default(false),
            })
            .default({}),
          /** Per-hive sandbox policy overrides */
          hive_overrides: z
            .record(
              z.string(),
              z.object({
                allowed_domains: z.array(z.string()).optional(),
                denied_domains: z.array(z.string()).optional(),
                allow_local_binding: z.boolean().optional(),
                allow_write: z.array(z.string()).optional(),
                deny_write: z.array(z.string()).optional(),
                deny_read: z.array(z.string()).optional(),
                allow_pty: z.boolean().optional(),
              }),
            )
            .default({}),
        })
        .default({ enabled: false }),
    }))
    .default({}),

  // SwarmCraft: MAP client for monitoring and steering coding agents
  swarmcraft: z
    .object({
      enabled: z.boolean().default(true),
      prefix: z.string().default("/api/swarmcraft"),
      wsPath: z.string().default("/ws/swarmcraft"),
      logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .default({}),

  // SwarmHub connector: optional bridge to SwarmHub for managed instances
  // Auto-detected from SWARMHUB_API_URL + SWARMHUB_HIVE_TOKEN env vars
  swarmhub: z
    .object({
      enabled: z.boolean().default(false),
      apiUrl: z.string().optional(),
      /** Health check interval in ms */
      healthCheckInterval: z.number().default(60000),
      /** OAuth configuration for SwarmHub auth mode */
      oauth: z
        .object({
          clientId: z.string().optional(),
          clientSecret: z.string().optional(),
          /** Override JWKS URL (defaults to {apiUrl}/.well-known/jwks.json) */
          jwksUrl: z.string().optional(),
        })
        .default({}),
    })
    .default({ enabled: false }),

  // Resource discovery: scan filesystem for minimem memory banks and skill-tree skills
  resourceDiscovery: z
    .object({
      /** Enable scanning for global (~/) resources */
      globalEnabled: z.boolean().default(false),
      /** Override path for global minimem memory (default: ~/.minimem) */
      globalMemoryPath: z.string().optional(),
      /** Override paths for global skill-tree skills (default: ~/.skill-tree, ~/.claude/skills) */
      globalSkillPaths: z.array(z.string()).optional(),
      /** Project root for project-scope discovery (default: cwd) */
      projectRoot: z.string().optional(),
      /** Override path for global OpenTasks store (default: ~/.opentasks) */
      globalOpenTasksPath: z.string().optional(),
      /** Enable OpenTasks discovery (default: true) */
      openTasksEnabled: z.boolean().default(true),
    })
    .default({}),

  // Resource sync: configurable sync strategies for syncable resources
  resourceSync: z
    .object({
      /** Default sync strategy for newly subscribed remote resources */
      defaultStrategy: z
        .enum(["metadata", "local", "ls-remote", "mirror", "bundle"])
        .default("metadata"),
      /** Sync strategy for filesystem-discovered resources */
      localDiscoveryStrategy: z
        .enum(["metadata", "local", "ls-remote", "mirror", "bundle"])
        .default("local"),
      /** Seconds before ls-remote re-checks freshness (default: 60) */
      lsRemoteTtl: z.number().default(60),
      /** Timeout in ms for mirror git fetch operations (default: 30000) */
      mirrorFetchTimeout: z.number().default(30000),
      /** Max bundle size in bytes (default: 10MB) */
      bundleMaxSize: z.number().default(10 * 1024 * 1024),
    })
    .default({}),

  // Resource storage: where cloned resource data lives
  resourceStorage: z
    .object({
      /** Base directory for cloned resource data (default: ./data/resources) */
      dataDir: z.string().default("./data/resources"),
      /** Auto-clone federated resources on subscribe (default: true) */
      autoClone: z.boolean().default(true),
    })
    .default({}),

  // Task graph: hub-owned OpenTasks bootstrap
  taskGraph: z
    .object({
      /**
       * Create a hub-default OpenTasks graph (`hub/default`) at startup so
       * /specs/new works on a fresh instance. Idempotent — safe to leave on.
       */
      bootstrapDefault: z.boolean().default(true),
    })
    .default({}),

  // (The idea-lab is not hub config — it's a workload loaded at runtime via
  //  POST /idea-lab/load. See src/idea-lab/CLAUDE.md.)

  // Channel Bridge: external platform integration (Slack, Discord, Telegram, etc.)
  bridge: z
    .object({
      enabled: z.boolean().default(false),
      maxBridges: z.number().default(10),
      credentialEncryptionKey: z.string().optional(),
      webhookBaseUrl: z.string().optional(),
    })
    .default({ enabled: false }),

  // Learning engine: cognitive-core Atlas integration
  learning: z
    .object({
      /** Master toggle — when false, Atlas is never initialized */
      enabled: z.boolean().default(false),

      /** Atlas engine configuration (passed through to cognitive-core) */
      atlas: z
        .object({
          creditStrategy: z.enum(["simple", "causal"]).default("simple"),
          minTrajectories: z.number().default(5),
          maxExperiences: z.number().default(4),
          maxContextTokens: z.number().default(4000),
          embedding: z
            .object({
              provider: z
                .enum(["none", "openai", "voyage", "local"])
                .default("none"),
              apiKey: z.string().optional(),
              model: z.string().optional(),
            })
            .default({}),
        })
        .default({}),

      /** Ingestion behavior */
      ingestion: z
        .object({
          mode: z.enum(["deferred"]).default("deferred"),
        })
        .default({}),

      /** Agentic compute — Phase 2+ (stubbed) */
      compute: z
        .object({
          enabled: z.boolean().default(false),
          preferredSwarmId: z.string().nullable().default(null),
          spawnIfNoneAvailable: z.boolean().default(true),
          spawnProvider: z.enum(["local", "sandboxed"]).default("local"),
        })
        .default({}),

      /** Cross-hive sync — Phase 3 (stubbed) */
      sync: z
        .object({
          publishPlaybooks: z.boolean().default(true),
          importPlaybooks: z.boolean().default(true),
          conflictStrategy: z
            .enum(["merge", "local-wins", "remote-wins"])
            .default("merge"),
        })
        .default({}),

      /** Distributed compute — Phase 4 */
      distributed: z
        .object({
          mode: z
            .enum(["local", "centralized", "domain-partitioned"])
            .default("local"),
          learningHiveUrl: z.string().nullable().default(null),
          /** API key for authenticating with the remote learning hive */
          learningHiveApiKey: z.string().optional(),
          domainRouting: z.record(z.string(), z.string()).default({}),
        })
        .default({}),

      /** Maintenance scheduling */
      maintenance: z
        .object({
          schedule: z.string().default("0 3 * * *"),
          autoRun: z.boolean().default(true),
        })
        .default({}),
    })
    .default({ enabled: false }),

  // Mesh networking for MAP swarm hosts (pluggable provider)
  network: z
    .object({
      /** Provider: 'tailscale-cloud' | 'headscale-sidecar' | 'headscale-external' | 'none' */
      provider: z
        .enum([
          "tailscale-cloud",
          "headscale-sidecar",
          "headscale-external",
          "none",
        ])
        .default("none"),

      /** Tailscale Cloud (SaaS) — simplest option, no infra to manage */
      tailscale: z
        .object({
          tailnet: z.string(),
          apiKey: z.string().optional(),
          oauthClientId: z.string().optional(),
          oauthClientSecret: z.string().optional(),
        })
        .optional(),

      /** Headscale sidecar — self-hosted, OpenHive manages the binary */
      headscaleSidecar: z
        .object({
          serverUrl: z.string().url(),
          baseDomain: z.string().default("hive.internal"),
          dataDir: z.string().default("./data/headscale"),
          binaryPath: z.string().default("headscale"),
          listenAddr: z.string().default("127.0.0.1:8085"),
          embeddedDerp: z.boolean().default(false),
          derpPublicIp: z.string().optional(),
          tls: z
            .object({
              mode: z
                .enum(["none", "letsencrypt", "manual", "reverse-proxy"])
                .default("none"),
              letsencryptHostname: z.string().optional(),
              certPath: z.string().optional(),
              keyPath: z.string().optional(),
            })
            .default({ mode: "none" }),
        })
        .optional(),

      /** External headscale — BYO headscale instance */
      headscaleExternal: z
        .object({
          apiUrl: z.string().url(),
          apiKey: z.string(),
          serverUrl: z.string().optional(),
          baseDomain: z.string().default("hive.internal"),
        })
        .optional(),
    })
    .default({ provider: "none" }),

  // Dispatch orchestrator (swarm-dispatch integration)
  dispatch: z
    .object({
      /** Max dispatches running concurrently across all swarms. */
      globalConcurrency: z.number().int().positive().default(5),
      /** How often the source table is polled for queued rows. */
      pollIntervalMs: z.number().int().positive().default(15_000),
      /** How often the reconcile cycle checks for external cancels / stalls. */
      reconcileIntervalMs: z.number().int().positive().default(5_000),
      /** Retry policy for failed dispatch attempts. */
      retry: z
        .object({
          maxRetries: z.number().int().min(0).default(3),
          baseDelayMs: z.number().int().positive().default(10_000),
          maxDelayMs: z.number().int().positive().default(300_000),
        })
        .default({}),
      /**
       * Eligibility scorer for ready dispatches.
       *
       * - `heuristic` — swarm-dispatch's `heuristicScorer` (role + spec-age weighting).
       * - `noop` — preserves source input order (previous default).
       */
      scorer: z.enum(["heuristic", "noop"]).default("heuristic"),
      /**
       * Cluster-wide default for the ACP-route lifecycle when a dispatch
       * doesn't carry an explicit `acp_lifecycle` per-call override.
       *
       * - `reuse` (default) — orchestrator attaches to an existing
       *   ACP-capable agent on the swarm via `findAcpAgentInfo`.
       *   Backwards-compatible with the pre-this-work behavior; loadout
       *   permissions are advisory because the existing session was
       *   created earlier.
       * - `fresh` — orchestrator spawns a fresh coordinator per dispatch
       *   via the `dispatch/spawn-agent` notification-pair RPC. Loadout
       *   permissions are enforced at spawn time. Requires the swarm to
       *   be running a macro-agent build with the dispatch handler.
       *
       * Per-dispatch override via the dispatch request body's
       * `acp_lifecycle` field takes precedence over this default.
       */
      acp_lifecycle_default: z.enum(["fresh", "reuse"]).default("reuse"),
      /**
       * Cluster-wide default for the mail-route lifecycle when a dispatch
       * doesn't carry an explicit `mail_lifecycle` per-call override.
       *
       * - `reuse` (default) — hub mail port lets prefer-route pick a
       *   non-busy long-lived worker via the roster. Falls back to the
       *   sidecar (and its mail-inbound-consumer fresh-spawn) when no
       *   roster match is available. Loadout permissions are advisory
       *   for the existing session, same as ACP+reuse.
       * - `fresh` — hub mail port forces routing to the connection's
       *   sidecar regardless of roster matches. The sidecar's
       *   mail-inbound-consumer spawns a fresh ephemeral worker per
       *   envelope. Loadout permissions are enforced at spawn time.
       *
       * Per-dispatch override via the dispatch request body's
       * `mail_lifecycle` field takes precedence over this default.
       */
      mail_lifecycle_default: z.enum(["fresh", "reuse"]).default("reuse"),
      /**
       * Optional local Codex executor branch backed by the swarm-codex plugin.
       * Disabled by default so existing ACP/mail dispatch behavior is unchanged.
       */
      codex_executor: z
        .object({
          enabled: z.boolean().default(false),
          /**
           * MAP swarm marker required for this branch. A target swarm must carry
           * metadata/capabilities identifying this kind; hosted kind="codex"
           * alone is intentionally not enough.
           */
          target_kind: z.string().default("swarm-codex"),
          /** MAP WebSocket URL used by the local executor sidecar. */
          map_server: z.string().optional(),
          /** Optional token query param for non-local MAP hubs. */
          map_token: z.string().optional(),
          command: z.string().default("codex"),
          driver: z.enum(["mcp", "exec"]).default("mcp"),
          /**
           * Codex sandbox for local dispatch workers. The default is intentionally
           * full access: git-cascade is commit-based, and Codex's workspace-write
           * sandbox blocks writes to `.git/index.lock`, so `git add` / `git commit`
           * cannot complete under the narrower sandbox.
           */
          sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("danger-full-access"),
          timeoutMs: z.number().int().positive().default(300_000),
          attributionRefreshMs: z.number().int().positive().default(2_000),
          concurrency_per_repo: z.number().int().positive().default(1),
          role_map: z.record(z.unknown()).default({}),
        })
        .default({}),
      /** Continuation turn budgets. */
      continuation: z
        .object({
          /** Max total continuation turns per dispatch session. */
          maxTurns: z.number().int().positive().default(20),
          /**
           * Max extra turns granted because of pending dispatch thread
           * messages. Prevents a chatty thread from keeping an agent alive
           * indefinitely. Independent of maxTurns.
           */
          maxThreadTurns: z.number().int().min(0).default(3),
        })
        .default({}),
    })
    .default({}),

  // Scheduler (swarm-dispatch scheduler integration)
  scheduler: z
    .object({
      /** Tick cadence for the scheduler loop. */
      tickIntervalMs: z.number().int().positive().default(60_000),
      /** Global cap on in-flight fire handlers across all schedules. */
      maxConcurrentFires: z.number().int().positive().default(10),
      /**
       * Per-agent cap on schedule count. Enforced by REST + MAP create
       * handlers, not the scheduler tick. Returns 429 / -32606 when hit.
       */
      maxSchedulesPerAgent: z.number().int().positive().default(100),
    })
    .default({}),

  // Cascade ↔ task binding
  cascade: z
    .object({
      /**
       * Hub-wide default policy for closing tasks on observed cascade merges.
       *
       * `manual` (default) — hub never auto-closes; agents and users drive task
       *   state themselves. Cascade metadata still flows to the UI via the
       *   changelog enrichment on task status broadcasts.
       *
       * `on_merge` — when a cascade stream carrying a task_ref merges, the
       *   hub transitions the linked task to `completed`. Overridable per-task
       *   via `task.metadata.close_policy` and per-swarm via the
       *   `cascade.autoCloseOnMerge` capability.
       */
      defaultClosePolicy: z.enum(["manual", "on_merge"]).default("manual"),
      /**
       * Hub-wide default review policy for cascade streams (the QC station,
       * docs/design/cascade-review-verdicts.md).
       *
       * `none` (default) — verdicts are recordable and surfaced, nothing is
       *   gated. Zero-cost, like the task binder's `manual`.
       *
       * `advisory` — verdicts surface on UI affordances (badges, PR-stack
       *   annotations) but nothing is withheld.
       *
       * `required` — hub-initiated landing actions (request.merge, PR-stack
       *   opening) require a current-head HUMAN `approved` verdict.
       *   Overridable per-task via `task.metadata.review_policy` and
       *   per-swarm via the `cascade.reviewPolicy` capability.
       *
       * Q1 ships the config surface only; no gate consults it until Q2.
       */
      defaultReviewPolicy: z.enum(["none", "advisory", "required"]).default("none"),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// Default configuration
export const defaultConfig: Config = ConfigSchema.parse({});

/** The file path that was loaded by the most recent loadConfig() call */
let _loadedConfigPath: string | undefined;

/** Returns the config file path that was loaded, or undefined if none found */
export function getLoadedConfigPath(): string | undefined {
  return _loadedConfigPath;
}

/** Set the loaded config path (used when auto-creating a config file) */
export function setLoadedConfigPath(filePath: string): void {
  _loadedConfigPath = filePath;
}

/** Returns true if the loaded config is a JSON file (editable by UI) */
export function isConfigEditable(): boolean {
  return _loadedConfigPath?.endsWith(".json") ?? false;
}

// Load configuration from file or environment
export function loadConfig(configPath?: string): Config {
  let fileConfig: Partial<Config> = {};

  // Resolve data directory for config file lookup
  const dataDir = resolveDataDir();
  const dataDirConfigCandidates = [
    path.join(dataDir, "config.json"),
    path.join(dataDir, "config.js"),
  ];

  // Try to load from config file.
  // JSON is preferred (editable by UI). JS is supported for backwards compat (read-only).
  // Search order: explicit path, CWD (JSON first), data dir (JSON first).
  const configFiles = [
    configPath,
    "./openhive.config.json",
    "./openhive.config.js",
    path.join(process.cwd(), "openhive.config.json"),
    path.join(process.cwd(), "openhive.config.js"),
    ...dataDirConfigCandidates,
  ].filter(Boolean) as string[];

  _loadedConfigPath = undefined;

  for (const file of configFiles) {
    if (fs.existsSync(file)) {
      try {
        if (file.endsWith(".json")) {
          fileConfig = JSON.parse(fs.readFileSync(file, "utf-8"));
        } else if (file.endsWith(".js")) {
          const esmRequire = createRequire(import.meta.url);
          const loaded = esmRequire(path.resolve(file));
          fileConfig = loaded.default || loaded;
        }
        _loadedConfigPath = path.resolve(file);
        break;
      } catch {
        // Continue to next file
      }
    }
  }

  // Auto-migrate JS config → JSON on first load
  // Writes the resolved JS config as JSON next to the original, renames .js → .js.bak
  if (_loadedConfigPath?.endsWith(".js")) {
    const jsonPath = _loadedConfigPath.replace(/\.js$/, ".json");
    try {
      writeConfigFile(jsonPath, fileConfig as Record<string, unknown>);
      fs.renameSync(_loadedConfigPath, _loadedConfigPath + ".bak");
      _loadedConfigPath = jsonPath;
    } catch {
      // Migration failed — continue with JS config (read-only in UI)
    }
  }

  // Build raw config object for zod to parse
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawConfig: any = { ...fileConfig };

  // Override with environment variables
  if (process.env.OPENHIVE_PORT) {
    rawConfig.port = parseInt(process.env.OPENHIVE_PORT, 10);
  }
  if (process.env.OPENHIVE_HOST) {
    rawConfig.host = process.env.OPENHIVE_HOST;
  }
  if (process.env.OPENHIVE_MODE) {
    rawConfig.mode = process.env.OPENHIVE_MODE;
  }
  if (process.env.OPENHIVE_DATABASE) {
    rawConfig.database = process.env.OPENHIVE_DATABASE;
  }

  // If nothing else specified a database path, anchor the default to the
  // resolved data dir instead of letting Zod's `.default("./data/openhive.db")`
  // stand — that default is cwd-relative, and `initDatabase()` does
  // `mkdir -p $(dirname path)` relative to cwd. The CLI sidesteps this by
  // setting OPENHIVE_DATABASE absolutely in startServer(), but library
  // embedders (Electron app, anyone using `createHive()` directly) silently
  // pick up cwd — which is `/` under a Finder launch → ENOENT. Anchoring
  // the default here closes that gap once and for all.
  //
  // Note: this also fixes the iam-secret.key location. `server.ts` derives
  // its data dir via `dirname(dirname(db.path))` to know where to persist
  // the secret; with a relative db path that yields `.`, so secrets land
  // cwd-relative too. An absolute db path keeps them in <dataDir>/data/.
  //
  // Explicit values from the config file or OPENHIVE_DATABASE take
  // precedence over this default — we only fill in when truly unset.
  if (rawConfig.database === undefined) {
    rawConfig.database = dataDirPaths(dataDir).database;
  }
  if (process.env.OPENHIVE_ADMIN_KEY) {
    rawConfig.admin = {
      ...rawConfig.admin,
      key: process.env.OPENHIVE_ADMIN_KEY,
    };
  }
  if (process.env.OPENHIVE_ADMIN_TRUST_LOCAL_MODE !== undefined) {
    // Accept '1', 'true', 'yes' (case-insensitive). Anything else disables.
    const raw = process.env.OPENHIVE_ADMIN_TRUST_LOCAL_MODE.toLowerCase();
    rawConfig.admin = {
      ...rawConfig.admin,
      trustLocalMode: raw === '1' || raw === 'true' || raw === 'yes',
    };
  }
  if (process.env.OPENHIVE_INSTANCE_NAME) {
    rawConfig.instance = {
      ...rawConfig.instance,
      name: process.env.OPENHIVE_INSTANCE_NAME,
    };
  }
  if (process.env.OPENHIVE_INSTANCE_URL) {
    rawConfig.instance = {
      ...rawConfig.instance,
      url: process.env.OPENHIVE_INSTANCE_URL,
    };
  }
  if (process.env.OPENHIVE_INSTANCE_ALLOWED_HOSTS) {
    rawConfig.instance = {
      ...rawConfig.instance,
      allowedHosts: process.env.OPENHIVE_INSTANCE_ALLOWED_HOSTS.split(",")
        .map((h) => h.trim())
        .filter(Boolean),
    };
  }
  if (process.env.OPENHIVE_AUTH_MODE) {
    rawConfig.auth = {
      ...rawConfig.auth,
      mode: process.env.OPENHIVE_AUTH_MODE,
    };
  }
  if (process.env.OPENHIVE_IAM_SECRET) {
    rawConfig.mapHub = {
      ...rawConfig.mapHub,
      iamSecret: process.env.OPENHIVE_IAM_SECRET,
    };
  }

  // Learning engine toggle from environment
  if (process.env.OPENHIVE_LEARNING_ENABLED === "true") {
    rawConfig.learning = { ...rawConfig.learning, enabled: true };
  }

  // SwarmHub connector auto-detection from environment
  if (process.env.SWARMHUB_API_URL && process.env.SWARMHUB_HIVE_TOKEN) {
    rawConfig.swarmhub = {
      ...rawConfig.swarmhub,
      enabled: true,
      apiUrl: process.env.SWARMHUB_API_URL,
    };

    // Auto-detect auth mode: managed hives use SwarmHub as identity provider.
    // OAuth credentials are fetched at boot via the bridge connector, so the
    // presence of the bridge env vars is sufficient to enable swarmhub auth.
    if (!process.env.OPENHIVE_AUTH_MODE) {
      rawConfig.auth = { ...rawConfig.auth, mode: "swarmhub" };
    }
  }

  // SwarmHub OAuth configuration from environment (legacy — new hives fetch
  // credentials from the bridge config endpoint instead of env vars)
  if (process.env.SWARMHUB_OAUTH_CLIENT_ID) {
    rawConfig.swarmhub = {
      ...rawConfig.swarmhub,
      oauth: {
        ...rawConfig.swarmhub?.oauth,
        clientId: process.env.SWARMHUB_OAUTH_CLIENT_ID,
        clientSecret: process.env.SWARMHUB_OAUTH_CLIENT_SECRET,
      },
    };
  }

  // GitHub App configuration from environment
  if (process.env.GITHUB_APP_ID || process.env.GITHUB_APP_WEBHOOK_SECRET) {
    rawConfig.githubApp = {
      ...rawConfig.githubApp,
      enabled: true,
      appId: process.env.GITHUB_APP_ID,
      webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      clientId: process.env.GITHUB_APP_CLIENT_ID,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    };
  }

  // Let zod apply defaults and validate
  return ConfigSchema.parse(rawConfig);
}

// Generate a sample config file (JSON format)
export function generateSampleConfig(): string {
  const sample = {
    port: 7836,
    // Loopback by default; set to "0.0.0.0" (or use OPENHIVE_HOST) to expose on the network.
    host: "127.0.0.1",
    database: "./data/openhive.db",
    instance: {
      name: "My OpenHive",
      description: "Agent swarm coordination hub",
      public: true,
    },
    admin: {
      createOnStartup: true,
    },
    federation: {
      enabled: false,
      peers: [],
    },
    cors: {
      enabled: true,
      origin: true,
    },
  };
  return JSON.stringify(sample, null, 2) + "\n";
}
