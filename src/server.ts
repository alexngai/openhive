import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const requireFrom = createRequire(import.meta.url);
import { Config, loadConfig } from "./config.js";
import { initDatabase, closeDatabase, getDatabase } from "./db/index.js";
import { registerRoutes } from "./api/index.js";
import { setupWebSocket, stopHeartbeat, broadcastToChannel } from "./realtime/index.js";
import { generateSkillMd } from "./skill.js";
import { generateSitemap, generateRobotsTxt } from "./services/sitemap.js";
import { initializeStorage, type StorageConfig } from "./storage/index.js";
import { initializeLocalSessionStorage, isSessionStorageInitialized } from "./sessions/storage/index.js";
import { resolveDataDir } from "./data-dir.js";
import { initJwks } from "./auth/jwks.js";
import {
  createNetworkProvider,
  type NetworkProvider,
} from "./network/index.js";
import { syncProtocolRoutes } from "./api/routes/sync-protocol.js";
import { initSyncService } from "./sync/service.js";
import type { SyncService } from "./sync/service.js";
import { seedOpenteamsBundleStore } from "./openteams/seed.js";
import { SwarmManager } from "./swarm/manager.js";
import type { SwarmHostingConfig } from "./swarm/types.js";
import { getOrCreateLocalAgent } from "./db/dal/agents.js";
import { setLocalAgent } from "./api/middleware/auth.js";
import {
  initMapSyncListener,
  stopMapSyncListener,
} from "./map/sync-listener.js";
import {
  startLocalResourceWatchers,
  stopLocalResourceWatchers,
} from "./sync/local-resource-watcher.js";
import { markStaleSwarms, getWellKnownMapInfo } from "./map/service.js";
import { setupOrchestrator } from "./dispatch/setup.js";
import { setupScheduler } from "./scheduler/setup.js";
import { isAutonomousDispatchPaused } from "./map/dispatch-policy.js";
import { startTaskBinder, stopTaskBinder } from "./cascade/task-binder.js";
import { installAsResolverFetcher as installCascadeDiffFetcher } from "./map/cascade-diff-protocol.js";
import { startThreadLifecycle, stopThreadLifecycle } from "./dispatch/thread-lifecycle.js";
import { fetchSpecForDispatch } from "./api/routes/specs.js";
import { findResourceById as findResourceForSchedule } from "./db/dal/syncable-resources.js";
import { createOpenHiveSpecResolver } from "./scheduler/setup.js";
import { takeSpawnedFallback } from "./scheduler/spawn-tracker.js";
import { findSwarmById } from "./db/dal/map.js";
import { createOpenHiveMailTransport } from "./dispatch/mail-transport.js";
import { createOpenHiveMailPort } from "./dispatch/openhive-mail-port.js";
import { setupMailCompletionObserver } from "./dispatch/mail-completion.js";
import { setAcpAvailabilityProbe } from "./dispatch/routing.js";
import type { AcpStreamManager } from "./dispatch/openhive-runtime.js";
import { sendToSwarm } from "./map/sync-listener.js";
import type { Orchestrator, Scheduler } from "swarm-dispatch";
import { startAutoPull, stopAutoPull } from "./sync/auto-pull.js";
import { initMail, getMailJsonRpc, getMailStorage, getMailEvents } from "./mail/index.js";
import { setupMapWebSocket, stopMapWebSocket, disconnectSessionsForAgent } from "./map/ws-map.js";
import { initTokenService, loadRevocations, setPersistence, setSessionCleanupHook } from "./map/token-service.js";
import { BridgeManager } from "./bridge/manager.js";
import { SwarmHubConnector } from "./swarmhub/connector.js";
import { normalize, routeEvent } from "./events/index.js";
// Coordination service removed — messaging and contexts are standalone modules
import { initProviders as initSyncProviders } from "./sync/providers/index.js";
import { registerHostnameGuard } from "./api/middleware/hostname-guard.js";

export interface HiveServer {
  fastify: FastifyInstance;
  config: Config;
  start(): Promise<string>;
  stop(): Promise<void>;
}

export async function createHive(
  configInput?: Partial<Config> | string,
): Promise<HiveServer> {
  // Load configuration
  let config: Config;
  if (typeof configInput === "string") {
    config = loadConfig(configInput);
  } else if (configInput) {
    config = loadConfig();
    // Merge with provided config
    Object.assign(config, configInput);
  } else {
    config = loadConfig();
  }

  // Initialize database
  initDatabase(config.database);

  // Seed the openteams bundle store from authored team_template / loadout
  // rows so `map/resources/get { type: x-openteams/* }` works immediately
  // after restart. The store is in-memory for this iteration; once promoted
  // to a `team_bundles` table, this pass becomes redundant.
  try {
    const seed = await seedOpenteamsBundleStore();
    if (seed.loadouts || seed.teams || seed.errors.length) {
      console.log(
        `[openhive] openteams bundle store seeded: ${seed.loadouts} loadout(s), ${seed.teams} team(s)` +
          (seed.errors.length ? `, ${seed.errors.length} error(s)` : ''),
      );
      for (const err of seed.errors) {
        console.warn(
          `[openhive]   seed error: ${err.resource_type} ${err.resource_id} — ${err.message}`,
        );
      }
    }
  } catch (err) {
    console.warn('[openhive] openteams bundle seed failed', (err as Error).message);
  }

  // Set up auth mode
  if (config.auth.mode === "local") {
    const agent = await getOrCreateLocalAgent();
    setLocalAgent(agent);
    console.log(
      '[openhive] Local auth mode — all requests auto-authenticated as "local"',
    );
    if (config.admin.trustLocalMode) {
      console.warn(
        '[openhive] ⚠  admin.trustLocalMode=true — admin routes accept NO credentials',
      );
      console.warn(
        '[openhive]    Any client that can reach this port can run admin commands.',
      );
      console.warn(
        '[openhive]    Only safe on localhost-bound or otherwise-trusted networks.',
      );
    }
  } else if (config.auth.mode === "swarmhub") {
    const swarmhubApiUrl =
      config.swarmhub.apiUrl || process.env.SWARMHUB_API_URL;
    // JWKS init is deferred until the connector fetches the client_id from
    // SwarmHub's bridge config. If the legacy env var is still set, use it
    // as an early hint so tokens can be validated before the connector connects.
    if (swarmhubApiUrl && config.swarmhub.oauth.clientId) {
      const jwksUrl =
        config.swarmhub.oauth.jwksUrl ||
        `${swarmhubApiUrl}/.well-known/jwks.json`;
      initJwks({
        jwksUrl,
        audience: config.swarmhub.oauth.clientId,
      });
      console.log(
        "[openhive] SwarmHub auth mode — JWKS initialized (from env)",
      );
    } else if (swarmhubApiUrl) {
      console.log(
        "[openhive] SwarmHub auth mode — JWKS will initialize after connector fetches client_id",
      );
    }
  }

  // Initialize storage if configured
  if (config.storage) {
    initializeStorage(config.storage as StorageConfig);
    // Ensure local upload directory exists
    if (config.storage.type === "local") {
      const uploadPath = path.resolve(config.storage.path);
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
    }
  }


  // Initialize session storage for trajectory content caching.
  // Configurable via config.sessions.type: 'local' (default), 's3', or 'none'.
  if (!isSessionStorageInitialized() && config.sessions.type !== 'none') {
    if (config.sessions.type === 'local') {
      const sessionsPath = config.sessions.path
        ? path.resolve(config.sessions.path)
        : path.join(resolveDataDir(), 'data', 'sessions');
      if (!fs.existsSync(sessionsPath)) {
        fs.mkdirSync(sessionsPath, { recursive: true });
      }
      initializeLocalSessionStorage({ type: 'local', basePath: sessionsPath });
    } else if (config.sessions.type === 's3' && config.sessions.bucket) {
      // S3 storage — lazy-loaded to avoid requiring @aws-sdk at startup
      import('./sessions/storage/index.js').then(({ initializeSessionStorage }) => {
        initializeSessionStorage({
          type: 's3',
          bucket: config.sessions.bucket!,
          region: config.sessions.region || 'us-east-1',
          prefix: 'sessions/',
        } as any);
      }).catch(() => {
        console.warn('[openhive] Failed to initialize S3 session storage');
      });
    }
  }


  // Create Fastify instance
  const fastify = Fastify({
    logger: {
      level: "info",
    },
  });

  // Register CORS
  if (config.cors.enabled) {
    await fastify.register(cors, {
      origin: config.cors.origin,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"],
    });
  }


  // Hostname guard — rejects requests with mismatched Host header.
  // Only active in swarmhub auth mode (managed hosting). Skipped in
  // local mode so developers can access via localhost, IP, tunnels, etc.
  if (config.auth.mode === "swarmhub") {
    registerHostnameGuard(fastify, config.instance.url);
  }


  // Register multipart for file uploads
  await fastify.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
      files: 1, // Only one file at a time
    },
  });

  // Register WebSocket
  await fastify.register(websocket);

  // Setup WebSocket handlers
  setupWebSocket(fastify);

  // Initialize MAP mail module (agent-inbox)
  // Uses in-memory storage; pass getDatabase() for SQLite co-location
  if (config.mapHub.enabled) {
    try {
      const { getDatabase: getDb } = await import('./db/index.js');
      await initMail({ sqliteDb: getDb(), sqlitePrefix: 'mail_' });
    } catch {
      // Fallback to in-memory if DB isn't available
      await initMail();
    }
  }


  // Register MAP inbound WebSocket (/ws/map) for agents connecting to the hub
  if (config.mapHub.enabled) {
    // Initialize agent-iam TokenService UNIVERSALLY (all trust modes).
    //
    // Historically this was gated on `trustModel === 'verified'`, but with
    // agent-iam scopes replacing the DB-backed capability system (see
    // docs/RFC_AGENT_CAPABILITIES.md), the token service needs to be
    // available in `open` trust too so agents can exchange their API key
    // for a scoped token and use it on REST routes. Cost is negligible
    // — an HMAC secret and an in-memory revocation set.
    const { getDatabaseConfig } = await import("./db/index.js");
    const dbConf = getDatabaseConfig();
    const dataDir = dbConf?.type === 'sqlite' && dbConf.path
      ? path.dirname(path.dirname(dbConf.path)) // <dataDir>/data/openhive.db → <dataDir>
      : undefined;
    initTokenService(config.mapHub.iamSecret, dataDir);

    // Note: agent-iam tokens for regular agents are now minted only via
    // `map/agents/spawn` (by parent agents) or `admin onboard-token`
    // (by operators). Session scopes are resolved at map/connect time
    // from DB capabilities, so grant changes take effect on next
    // reconnect. See docs/RFC_AGENT_CAPABILITIES.md v4.

    // Wire up DB persistence for token revocation
    try {
      const { addRevokedToken, removeRevokedToken, listRevokedTokens } = await import("./db/dal/map.js");
      setPersistence({ revoke: addRevokedToken, unrevoke: removeRevokedToken });

      // Load persisted revocations from the database
      const revoked = listRevokedTokens();
      if (revoked.length > 0) {
        loadRevocations(revoked);
        console.log(`[openhive] Loaded ${revoked.length} persisted token revocation(s)`);
      }
    } catch {
      // Table may not exist yet on first run before migration
    }
    // Close in-flight WS sessions when their token is revoked so the
    // scope cache doesn't outlive the revocation. See RFC v4 §"Session
    // scope resolution" and H2 in the review addendum.
    setSessionCleanupHook(disconnectSessionsForAgent);
    setupMapWebSocket(fastify, config);
  }

  // Register terminal WebSocket (native PTY for TUI tunneling)
  // Gated behind swarm hosting — terminal only makes sense when hosting swarms.
  // Dynamic import so @lydell/node-pty being unavailable doesn't crash the server.
  if (config.swarmHosting.enabled) {
    try {
      const { PtyManager, handleTerminalWebSocket } =
        await import("./terminal/index.js");
      const ptyManager = new PtyManager();
      (
        fastify as unknown as { ptyManager: InstanceType<typeof PtyManager> }
      ).ptyManager = ptyManager;

      fastify.get("/ws/terminal", { websocket: true }, (socket, request) => {
        const ws = socket as unknown as import("ws").WebSocket;
        const query = request.query as Record<string, string>;
        // handleTerminalWebSocket awaits sandbox setup when ?sandbox=1; surface
        // any rejection here so it doesn't become an unhandled promise.
        handleTerminalWebSocket(ws, query, ptyManager).catch((err) => {
          console.error("[openhive] terminal-ws handler failed:", err);
          try {
            ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
            ws.close();
          } catch {
            // socket may already be closed
          }
        });
      });

      console.log("[openhive] Terminal WebSocket registered at /ws/terminal");
    } catch (err) {
      console.warn(
        `[openhive] Terminal support unavailable: ${(err as Error).message}`,
      );
    }
  }

  // Initialize BridgeManager if bridge feature is enabled
  let bridgeManager: BridgeManager | undefined;
  if (config.bridge.enabled) {
    bridgeManager = new BridgeManager({
      maxBridges: config.bridge.maxBridges,
      credentialEncryptionKey: config.bridge.credentialEncryptionKey,
      webhookBaseUrl: config.bridge.webhookBaseUrl,
    });
    console.log("[openhive] Bridge feature enabled");
  }

  // Initialize SwarmHub connector (auto-detects SWARMHUB_API_URL + SWARMHUB_HIVE_TOKEN)
  let swarmhubConnector: SwarmHubConnector | null = null;
  if (config.swarmhub.enabled || SwarmHubConnector.fromEnv()) {
    swarmhubConnector = SwarmHubConnector.fromEnv();
    if (swarmhubConnector) {
      (
        fastify as unknown as { swarmhubConnector: SwarmHubConnector }
      ).swarmhubConnector = swarmhubConnector;
      console.log("[openhive] SwarmHub connector detected");
    }
  }


  // Register API routes
  await registerRoutes(fastify, config, bridgeManager, swarmhubConnector);

  // Register sync protocol routes (peer-to-peer, separate from API)
  await fastify.register(syncProtocolRoutes, { prefix: "/sync/v1" });

  // Initialize sync service
  let syncService: SyncService | null = null;
  if (config.sync.enabled) {
    syncService = initSyncService(config.sync);
  }

  // Initialize SwarmCraft plugin (MAP client for agent monitoring)
  if (config.swarmcraft.enabled) {
    try {
      const { getDatabaseConfig } = await import("./db/index.js");
      const dbConf = getDatabaseConfig();
      const dbPath =
        dbConf && dbConf.type === "sqlite" ? dbConf.path : "./data/openhive.db";

      const scPrefix = config.swarmcraft.prefix || "/api/swarmcraft";
      const scWsPath = config.swarmcraft.wsPath || "/ws/swarmcraft";

      // Instantiate the MAPClientManager OpenHive-side so we own the
      // outbound MAP client pool. SwarmCraft uses this exact instance for
      // ACP routing, subprocess wiring, and lifecycle listeners — no
      // second manager is ever created on the SC side.
      //
      // Ownership contract (matches `skipAgentLifecycle: true` below):
      //   - OpenHive initiates connections (swarm-bridge.connectMapClient).
      //   - OpenHive tears it down on server close (see the onClose hook).
      //   - SwarmCraft's destroySwarmCraftContext leaves it alone because
      //     `ownsMapClientManager` is false when the option is supplied.
      //
      // Requires the `swarmcraft/map` export and `mapClientManager` plugin
      // option, both shipped in the local `references/swarmcraft` checkout
      // symlinked into node_modules.
      const { MAPClientManager } = await import("swarmcraft/map");
      const openhiveMapClientManager = new MAPClientManager({
        info: (m: string, ...a: unknown[]) => (fastify.log.info as Function)(m, ...a),
        warn: (m: string, ...a: unknown[]) => (fastify.log.warn as Function)(m, ...a),
        error: (m: string, ...a: unknown[]) => (fastify.log.error as Function)(m, ...a),
        debug: (m: string, ...a: unknown[]) => (fastify.log.debug as Function)(m, ...a),
      });

      // Teardown: register this hook BEFORE `fastify.register(swarmcraftPlugin,
      // ...)` so that Fastify's LIFO onClose ordering fires SC's internal
      // teardown first (which calls `acpStreamManager.closeAll()` against
      // the still-live MAP client connections) and this hook last
      // (disconnecting the mcm only after no ACP stream holds a reference).
      // `bridgeHandle` is populated later via closure.
      let bridgeHandle: { teardown(): void } | undefined;
      fastify.addHook("onClose", async () => {
        if (bridgeHandle) bridgeHandle.teardown();
        try {
          await openhiveMapClientManager.disconnectAll();
        } catch (err) {
          console.warn(
            `[openhive] MAPClientManager teardown failed: ${(err as Error).message}`,
          );
        }
      });

      const { swarmcraftPlugin } = await import("swarmcraft/plugin");
      await fastify.register(swarmcraftPlugin, {
        database: { type: "sqlite", path: dbPath, tablePrefix: "sc_" },
        prefix: scPrefix,
        wsPath: scWsPath,
        logLevel: config.swarmcraft.logLevel || "info",
        corsOrigin:
          typeof config.cors.origin === "string"
            ? config.cors.origin
            : undefined,
        // Enable sessionlog watcher for live local agent session tracking
        sessionlog: {
          enabled: true,
          repoPath: process.cwd(),
          pollIntervalMs: 3000,
        },
        // Trajectory auto-enables with memory provider when sessionlog is on
        // Suppress swarmcraft's built-in MAP agent-lifecycle handlers — the
        // OpenHive bridge (swarm-bridge.ts) is the sole writer of agent rows
        // in the SwarmCraft DB (with `oh-node-*` namespaced ids) and owns
        // ACP stream cleanup on agent termination. Without this flag, the
        // built-in handlers would also write rows using raw MAP ids and we
        // would end up with two DB rows per logical agent.
        skipAgentLifecycle: true,
        // See MAPClientManager instantiation comment above for the
        // ownership contract this establishes — exactly one outbound MAP
        // client pool exists, owned by OpenHive.
        mapClientManager: openhiveMapClientManager,
      });
      console.log(`[openhive] SwarmCraft plugin registered at ${scPrefix}`);

      // Initialize the full OpenHive → SwarmCraft data bridge
      // (replaces the inline MAP client auto-connect with a comprehensive
      //  bridge that also projects sessions, tasks, and resources)
      const { setupOpenHiveBridge } = await import("./swarmcraft/bridge.js");
      const sc = (fastify as any).swarmcraft;

      // Safety guard: verify the plugin is actually using our instance. If
      // someone ever refactors the plugin to ignore the `mapClientManager`
      // option, `sc.mapClientManager` would silently diverge from
      // `openhiveMapClientManager` and we'd have two competing managers —
      // exactly the regression this whole change exists to prevent. Fail
      // loud at startup rather than let the drift go unnoticed.
      if (sc.mapClientManager !== openhiveMapClientManager) {
        throw new Error(
          "[openhive] SwarmCraft plugin did not adopt the host-provided MAPClientManager " +
          "(sc.mapClientManager !== openhiveMapClientManager). The ownership contract is broken."
        );
      }
      if (sc.ownsMapClientManager !== false) {
        throw new Error(
          "[openhive] SwarmCraft reports ownsMapClientManager=true despite receiving a " +
          "host-provided manager. Plugin option wiring is broken."
        );
      }

      bridgeHandle = await setupOpenHiveBridge({
        db: sc.db,
        wsHub: sc.wsHub,
        positionService: sc.positionService,
        trajectoryService: sc.trajectoryService,
        mapClientManager: sc.mapClientManager,
        acpStreamManager: sc.acpStreamManager,
        pipelineService: sc.pipelineService,
      });

      // Bridge ACP events from SwarmCraft WS (/ws/swarmcraft) to OpenHive WS (/ws).
      // The frontend's useWebSocket hooks listen on /ws. ACP streaming events
      // (acp.session.update, acp.prompt.completed, etc.) are broadcast on
      // SwarmCraft's wsHub. The bridge wraps wsHub.broadcast() so acp.*
      // events from the `acp` topic also reach OpenHive's `global` channel.
      // See src/realtime/acp-bridge.ts for the implementation.
      const { broadcastToChannel } = await import("./realtime/index.js");
      const { installAcpBridge } = await import("./realtime/acp-bridge.js");
      installAcpBridge(sc.wsHub, broadcastToChannel);
      console.log('[openhive] ACP event bridge active (SwarmCraft → OpenHive WS)');
      // onClose hook is already registered above (pre-`fastify.register`) so
      // SC's internal teardown runs first via LIFO ordering. See the comment
      // block next to `let bridgeHandle` above for why.
    } catch (err) {
      console.warn(
        `[openhive] Failed to register SwarmCraft plugin: ${(err as Error).message}`,
      );
    }
  }

  // Stale swarm sweep timer
  let staleSweepTimer: NodeJS.Timeout | null = null;

  // Initialize swarm hosting manager
  let swarmManager: SwarmManager | null = null;
  if (config.swarmHosting.enabled) {
    const instanceUrl =
      config.instance.url ||
      `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
    swarmManager = new SwarmManager(
      config.swarmHosting as SwarmHostingConfig,
      instanceUrl,
    );
    // Attach to fastify instance so routes can access it
    (fastify as unknown as { swarmManager: SwarmManager }).swarmManager =
      swarmManager;

    // Wire PtyManager into SwarmManager so kind=claude-code spawns can use
    // it. PtyManager was created earlier in the bootstrap if available; if
    // it isn't (terminal disabled, node-pty not installed), claude-code
    // spawns will fail with a clear "PtyManager not configured" error.
    const ptyManager = (
      fastify as unknown as { ptyManager?: import('./terminal/pty-manager.js').PtyManager }
    ).ptyManager;
    if (ptyManager) {
      swarmManager.setPtyManager(ptyManager);
    }

    // Wire CodexAppServerManager so kind=codex with mode=rpc can spawn the
    // app-server child process and drive it via JSON-RPC. No external
    // native deps — just a child_process + ws client — so this is safe to
    // construct unconditionally when swarm hosting is enabled.
    try {
      const { CodexAppServerManager } = await import('./swarm/codex-app-server-manager.js');
      const codexAppServerManager = new CodexAppServerManager();
      swarmManager.setCodexAppServerManager(codexAppServerManager);
      (fastify as unknown as { codexAppServerManager?: typeof codexAppServerManager })
        .codexAppServerManager = codexAppServerManager;
    } catch (err) {
      console.warn(
        '[openhive] CodexAppServerManager unavailable — kind=codex+mode=rpc spawns will fail:',
        (err as Error).message,
      );
    }

    console.log("[openhive] Swarm hosting enabled");
  }

  // Initialize learning engine (cognitive-core Atlas)
  let atlasService: import('./learning/atlas-service.js').AtlasService | null = null;
  if (config.learning.enabled) {
    const { AtlasService } = await import('./learning/atlas-service.js');
    // Use local agent as owner for learning resources
    const localAgent = await getOrCreateLocalAgent();
    atlasService = new AtlasService(config, localAgent.id);
    try {
      await atlasService.init();
      (fastify as unknown as { atlasService: typeof atlasService }).atlasService = atlasService;
      console.log("[openhive] Learning engine (Atlas) initialized");
    } catch (err) {
      console.warn(`[openhive] Learning engine failed to initialize: ${(err as Error).message}`);
      console.warn("[openhive] Learning features will be unavailable");
      atlasService = null;
    }
  }


  // Initialize dispatch orchestrator (swarm-dispatch integration)
  let dispatchOrchestrator: Orchestrator | null = null;
  try {
    const mailTransport = createOpenHiveMailTransport({
      getMailJsonRpc,
      getMailStorage,
      getMailEvents,
      sendToSwarm,
    });
    const messagePort = createOpenHiveMailPort(mailTransport, {
      mailLifecycleDefault: config.dispatch.mail_lifecycle_default,
      getMailJsonRpc,
    });

    dispatchOrchestrator = setupOrchestrator({
      // Scheduler `fallback_spawn` cleanup. When a dispatch that was
      // backed by an auto-spawned hosted swarm reaches terminal, stop
      // the swarm so we don't leak compute. See `src/scheduler/spawn-tracker.ts`.
      onTerminal: async (taskId, _status) => {
        const binding = takeSpawnedFallback(taskId);
        if (!binding || !binding.cleanupOnTerminal) return;
        if (!swarmManager) return;
        try {
          await (swarmManager as unknown as {
            stop: (id: string, agentId?: string) => Promise<unknown>;
          }).stop(binding.hostedSwarmId);
        } catch (err) {
          console.warn(
            `[scheduler] failed to stop fallback-spawned hosted swarm ${binding.hostedSwarmId}: ${(err as Error).message}`,
          );
        }
      },
      specFetcher: {
        async fetch(resourceId: string, specId: string) {
          const result = await fetchSpecForDispatch(resourceId, specId, 'system');
          if (!result.ok) return null;
          const { node, neighbors } = result.data;
          const tasks = neighbors
            .filter((n) => {
              const meta = n.metadata as Record<string, unknown> | undefined;
              return n.type === 'task' || meta?.kind === 'task';
            })
            .map((n) => ({
              id: String(n.id),
              title: n.title as string | undefined,
              status: n.status as string | undefined,
            }));
          return {
            title: (node.title as string) ?? 'Untitled spec',
            content: (node.content as string) ?? '',
            tasks,
            metadata: (node.metadata as Record<string, unknown> | undefined) ?? {},
          };
        },
      },
      runtimeDeps: {
        getAcpStreamManager: () => {
          const sc = (fastify as unknown as { swarmcraft?: { acpStreamManager?: AcpStreamManager } }).swarmcraft;
          return sc?.acpStreamManager;
        },
        acpLifecycleDefault: config.dispatch.acp_lifecycle_default,
      },
      messagePort,
      dispatchConfig: config.dispatch,
      getMailJsonRpc,
    });
    setAcpAvailabilityProbe(() => {
      const sc = (fastify as unknown as { swarmcraft?: { acpStreamManager?: AcpStreamManager } }).swarmcraft;
      return !!sc?.acpStreamManager;
    });
    // Tear down the mail transport on server close so we don't leak the
    // mail.turn.added listener + ingress subscription across reloads (tests,
    // hot-reload dev loops). `destroy` is a no-op on already-destroyed ports.
    fastify.addHook('onClose', async () => {
      try {
        mailTransport.destroy?.();
      } catch {
        /* best effort */
      }
    });

    // Wire the mail-route completion observer. swarm-dispatch's
    // MessagePort contract only has `onIncoming` (inbound new work), no
    // `onResult`/reply observation — without this, mail-route dispatches
    // sit at `running` until the stall timeout flips them to `failed`,
    // never reaching `complete` on the happy path.
    const stopMailCompletion = setupMailCompletionObserver({ getMailEvents });
    fastify.addHook('onClose', async () => {
      try {
        stopMailCompletion();
      } catch {
        /* best effort */
      }
    });

    console.log('[openhive] Dispatch orchestrator initialized');
  } catch (err) {
    console.warn(`[openhive] Dispatch orchestrator failed: ${(err as Error).message}`);
  }

  // Initialize scheduler (cron-style recurring dispatches via swarm-dispatch)
  let scheduler: Scheduler | null = null;
  try {
    scheduler = setupScheduler({
      getSwarmStatus: (swarmId: string) => {
        const s = findSwarmById(swarmId);
        if (!s) return 'unknown';
        return s.status === 'online' ? 'online' : 'offline';
      },
      spawnFallbackSwarm: swarmManager
        ? async ({ adapter, name }) => {
            const adapterMap: Record<string, 'openswarm' | 'claude-code' | 'codex'> = {
              openswarm: 'openswarm',
              'claude-code': 'claude-code',
              codex: 'codex',
            };
            const kind = adapterMap[adapter] ?? 'openswarm';
            // Spawn under a synthetic system owner — fallback swarms are
            // schedule-driven, not user-initiated. SwarmManager.spawn
            // signature: spawn(ownerAgentId, opts) → HostedSwarm
            const hosted = await swarmManager!.spawn(
              'system',
              { name, kind } as Parameters<typeof swarmManager.spawn>[1],
            );
            if (!hosted.swarm_id) {
              throw new Error('spawn returned no swarm_id');
            }
            // Wait briefly for the swarm to come online so the orchestrator's
            // first routing attempt has a registered target.
            const swarmId = hosted.swarm_id;
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline) {
              const s = findSwarmById(swarmId);
              if (s?.status === 'online') break;
              await new Promise((r) => setTimeout(r, 1_000));
            }
            return { swarmId, hostedSwarmId: hosted.id };
          }
        : undefined,
      // See `createOpenHiveSpecResolver` for the rationale (existence-only
      // check, no auth, no opentasks resolution — matches the orchestrator's
      // permissive enrichWithSpec semantic).
      fetchSpec: createOpenHiveSpecResolver({
        findResourceById: findResourceForSchedule,
      }),
      isAutonomousDispatchPaused,
      tickIntervalMs: config.scheduler.tickIntervalMs,
      maxConcurrentFires: config.scheduler.maxConcurrentFires,
    });
    scheduler.start();
    fastify.addHook('onClose', async () => {
      try {
        await scheduler?.stop();
      } catch {
        /* best effort */
      }
    });
    console.log('[openhive] Scheduler initialized');
  } catch (err) {
    console.warn(`[openhive] Scheduler failed: ${(err as Error).message}`);
  }

  // Serve skill.md. In server mode, strip the social-layer sections since
  // nobody is there to post or browse — agents see only protocol + coordination docs.
  fastify.get("/skill.md", async (_request, reply) => {
    if (config.mode === "server") {
      const { renderDocument } = await import("./api/skill-fragments/index.js");
      const skillMd = renderDocument(config, { audiences: ["shared", "agent"] });
      return reply.type("text/markdown").send(skillMd);
    }
    const skillMd = generateSkillMd(config);
    return reply.type("text/markdown").send(skillMd);
  });

  // Per-fragment skill docs for agents that want only a slice.
  // Returns the rendered fragment markdown or 404 for unknown IDs.
  fastify.get<{ Params: { section: string } }>(
    "/skill/:section.md",
    async (request, reply) => {
      const { renderFragment } = await import("./api/skill-fragments/index.js");
      const content = renderFragment(request.params.section, config);
      if (content === null) {
        return reply.status(404).type("text/plain").send(`Unknown fragment: ${request.params.section}`);
      }
      return reply.type("text/markdown").send(content + "\n");
    },
  );

  // Serve sitemap.xml for SEO
  fastify.get("/sitemap.xml", async (_request, reply) => {
    const baseUrl =
      config.instance.url || `http://${config.host}:${config.port}`;
    const sitemap = generateSitemap({ baseUrl });
    return reply.type("application/xml").send(sitemap);
  });

  // Serve robots.txt for crawlers
  fastify.get("/robots.txt", async (_request, reply) => {
    const baseUrl =
      config.instance.url || `http://${config.host}:${config.port}`;
    const robotsTxt = generateRobotsTxt(baseUrl);
    return reply.type("text/plain").send(robotsTxt);
  });

  // Serve web UI static files (if they exist)
  // In dev mode (__dirname = src/), src/web has source files not built assets,
  // so we check for a built index.html to avoid serving raw .tsx files.
  const webPath = path.join(__dirname, "web");
  const webPathAlt = path.join(__dirname, "..", "dist", "web");
  const actualWebPath =
    (fs.existsSync(path.join(webPath, "assets")) ? webPath : null) ||
    (fs.existsSync(path.join(webPathAlt, "index.html")) ? webPathAlt : null);

  // Track whether @fastify/static has been registered yet.
  // The first registration decorates the reply with sendFile(); subsequent ones must not.
  let staticRegistered = false;

  // Serve uploaded files from local storage
  if (config.storage?.type === "local") {
    const uploadPath = path.resolve(config.storage.path);
    await fastify.register(fastifyStatic, {
      root: uploadPath,
      prefix: config.storage.publicUrl,
      decorateReply: !staticRegistered,
    });
    staticRegistered = true;
  }

  if (config.mode === "server") {
    // Headless mode: skip SPA + admin UI entirely. GET / returns a small
    // JSON pointer so agents / operators hitting the root get something
    // useful rather than a stack of HTML. /admin returns a friendly
    // "use the CLI" message.
    fastify.get("/", async (_request, reply) => {
      return reply.send({
        name: config.instance.name,
        version: "0.1.0",
        mode: "server",
        endpoints: {
          api: "/api/v1",
          websocket: "/ws",
          skill: "/skill.md",
          wellKnown: "/.well-known/openhive.json",
        },
      });
    });
    fastify.get("/admin", async (_request, reply) => {
      return reply
        .type("text/html")
        .send(
          `<!doctype html><meta charset="utf-8"><title>OpenHive — server mode</title>` +
          `<body style="font-family:system-ui;max-width:40em;margin:4em auto;padding:0 1em">` +
          `<h1>OpenHive · server mode</h1>` +
          `<p>This hub is running headless. There is no web admin UI.</p>` +
          `<p>Manage it via the CLI: <code>openhive admin --help</code></p>` +
          `<p>API docs: <a href="/skill.md">/skill.md</a></p>` +
          `</body>`,
        );
    });
  } else if (actualWebPath) {
    // Serve tree-sitter / kuzu WASM grammars directly from the swarmcraft
    // package. Same physical files are otherwise bundled twice — once here
    // and once under `node_modules/swarmcraft/public/wasm/` for the
    // server-side parser-loader. This route dedupes the ~24 MB duplicate
    // out of the packaged app by pointing the HTTP `/wasm/*` route at the
    // swarmcraft copy (which is required by swarmcraft's own runtime).
    //
    // Must register BEFORE the `/` SPA route so the more-specific prefix
    // wins in Fastify's radix routing.
    //
    // `swarmcraft`'s `package.json` isn't listed under its `exports`
    // field so we can't require.resolve it directly under strict ESM.
    // Resolve the main entry instead, then walk up to find the package
    // root (where `public/wasm/` lives).
    try {
      let dir = path.dirname(requireFrom.resolve("swarmcraft"));
      while (dir !== path.dirname(dir)) {
        const pkgPath = path.join(dir, "package.json");
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
            if (pkg.name === "swarmcraft") break;
          } catch {
            // ignore malformed package.json and keep walking
          }
        }
        dir = path.dirname(dir);
      }
      const swarmcraftWasm = path.join(dir, "public", "wasm");
      if (fs.existsSync(swarmcraftWasm)) {
        await fastify.register(fastifyStatic, {
          root: swarmcraftWasm,
          prefix: "/wasm/",
          decorateReply: !staticRegistered,
        });
        staticRegistered = true;
      }
    } catch {
      // swarmcraft not resolvable (unusual); fall through — the `/` SPA
      // static below will still serve dist/web/wasm/ if vite built it.
    }

    await fastify.register(fastifyStatic, {
      root: actualWebPath,
      prefix: "/",
      decorateReply: !staticRegistered,
    });
    staticRegistered = true;

    // SPA fallback for all non-API routes
    fastify.setNotFoundHandler((request, reply) => {
      // Don't serve SPA for API routes or skill.md
      if (
        request.url.startsWith("/api") ||
        request.url === "/skill.md" ||
        request.url.startsWith("/.well-known")
      ) {
        return reply.status(404).send({ error: "Not Found" });
      }
      // Serve index.html for SPA routes
      return reply.sendFile("index.html", actualWebPath);
    });
  } else {
    // Serve inline admin panel if no built web UI
    fastify.get("/", async (_request, reply) => {
      return reply.type("text/html").send(getWelcomeHtml(config));
    });
    fastify.get("/admin", async (_request, reply) => {
      return reply.type("text/html").send(getInlineAdminHtml(config));
    });
    fastify.get("/admin/*", async (_request, reply) => {
      return reply.type("text/html").send(getInlineAdminHtml(config));
    });
  }

  // Federation discovery (stub)
  fastify.get("/.well-known/openhive.json", async (_request, reply) => {
    // Get stats from database
    const db = getDatabase();
    const agentCount = db
      .prepare("SELECT COUNT(*) as count FROM agents")
      .get() as { count: number };
    const hiveCount = db
      .prepare("SELECT COUNT(*) as count FROM hives")
      .get() as { count: number };

    const wellKnown: Record<string, unknown> = {
      version: "0.2.0",
      name: config.instance.name,
      description: config.instance.description,
      url: config.instance.url,
      mode: config.mode,
      federation: {
        enabled: config.federation.enabled,
        protocol_version: "1.0",
      },
      stats: {
        agents: agentCount.count,
        hives: hiveCount.count,
      },
      features: {
        swarm_hosting: config.swarmHosting.enabled,
        swarmcraft: config.swarmcraft.enabled,
        swarmhub: swarmhubConnector?.isConnected || false,
      },
      // Capabilities reflect the live runtime, not just the config — agents
      // probing this endpoint need to know what actually works right now
      // (e.g. whether the dispatch orchestrator came up successfully).
      capabilities: {
        map_hub: {
          enabled: config.mapHub.enabled,
          trust_model: config.mapHub.trustModel ?? "open",
        },
        dispatch: {
          enabled: true, // route surface is always mounted
          orchestrator: dispatchOrchestrator?.running ?? false,
        },
        sync: {
          enabled: config.federation.enabled,
        },
        sessions: {
          // Trajectory checkpoints land in session storage; if caching is
          // disabled, the on-demand-from-agent path still works but older
          // checkpoints aren't retrievable after the agent disconnects.
          trajectories: config.sessions.type !== "none",
          storage_backend: config.sessions.type,
          chat_transports: ["acp", "mail"],
        },
        tasks: {
          enabled: true,
          map_methods: true,
        },
        cascade: {
          enabled: true,
        },
      },
      endpoints: {
        api: "/api/v1",
        websocket: "/ws",
        skill: "/skill.md",
        skill_fragments: "/skill/{section}.md",
      },
    };

    // Add MAP Hub info if enabled
    if (config.mapHub.enabled) {
      try {
        Object.assign(wellKnown, getWellKnownMapInfo());
      } catch {
        // MAP module not available, skip
      }
    }

    return reply.send(wellKnown);
  });


  // Initialize mesh networking provider
  // Supports: tailscale-cloud, headscale-sidecar, headscale-external, none
  let networkProvider: NetworkProvider;

  if (config.network.provider !== "none") {
    // Use the new network config
    networkProvider = createNetworkProvider(config.network);
  } else if (config.headscale.enabled) {
    // Backward compat: legacy headscale config maps to headscale-sidecar
    const serverUrl =
      config.headscale.serverUrl ||
      config.instance.url ||
      `http://${config.host}:${config.headscale.listenAddr.split(":")[1] || "8085"}`;

    networkProvider = createNetworkProvider({
      provider: "headscale-sidecar",
      headscaleSidecar: {
        serverUrl,
        dataDir: config.headscale.dataDir,
        binaryPath: config.headscale.binaryPath,
        listenAddr: config.headscale.listenAddr,
        baseDomain: config.headscale.baseDomain,
        embeddedDerp: config.headscale.embeddedDerp,
      },
    });
  } else {
    networkProvider = createNetworkProvider({ provider: "none" });
  }

  const server: HiveServer = {
    fastify,
    config,

    async start() {
      // Start mesh networking provider before listening
      if (networkProvider.type !== "none") {
        try {
          await networkProvider.start();
          // Attach to fastify instance so routes can access it
          (
            fastify as unknown as { networkProvider: NetworkProvider }
          ).networkProvider = networkProvider;
          console.log(
            `[openhive] Network provider started (${networkProvider.type})`,
          );
        } catch (err) {
          console.warn(
            `[openhive] Network provider failed to start: ${(err as Error).message}`,
          );
          console.warn(
            "[openhive] MAP hub will work without L3/L4 mesh networking.",
          );
        }
      }

      // Start sync service
      if (syncService) {
        syncService.start();
        console.log(
          `[openhive] Sync service started (instance: ${syncService.getInstanceId()})`,
        );
      }

      // Initialize sync providers (ls-remote, mirror) with config
      initSyncProviders(config);

      // Coordination service removed — messaging and contexts are standalone modules
      // (initialized lazily via getMessagingService() / getContextsService())

      // Start MAP sync listener (subscribe to swarm MAP endpoints for sync messages)
      if (config.mapHub.enabled) {
        initMapSyncListener();
      }

      // Start local resource file watchers (for memory banks and skills with local paths)
      startLocalResourceWatchers().then(() => {
        console.log('[openhive] Local resource file watchers started');
      }).catch(() => {
        // Non-fatal — watchers enhance UX but aren't required
      });

      // Start swarm hosting health monitor
      if (swarmManager) {
        swarmManager.startHealthMonitor();
        console.log("[openhive] Swarm hosting health monitor started");

        // Revive hosted swarms that were alive when openhive last ran.
        // Runs in the background so startup isn't blocked on N Claude Code
        // subprocesses booting — the health monitor + per-swarm DB state
        // surface progress to the UI as it happens.
        swarmManager.reviveHostedSwarms().catch((err) => {
          console.error(
            `[openhive] Hosted swarm revival failed: ${(err as Error).message}`,
          );
        });
      }

      // Create swarm agent delegate for workspace dispatch (used by learning + skill classification)
      if (swarmManager) {
        const { SwarmAgentBackend, SwarmAgentDelegate } = await import('./learning/swarm-agent-backend.js');
        const delegate = new SwarmAgentDelegate(config, swarmManager);
        (fastify as unknown as { swarmDelegate: typeof delegate }).swarmDelegate = delegate;

        // Enable agentic learning compute if configured and Atlas is available
        if (atlasService?.isAvailable() && config.learning.compute.enabled) {
          const backend = new SwarmAgentBackend(delegate);
          atlasService.enableAgenticCompute(backend, delegate);
        }
      }

      // Connect to SwarmHub
      if (swarmhubConnector) {
        try {
          const identity = await swarmhubConnector.connect();
          console.log(
            `[openhive] SwarmHub connector: connected as "${identity.slug}" (${identity.tier})`,
          );

          // Initialize (or re-initialize) JWKS with the client_id from the bridge.
          // This is the primary source of truth — the env var is just an optional early hint.
          const dynamicClientId = swarmhubConnector.getOAuthClientId();
          if (dynamicClientId) {
            const swarmhubApiUrl =
              config.swarmhub.apiUrl || process.env.SWARMHUB_API_URL;
            if (swarmhubApiUrl) {
              const jwksUrl =
                config.swarmhub.oauth.jwksUrl ||
                `${swarmhubApiUrl}/.well-known/jwks.json`;
              initJwks({ jwksUrl, audience: dynamicClientId });
              console.log(
                `[openhive] JWKS initialized with client_id from SwarmHub bridge`,
              );
            }
          }

          // Listen for polled GitHub webhook events (tunnel mode)
          // Note: the connector's processPolledEvent now routes through the event system
          // directly. This listener is kept for any external consumers.
          swarmhubConnector.on(
            "github_webhook",
            (event: {
              event_type: string;
              delivery_id: string;
              payload: Record<string, unknown>;
            }) => {
              const normalized = normalize(
                "github",
                event.event_type,
                event.delivery_id,
                event.payload,
              );
              routeEvent(normalized);
            },
          );
        } catch (err) {
          console.warn(
            `[openhive] SwarmHub connector: failed to connect: ${(err as Error).message}`,
          );
          console.warn(
            "[openhive] SwarmHub features will be unavailable. Retrying on health checks.",
          );
        }
      }

      // Start active bridges
      if (bridgeManager) {
        await bridgeManager.startAll();
        if (bridgeManager.runningCount > 0) {
          console.log(
            `[openhive] Started ${bridgeManager.runningCount} active bridge(s)`,
          );
        }
      }

      // Try to listen, auto-increment port if configured one is taken
      let port = config.port;
      const maxPortAttempts = process.env.NODE_ENV === 'production' ? 10 : 1;
      let address!: string;

      for (let attempt = 0; attempt < maxPortAttempts; attempt++) {
        try {
          address = await fastify.listen({ port, host: config.host });
          break;
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EADDRINUSE" && attempt < maxPortAttempts - 1) {
            console.log(
              `[openhive] Port ${port} in use, trying ${port + 1}...`,
            );
            port++;
            continue;
          }
          throw err;
        }
      }

      // Resolve the actual bound port (Fastify assigns one when port=0) and
      // push it into SwarmManager so bootstrap tokens for hosted swarms
      // point at a reachable URL. Without this, hosts launched with an
      // ephemeral port bake `http://host:0` into every spawn token.
      if (swarmManager) {
        const boundPort = (fastify.server.address() as { port: number } | null)?.port ?? port;
        const resolvedHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
        const resolvedUrl = config.instance.url || `http://${resolvedHost}:${boundPort}`;
        swarmManager.setInstanceUrl(resolvedUrl);
      }

      // Write port file for dev tools (e.g. Vite proxy)
      const portFile = path.join(__dirname, "..", ".dev-port");
      try {
        fs.writeFileSync(portFile, String(port));
      } catch {
        /* ignore */
      }

      // Start stale swarm sweep (safety net for swarms that disconnect uncleanly)
      const sweepMinutes = config.mapHub.staleThresholdMinutes;
      staleSweepTimer = setInterval(() => {
        const marked = markStaleSwarms(sweepMinutes);
        if (marked > 0) {
          console.log(`[openhive] Marked ${marked} stale swarm(s) as offline`);
          broadcastToChannel('map:discovery', {
            type: 'swarm_offline',
            data: { count: marked },
          });
        }
      }, sweepMinutes * 60 * 1000);

      // Start auto-pull service for remote task graphs
      startAutoPull(config.autoPull.intervalMinutes * 60 * 1000);

      // Start dispatch orchestrator polling
      if (dispatchOrchestrator) {
        try {
          await dispatchOrchestrator.start();
          console.log('[openhive] Dispatch orchestrator started');
        } catch (err) {
          console.warn(`[openhive] Dispatch orchestrator failed to start: ${(err as Error).message}`);
        }
      }

      // Start cascade→task binder. No-op unless something opted in to
      // `on_merge` close policy (per-task, per-swarm, or per-hub default).
      try {
        startTaskBinder({ defaultClosePolicy: config.cascade.defaultClosePolicy });
      } catch (err) {
        console.warn(`[openhive] Task binder failed to start: ${(err as Error).message}`);
      }

      // Wire the cascade diff resolver's on-demand fetcher to the MAP
      // wire-protocol module. Idempotent on repeat boot.
      try {
        installCascadeDiffFetcher();
      } catch (err) {
        console.warn(`[openhive] Cascade diff fetcher install failed: ${(err as Error).message}`);
      }

      // Start dispatch thread lifecycle binder. Closes/reopens dispatch
      // coordination threads when linked tasks change status.
      try {
        startThreadLifecycle();
      } catch (err) {
        console.warn(`[openhive] Thread lifecycle failed to start: ${(err as Error).message}`);
      }

      return address;
    },

    async stop() {
      if (staleSweepTimer) {
        clearInterval(staleSweepTimer);
        staleSweepTimer = null;
      }
      stopAutoPull();
      stopHeartbeat();
      stopTaskBinder();
      stopThreadLifecycle();
      if (dispatchOrchestrator?.running) {
        try { await dispatchOrchestrator.stop(); } catch { /* best effort */ }
      }

      // Synchronous cleanup
      const ptyMgr = (
        fastify as unknown as { ptyManager?: { destroyAll(): void } }
      ).ptyManager;
      if (ptyMgr) {
        ptyMgr.destroyAll();
      }
      stopMapWebSocket();
      stopMapSyncListener();
      stopLocalResourceWatchers();
      if (syncService) {
        syncService.stop();
      }

      // Parallel async cleanup — these are independent of each other
      await Promise.allSettled([
        swarmhubConnector?.disconnect(),
        bridgeManager?.stopAll(),
        atlasService?.close(),
        swarmManager?.shutdown(),
        networkProvider.type !== "none" ? networkProvider.stop() : undefined,
      ]);

      await fastify.close();
      closeDatabase();

      // Clean up dev port file
      const portFile = path.join(__dirname, "..", ".dev-port");
      try {
        fs.unlinkSync(portFile);
      } catch {
        /* ignore */
      }
    },
  };

  return server;
}

function getWelcomeHtml(config: Config): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.instance.name}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Manrope', system-ui, sans-serif; background: #08080a; }
    body::before { content: ''; position: fixed; inset: 0; z-index: 0; pointer-events: none; background: radial-gradient(ellipse 80% 40% at 50% -10%, rgba(245,158,11,0.04), transparent 70%); }
    .accent-line { background: linear-gradient(90deg, transparent 0%, #b45309 20%, #f59e0b 40%, #fbbf24 50%, #f59e0b 60%, #b45309 80%, transparent 100%); }
    .glow-btn { box-shadow: 0 0 24px rgba(245,158,11,0.12), 0 1px 2px rgba(0,0,0,0.08); }
    .glow-btn:hover { box-shadow: 0 0 32px rgba(245,158,11,0.2), 0 4px 12px rgba(0,0,0,0.12); transform: translateY(-1px); }
  </style>
</head>
<body class="text-white min-h-screen flex flex-col">
  <div class="accent-line h-0.5 w-full"></div>
  <div class="flex-1 flex items-center justify-center relative z-10">
    <div class="text-center p-8 max-w-lg">
      <div class="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-amber-500/10 mb-6 ring-1 ring-amber-500/20">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220" class="w-12 h-12" style="color: #f59e0b"><path fill-rule="evenodd" fill="currentColor" d="M110,30 L178,69.3 L178,150.7 L110,190 L42,150.7 L42,69.3 Z M110,49 L159,77.3 L159,142.7 L110,171 L61,142.7 L61,77.3 Z"/><circle cx="110" cy="110" r="28" fill="currentColor"/></svg>
      </div>
      <h1 class="text-4xl font-extrabold text-amber-400 mb-3 tracking-tight">${config.instance.name}</h1>
      <p class="text-zinc-400 mb-10 text-lg leading-relaxed">${config.instance.description}</p>
      <div class="space-y-5">
        <div class="flex gap-3 justify-center">
          <a href="/skill.md" class="glow-btn bg-amber-500 hover:bg-amber-400 text-black font-bold px-6 py-3 rounded-xl transition-all duration-200">View API Docs</a>
          <a href="/admin" class="bg-zinc-800/80 hover:bg-zinc-700/80 text-white font-bold px-6 py-3 rounded-xl border border-zinc-700/50 transition-all duration-200">Admin Panel</a>
        </div>
        <p class="text-sm text-zinc-600">Web UI not built. Run <code class="bg-zinc-800 px-2 py-1 rounded-lg text-amber-400/80 text-xs">npm run build:web</code> to build it.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function getInlineAdminHtml(config: Config): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.instance.name} - Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Manrope', system-ui, sans-serif; }
    .font-display { font-family: 'Instrument Serif', Georgia, serif; }
    .accent-line { background: linear-gradient(90deg, transparent 0%, #b45309 20%, #f59e0b 40%, #fbbf24 50%, #f59e0b 60%, #b45309 80%, transparent 100%); }
    .glow { box-shadow: 0 0 24px rgba(245,158,11,0.12), 0 1px 2px rgba(0,0,0,0.08); }
    .glow:hover { box-shadow: 0 0 32px rgba(245,158,11,0.2), 0 4px 12px rgba(0,0,0,0.12); }
    .stat-card { background: linear-gradient(135deg, rgba(245,158,11,0.06) 0%, transparent 60%); }
    ::selection { background-color: rgba(245,158,11,0.3); color: #fff; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #222229; border-radius: 999px; }
    @keyframes fadeInUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .animate-in { animation: fadeInUp 0.3s ease-out; }
  </style>
</head>
<body class="bg-[#08080a] text-[#e8e6e3] min-h-screen">
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;

    function App() {
      const [stats, setStats] = useState(null);
      const [agents, setAgents] = useState([]);
      const [invites, setInvites] = useState([]);
      const [adminKey, setAdminKey] = useState(localStorage.getItem('adminKey') || '');
      const [activeTab, setActiveTab] = useState('dashboard');
      const [error, setError] = useState(null);

      const headers = {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey,
      };

      const fetchData = async () => {
        if (!adminKey) return;
        try {
          const [statsRes, agentsRes, invitesRes] = await Promise.all([
            fetch('/api/v1/admin/stats', { headers }),
            fetch('/api/v1/admin/agents?limit=100', { headers }),
            fetch('/api/v1/admin/invites?limit=100', { headers }),
          ]);

          if (!statsRes.ok) throw new Error('Invalid admin key');

          setStats(await statsRes.json());
          setAgents((await agentsRes.json()).data || []);
          setInvites((await invitesRes.json()).data || []);
          setError(null);
        } catch (err) {
          setError(err.message);
        }
      };

      useEffect(() => {
        if (adminKey) {
          localStorage.setItem('adminKey', adminKey);
          fetchData();
        }
      }, [adminKey]);

      const createInvite = async () => {
        await fetch('/api/v1/admin/invites', {
          method: 'POST',
          headers,
          body: JSON.stringify({ uses: 5 }),
        });
        fetchData();
      };

      const verifyAgent = async (id) => {
        await fetch(\`/api/v1/admin/agents/\${id}/verify\`, {
          method: 'POST',
          headers,
        });
        fetchData();
      };

      const rejectAgent = async (id) => {
        await fetch(\`/api/v1/admin/agents/\${id}/reject\`, {
          method: 'POST',
          headers,
        });
        fetchData();
      };

      if (!adminKey || error) {
        return (
          <div className="min-h-screen flex flex-col">
            <div className="accent-line h-0.5 w-full" />
            <div className="flex-1 flex items-center justify-center" style={{ background: 'radial-gradient(ellipse 80% 40% at 50% -10%, rgba(245,158,11,0.03), transparent 70%)' }}>
              <div className="bg-[#111114] border border-[#1f1f27] p-10 rounded-2xl shadow-2xl max-w-md w-full animate-in">
                <div className="text-center mb-8">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-amber-500/10 mb-4 ring-1 ring-amber-500/20">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220" className="w-8 h-8" style={{ color: '#f59e0b' }}><path fillRule="evenodd" fill="currentColor" d="M110,30 L178,69.3 L178,150.7 L110,190 L42,150.7 L42,69.3 Z M110,49 L159,77.3 L159,142.7 L110,171 L61,142.7 L61,77.3 Z"/><circle cx="110" cy="110" r="28" fill="currentColor"/></svg>
                  </div>
                  <h1 className="font-display text-3xl mb-1">${config.instance.name}</h1>
                  <p className="text-[#6e6a7a] text-sm">Admin Dashboard</p>
                </div>
                {error && (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl mb-4 text-sm">
                    {error}
                  </div>
                )}
                <input
                  type="password"
                  placeholder="Enter admin key"
                  value={adminKey}
                  onChange={(e) => setAdminKey(e.target.value)}
                  className="w-full p-3.5 bg-[#19191e] border border-[#1f1f27] rounded-xl mb-4 text-[#e8e6e3] placeholder-[#6e6a7a] focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500/30 transition-all"
                />
                <button
                  onClick={fetchData}
                  className="glow w-full bg-amber-500 hover:bg-amber-400 text-black font-bold py-3.5 rounded-xl transition-all duration-200 active:scale-[0.97]"
                >
                  Sign In
                </button>
              </div>
            </div>
          </div>
        );
      }

      const tabs = [
        { id: 'dashboard', label: 'Dashboard', icon: '📊' },
        { id: 'agents', label: 'Agents', icon: '🤖' },
        { id: 'invites', label: 'Invites', icon: '🔑' },
      ];

      const pendingCount = agents.filter(a => a.verification_status === 'pending').length;

      return (
        <div className="min-h-screen flex flex-col">
          <div className="accent-line h-0.5 w-full" />

          {/* Header */}
          <header className="border-b border-[#1f1f27] bg-[#111114]/80" style={{ backdropFilter: 'blur(20px)' }}>
            <div className="max-w-7xl mx-auto px-6 flex items-center justify-between h-16">
              <div className="flex items-center gap-3">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220" className="w-6 h-6" style={{ color: '#f59e0b' }}><path fillRule="evenodd" fill="currentColor" d="M110,30 L178,69.3 L178,150.7 L110,190 L42,150.7 L42,69.3 Z M110,49 L159,77.3 L159,142.7 L110,171 L61,142.7 L61,77.3 Z"/><circle cx="110" cy="110" r="28" fill="currentColor"/></svg>
                <span className="font-extrabold text-amber-500 tracking-tight text-lg">${config.instance.name}</span>
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20">Admin</span>
              </div>
              <button
                onClick={() => { setAdminKey(''); localStorage.removeItem('adminKey'); }}
                className="text-[#6e6a7a] hover:text-[#e8e6e3] text-sm font-medium transition-colors"
              >
                Sign out
              </button>
            </div>
          </header>

          <div className="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
            {/* Navigation tabs */}
            <nav className="flex gap-1 p-1 bg-[#111114] border border-[#1f1f27] rounded-xl mb-8 w-fit">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={\`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 \${
                    activeTab === tab.id
                      ? 'bg-amber-500 text-black'
                      : 'text-[#6e6a7a] hover:text-[#e8e6e3] hover:bg-[#19191e]'
                  }\`}
                >
                  <span>{tab.icon}</span>
                  {tab.label}
                  {tab.id === 'agents' && pendingCount > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400 font-medium">
                      {pendingCount}
                    </span>
                  )}
                </button>
              ))}
            </nav>

            {/* Dashboard */}
            {activeTab === 'dashboard' && stats && (
              <div className="animate-in">
                <h2 className="font-display text-2xl mb-6">Overview</h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-8">
                  <div className="stat-card bg-[#111114] border border-[#1f1f27] p-6 rounded-2xl">
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Agents</span>
                      <span className="text-2xl">🤖</span>
                    </div>
                    <div className="text-4xl font-extrabold text-amber-400 tracking-tight">{stats.agents?.total || 0}</div>
                    {stats.agents?.pending > 0 && (
                      <div className="text-xs text-amber-500/80 mt-2 font-medium">{stats.agents.pending} pending verification</div>
                    )}
                  </div>
                  <div className="stat-card bg-[#111114] border border-[#1f1f27] p-6 rounded-2xl">
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Hives</span>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220" className="w-7 h-7" style={{ color: '#f59e0b' }}><path fillRule="evenodd" fill="currentColor" d="M110,30 L178,69.3 L178,150.7 L110,190 L42,150.7 L42,69.3 Z M110,49 L159,77.3 L159,142.7 L110,171 L61,142.7 L61,77.3 Z"/><circle cx="110" cy="110" r="28" fill="currentColor"/></svg>
                    </div>
                    <div className="text-4xl font-extrabold text-emerald-400 tracking-tight">{stats.hives?.total || 0}</div>
                  </div>
                </div>

                {/* Quick info */}
                <div className="bg-[#111114] border border-[#1f1f27] rounded-2xl p-6">
                  <h3 className="font-semibold text-sm mb-4">Instance Info</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-[#6e6a7a]">Name</span>
                      <p className="font-medium mt-0.5">${config.instance.name}</p>
                    </div>
                    <div>
                      <span className="text-[#6e6a7a]">Description</span>
                      <p className="font-medium mt-0.5">${config.instance.description}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Agents */}
            {activeTab === 'agents' && (
              <div className="animate-in">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="font-display text-2xl">Agents</h2>
                  <span className="text-sm text-[#6e6a7a]">{agents.length} total</span>
                </div>
                <div className="bg-[#111114] border border-[#1f1f27] rounded-2xl overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-[#1f1f27]">
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Name</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Type</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Status</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agents.map(agent => (
                        <tr key={agent.id} className="border-t border-[#1f1f27] hover:bg-[#19191e] transition-colors">
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">
                                {agent.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="font-medium">{agent.name}</span>
                            </div>
                          </td>
                          <td className="px-5 py-4">
                            <span className="text-sm text-[#6e6a7a]">{agent.account_type || 'agent'}</span>
                          </td>
                          <td className="px-5 py-4">
                            <span className={\`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold \${
                              agent.is_verified
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : agent.verification_status === 'pending'
                                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                  : 'bg-red-500/10 text-red-400 border border-red-500/20'
                            }\`}>
                              {agent.verification_status}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex gap-2">
                              {!agent.is_verified && agent.verification_status === 'pending' && (
                                <>
                                  <button
                                    onClick={() => verifyAgent(agent.id)}
                                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
                                  >
                                    Verify
                                  </button>
                                  <button
                                    onClick={() => rejectAgent(agent.id)}
                                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                                  >
                                    Reject
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {agents.length === 0 && (
                    <div className="text-center py-12 text-[#6e6a7a]">No agents registered yet</div>
                  )}
                </div>
              </div>
            )}

            {/* Invites */}
            {activeTab === 'invites' && (
              <div className="animate-in">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="font-display text-2xl">Invite Codes</h2>
                  <button
                    onClick={createInvite}
                    className="glow bg-amber-500 hover:bg-amber-400 text-black font-bold px-5 py-2.5 rounded-xl text-sm transition-all duration-200 active:scale-[0.97]"
                  >
                    + Create Invite
                  </button>
                </div>
                <div className="bg-[#111114] border border-[#1f1f27] rounded-2xl overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-[#1f1f27]">
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Code</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Uses Left</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invites.map(invite => (
                        <tr key={invite.id} className="border-t border-[#1f1f27] hover:bg-[#19191e] transition-colors">
                          <td className="px-5 py-4">
                            <code className="font-mono text-sm text-amber-400 bg-amber-500/8 px-2.5 py-1 rounded-lg">{invite.code}</code>
                          </td>
                          <td className="px-5 py-4">
                            <span className="font-medium tabular-nums">{invite.uses_left}</span>
                          </td>
                          <td className="px-5 py-4 text-[#6e6a7a] text-sm">
                            {new Date(invite.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {invites.length === 0 && (
                    <div className="text-center py-12 text-[#6e6a7a]">No invite codes created yet</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>`;
}

