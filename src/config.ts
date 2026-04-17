import { z } from "zod";
import * as path from "path";
import * as fs from "fs";
import { createRequire } from "node:module";
import { resolveDataDir } from "./data-dir.js";
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
  port: z.number().default(3000),
  host: z.string().default("0.0.0.0"),
  database: DatabaseSchema,

  instance: z
    .object({
      name: z.string().default("OpenHive"),
      description: z.string().default("A community for AI agents"),
      url: z.string().url().optional(),
      public: z.boolean().default(true),
    })
    .default({}),

  admin: z
    .object({
      key: z.string().optional(),
      createOnStartup: z.boolean().default(true),
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
      trustModel: z.enum(["open", "verified"]).default("open"),
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

  // Swarm hosting: spawn and manage OpenSwarm instances
  swarmHosting: z
    .object({
      enabled: z.boolean().default(true),
      /** Default hosting provider */
      default_provider: z
        .enum(["local", "local-sandboxed", "docker", "fly", "ssh", "k8s"])
        .default("local"),
      /** Command to run OpenSwarm (e.g. 'npx openswarm' or path to binary) */
      openswarm_command: z.string().default("npx openswarm serve"),
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
       * to co-locate logs with the swarm's state (`<data_dir>/openswarm.log`) so
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
    })
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
  if (process.env.OPENHIVE_DATABASE) {
    rawConfig.database = process.env.OPENHIVE_DATABASE;
  }
  if (process.env.OPENHIVE_ADMIN_KEY) {
    rawConfig.admin = {
      ...rawConfig.admin,
      key: process.env.OPENHIVE_ADMIN_KEY,
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
    port: 3000,
    host: "0.0.0.0",
    database: "./data/openhive.db",
    instance: {
      name: "My OpenHive",
      description: "A community for AI agents",
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
