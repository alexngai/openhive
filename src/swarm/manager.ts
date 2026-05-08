/**
 * Swarm Manager
 *
 * Orchestrates the spawning, lifecycle management, and health monitoring
 * of hosted OpenSwarm instances. Bridges hosting providers with the MAP hub.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { createRequire } from 'module';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';
import { broadcastToChannel } from '../realtime/index.js';
import { registerSwarm } from '../map/service.js';
import { delegateForSpawn } from '../map/delegate-for-spawn.js';
import { applyGitSyncConfig } from '../swarmkit/git-sync-config.js';
import * as mapDal from '../db/dal/map.js';
import * as dal from './dal.js';
import { LocalProvider } from './providers/local.js';
import { SandboxedLocalProvider } from './providers/sandboxed-local.js';
import { resolveCredentialOverlay } from './credentials.js';
import { findResourceById, subscribeToResource } from '../db/dal/syncable-resources.js';
import { getDatabase } from '../db/index.js';
import { cloneWorkspaceRepos } from './providers/workspace.js';
import { resolveRepoForSpawn, applyRepoEnvVars, RepoResolutionError } from './resolve-repo.js';
import { getTuiKindStrategy, isTuiKind, type TuiKindStrategy } from './tui-strategies.js';
import * as os from 'os';
import { getInbound } from '../map/connection-registry.js';
// Type-only import — PtyManager is provided at runtime via setPtyManager(),
// not loaded here. This preserves the dynamic-import gating in server.ts
// (PtyManager only loads when swarmHosting.enabled = true and node-pty is
// available).
import type { PtyManager } from '../terminal/pty-manager.js';
// Same dynamic-import pattern as PtyManager — the app-server manager only
// loads when swarmHosting.enabled = true (see server.ts).
import type { CodexAppServerManager } from './codex-app-server-manager.js';
import { resolveCodexBinary } from './codex-binary.js';
import { preTrustCodexWorkdir } from './codex-config.js';
import { translateCodexNotification } from './hosted-chat-events.js';
import type {
  SpawnSwarmInput,
  SwarmProvisionConfig,
  BootstrapToken,
  HostingProvider,
  HostedSwarm,
  HostedSwarmKind,
  SwarmHostingConfig,
  SwarmSandboxPolicy,
} from './types.js';

export class SwarmManager {
  private config: SwarmHostingConfig;
  private instanceUrl: string;
  private providers = new Map<string, HostingProvider>();
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private usedPorts = new Set<number>();
  /** Maps provider instance IDs → hosted swarm DB IDs for exit handler lookup */
  private instanceToHostedId = new Map<string, string>();
  /** Track which instances are being intentionally stopped (to avoid auto-restart) */
  private stoppingInstances = new Set<string>();
  /** Track restart attempts per hosted swarm ID (survives instance ID changes) */
  private restartCounts = new Map<string, number>();
  /** Reverse mapping: hosted swarm DB ID → provider instance ID */
  private hostedToInstanceId = new Map<string, string>();

  // claude-code spawns route through PtyManager (not LocalProvider) because
  // `claude` is an interactive TUI and crashes without a real TTY. The
  // PtyManager instance is provided after construction via setPtyManager()
  // — see server.ts for wiring.
  private ptyManager: PtyManager | null = null;
  private tuiSessions = new Map<string, string>();  // hostedSwarmId → ptySessionId
  private claudeExitHandler: ((event: { sessionId: string; exitCode: number; signal?: number }) => void) | null = null;

  // codex `mode: 'rpc'` spawns route through CodexAppServerManager rather
  // than PtyManager — the underlying process is `codex app-server` (a
  // long-running JSON-RPC server), not a TTY-bound TUI. Same wiring shape
  // as PtyManager: server.ts injects the instance after construction via
  // setCodexAppServerManager() so the dynamic-import gating still works.
  private codexAppServerManager: CodexAppServerManager | null = null;
  private codexRpcSessions = new Map<string, string>();  // hostedSwarmId → codex session id
  private codexRpcExitHandler: ((event: { sessionId: string; exitCode: number | null; signal?: NodeJS.Signals | null }) => void) | null = null;

  constructor(config: SwarmHostingConfig, instanceUrl: string) {
    this.config = config;
    this.instanceUrl = instanceUrl;

    // Initialize local provider with exit handler
    const command = this.resolveOpenswarmCommand(config.openswarm_command);
    const localProvider = new LocalProvider(command, config.logs);
    localProvider.onProcessExit = (instanceId, code, signal) => {
      this.handleProcessExit(instanceId, code, signal);
    };
    this.providers.set('local', localProvider);

    // Initialize sandboxed local provider if sandbox config is present
    if (config.sandbox?.enabled) {
      const sandboxedProvider = new SandboxedLocalProvider(
        command,
        config.sandbox.default_policy,
      );
      sandboxedProvider.onProcessExit = (instanceId, code, signal) => {
        this.handleProcessExit(instanceId, code, signal);
      };
      this.providers.set('local-sandboxed', sandboxedProvider);

      if (sandboxedProvider.isSandboxAvailable()) {
        console.log('[swarm-manager] Sandboxed local provider initialized');
      } else {
        console.warn('[swarm-manager] Sandbox requested but dependencies unavailable — sandboxed spawns will fall back to unsandboxed');
      }
    }
  }

  /**
   * Update the URL baked into newly minted bootstrap tokens. Called by the
   * server after `fastify.listen()` resolves the actual bound port — the
   * SwarmManager is constructed before listen runs, so if the hive was
   * started with `port: 0` (ephemeral) the initial `instanceUrl` is
   * `http://host:0` and poisons every hosted-swarm bootstrap.
   *
   * Safe to call repeatedly; only affects future spawns and revives. Already
   * running hosted swarms keep whatever URL their token was issued against.
   */
  setInstanceUrl(instanceUrl: string): void {
    this.instanceUrl = instanceUrl;
  }

  /**
   * Inject the PtyManager instance used to spawn claude-code TUIs.
   * server.ts calls this after both managers are created and PtyManager has
   * loaded (gated on `swarmHosting.enabled` + node-pty availability).
   *
   * Idempotent: replacing the manager rewires the exit listener to the new
   * instance. Safe to call multiple times during startup or test setup.
   */
  /**
   * Look up the PtyManager session id for a claude-code hosted swarm. The
   * embedded terminal uses this to attach to the running `claude` TUI
   * instead of spawning a fresh PTY. Returns null when there's no live
   * session — either the row isn't claude-code, or the session has exited
   * since we registered it.
   */
  getTuiPtySessionId(hostedSwarmId: string): string | null {
    return this.tuiSessions.get(hostedSwarmId) ?? null;
  }

  setPtyManager(ptyManager: PtyManager): void {
    if (this.ptyManager && this.claudeExitHandler) {
      this.ptyManager.removeListener('session.exit', this.claudeExitHandler);
    }
    this.ptyManager = ptyManager;
    this.claudeExitHandler = (event) => this.handleClaudePtyExit(event);
    ptyManager.on('session.exit', this.claudeExitHandler);
  }

  /**
   * Inject the CodexAppServerManager instance used to drive `codex
   * app-server` for `kind: 'codex'` + `mode: 'rpc'` swarms. Mirrors
   * setPtyManager(). Idempotent — replacing the manager rewires the exit
   * listener.
   */
  setCodexAppServerManager(mgr: CodexAppServerManager): void {
    if (this.codexAppServerManager && this.codexRpcExitHandler) {
      this.codexAppServerManager.removeListener('session.exit', this.codexRpcExitHandler);
    }
    this.codexAppServerManager = mgr;
    this.codexRpcExitHandler = (event) => this.handleCodexRpcExit(event);
    mgr.on('session.exit', this.codexRpcExitHandler);

    // Translate codex's native JSON-RPC notifications to the normalized
    // `HostedChatEvent` shape and fan out per-swarm on
    // `hosted-chat:<hostedId>`. Frontend hooks consume the normalized
    // shape and don't need to know it's codex underneath — adding a new
    // programmatic-mode provider is a translator + the same bridge call.
    mgr.on('notification', (event: { sessionId: string; method: string; params?: unknown }) => {
      const hostedId = this.findHostedIdByCodexSessionId(event.sessionId);
      if (!hostedId) return;
      const normalized = translateCodexNotification(event.method, event.params);
      if (!normalized) return;
      broadcastToChannel(`hosted-chat:${hostedId}`, {
        type: 'hosted-chat.event',
        data: {
          hosted_swarm_id: hostedId,
          provider: 'codex',
          event: normalized,
        },
      });
    });
  }

  /** Reverse lookup: codex session id → hosted swarm id. Linear scan is fine
   *  given the small map size (capped at MAX_SESSIONS in CodexAppServerManager). */
  private findHostedIdByCodexSessionId(codexSid: string): string | null {
    for (const [hostedId, sid] of this.codexRpcSessions) {
      if (sid === codexSid) return hostedId;
    }
    return null;
  }

  /**
   * Look up the CodexAppServerManager session id for a `mode: 'rpc'`
   * codex hosted swarm. The chat bridge and live-e2e tests use this to
   * route turn/start through the right session. Returns null when the
   * row isn't a live codex-rpc session.
   */
  getCodexRpcSessionId(hostedSwarmId: string): string | null {
    return this.codexRpcSessions.get(hostedSwarmId) ?? null;
  }

  /**
   * Submit a user turn against a programmatic-mode (`mode: 'rpc'`) hosted
   * swarm. Auth-gated (only the spawn owner can drive). Dispatches to the
   * underlying provider based on `hosted.kind` — codex today, future
   * providers slot in by adding a branch here. Streaming output arrives as
   * normalized `HostedChatEvent`s on the per-swarm WS channel
   * `hosted-chat:<hostedSwarmId>`.
   */
  async sendChatTurn(
    hostedSwarmId: string,
    agentId: string,
    text: string,
  ): Promise<{ turn_id: string }> {
    const hosted = dal.findHostedSwarmById(hostedSwarmId);
    if (!hosted) throw new SwarmHostingError('NOT_FOUND', 'Hosted swarm not found');
    if (hosted.spawned_by !== agentId) throw new SwarmHostingError('NOT_OWNER', 'You did not spawn this swarm');
    if (hosted.config?.mode !== 'rpc') {
      throw new SwarmHostingError('NOT_IMPLEMENTED', 'Hosted swarm is not in mode=rpc');
    }
    if (hosted.kind === 'codex') {
      if (!this.codexAppServerManager) {
        throw new SwarmHostingError('PROVIDER_NOT_AVAILABLE', 'CodexAppServerManager is not configured');
      }
      const sid = this.codexRpcSessions.get(hostedSwarmId);
      if (!sid) throw new SwarmHostingError('NOT_FOUND', 'No live rpc session for this swarm');
      const ack = await this.codexAppServerManager.sendTurn(sid, text);
      return { turn_id: ack.turn.id };
    }
    throw new SwarmHostingError('NOT_IMPLEMENTED', `kind="${hosted.kind}" has no mode=rpc provider`);
  }

  /**
   * Interrupt the in-flight turn for a programmatic-mode hosted swarm.
   * Clean cancel — the agent stops the current turn but the session
   * stays usable. No-op if there's no active turn.
   */
  async interruptChatTurn(
    hostedSwarmId: string,
    agentId: string,
    turnId: string,
  ): Promise<void> {
    const hosted = dal.findHostedSwarmById(hostedSwarmId);
    if (!hosted) throw new SwarmHostingError('NOT_FOUND', 'Hosted swarm not found');
    if (hosted.spawned_by !== agentId) throw new SwarmHostingError('NOT_OWNER', 'You did not spawn this swarm');
    if (hosted.config?.mode !== 'rpc') {
      throw new SwarmHostingError('NOT_IMPLEMENTED', 'Hosted swarm is not in mode=rpc');
    }
    if (hosted.kind === 'codex') {
      if (!this.codexAppServerManager) {
        throw new SwarmHostingError('PROVIDER_NOT_AVAILABLE', 'CodexAppServerManager is not configured');
      }
      const sid = this.codexRpcSessions.get(hostedSwarmId);
      if (!sid) throw new SwarmHostingError('NOT_FOUND', 'No live rpc session for this swarm');
      await this.codexAppServerManager.interrupt(sid, turnId);
      return;
    }
    throw new SwarmHostingError('NOT_IMPLEMENTED', `kind="${hosted.kind}" has no mode=rpc provider`);
  }

  /**
   * Handle `codex app-server` child exit for codex-rpc rows. Mirrors
   * handleClaudePtyExit() — exit code 0 → `stopped`, anything else →
   * `failed`. Operator-driven stop deletes from `codexRpcSessions` BEFORE
   * destroy(), so the handler returns early on that path.
   */
  private handleCodexRpcExit(event: { sessionId: string; exitCode: number | null; signal?: NodeJS.Signals | null }): void {
    let owningHostedId: string | null = null;
    for (const [hostedId, codexSid] of this.codexRpcSessions) {
      if (codexSid === event.sessionId) { owningHostedId = hostedId; break; }
    }
    if (!owningHostedId) return;

    this.codexRpcSessions.delete(owningHostedId);
    const wasSignalled = event.signal != null;
    const isClean = !wasSignalled && event.exitCode === 0;
    dal.updateHostedSwarm(owningHostedId, {
      state: isClean ? 'stopped' : 'failed',
      error: isClean
        ? null
        : `codex app-server exited with code ${event.exitCode ?? 'null'}${wasSignalled ? ` (signal ${event.signal})` : ''}`,
    });

    broadcastToChannel('map:discovery', {
      type: isClean ? 'swarm_stopped' : 'swarm_offline',
      data: { hosted_swarm_id: owningHostedId },
    });
    console.log(
      `[swarm-manager] codex-rpc session exited: hosted=${owningHostedId} code=${event.exitCode} signal=${event.signal ?? 'none'}`,
    );
  }

  /**
   * Handle PTY exit for claude-code rows. Mirrors handleProcessExit() but
   * for the PtyManager-managed claude TUIs (LocalProvider's exit handler
   * doesn't fire for these). Exit code 0 → 'stopped' (user typed `/exit`
   * or operator stopped); non-zero → 'failed'. Auto-restart is intentionally
   * NOT applied here (interactive TUIs aren't meant to auto-restart).
   *
   * Also signals the cc-swarm sidecar to shut down promptly. cc-swarm
   * would self-terminate after 30 min of inactivity anyway, but that
   * leaves a confusing UX gap where the row says stopped but MAP shows the
   * sidecar registered. SIGTERM hits cc-swarm's existing shutdown handler
   * (closes WS, removes socket/pid files, exits) — see
   * references/claude-code-swarm/scripts/map-sidecar.mjs:142-176.
   */
  private handleClaudePtyExit(event: { sessionId: string; exitCode: number; signal?: number }): void {
    let owningHostedId: string | null = null;
    for (const [hostedId, ptySid] of this.tuiSessions) {
      if (ptySid === event.sessionId) {
        owningHostedId = hostedId;
        break;
      }
    }
    if (!owningHostedId) return;  // not one of our TUI sessions

    this.tuiSessions.delete(owningHostedId);
    // A signal-kill is always a crash, even when node-pty reports exitCode=0
    // (which it does for SIGKILL/SIGSEGV/etc on macOS+Linux — the OS sets the
    // termination signal, not the exit code). Operator-driven stop() routes
    // through stopTuiKind which deletes the session-map entry BEFORE
    // destroy(), so by the time this handler fires on that path, the
    // owningHostedId lookup misses and we returned earlier — no risk of a
    // legitimate stop landing here. Anything reaching this point with a
    // non-zero signal was killed externally.
    const wasSignalled = typeof event.signal === 'number' && event.signal > 0;
    const isClean = !wasSignalled && event.exitCode === 0;
    const hosted = dal.findHostedSwarmById(owningHostedId);
    const kindLabel = hosted?.kind ?? 'tui';
    dal.updateHostedSwarm(owningHostedId, {
      state: isClean ? 'stopped' : 'failed',
      error: isClean
        ? null
        : `${kindLabel} exited with code ${event.exitCode}${wasSignalled ? ` (signal ${event.signal})` : ''}`,
    });

    // Signal any per-kind sidecar (best-effort; missing PID file is fine).
    // Kinds without a sidecar (codex v1) skip — the strategy hides the
    // signal call behind hasSidecar.
    if (hosted) {
      const strategy = this.getTuiStrategy(hosted.kind);
      if (strategy?.hasSidecar) strategy.signalSidecar?.(hosted, 'SIGTERM');
    }

    broadcastToChannel('map:discovery', {
      type: isClean ? 'swarm_stopped' : 'swarm_offline',
      data: { hosted_swarm_id: owningHostedId },
    });
    console.log(
      `[swarm-manager] ${kindLabel} session exited: hosted=${owningHostedId} code=${event.exitCode} signal=${event.signal ?? 'none'}`,
    );
  }

  /**
   * Send a signal to the cc-swarm sidecar process(es) for a claude-code
   * row. cc-swarm writes pid files under (per-session paths.mjs):
   *   <data_dir>/.swarm/claude-swarm/tmp/map/sessions/<hash>/sidecar.pid
   * For long-lived persistent mode it instead uses the legacy single path:
   *   <data_dir>/.swarm/claude-swarm/tmp/map/sidecar.pid
   * We walk both layouts so this works regardless of cc-swarm config.
   * Returns true if at least one signal landed; false otherwise. Tolerates
   * missing files (sidecar already exited) and ESRCH (process already gone).
   * Exposed for testing.
   */
  signalClaudeCodeSidecar(hosted: HostedSwarm, signal: NodeJS.Signals | 0 = 'SIGTERM'): boolean {
    if (hosted.kind !== 'claude-code') return false;
    const dataDirRaw = hosted.config?.data_dir;
    if (!dataDirRaw) return false;
    // dataDir is stored as written by manager.ts (path.join, no resolve), so
    // it can be relative — absolute-ize against the current process cwd
    // (same cwd the spawn ran under).
    const dataDir = path.resolve(dataDirRaw);
    const mapDir = path.join(dataDir, '.swarm', 'claude-swarm', 'tmp', 'map');

    const pidFiles: string[] = [];
    // Legacy/persistent layout: single sidecar.pid at the top level.
    const legacyPid = path.join(mapDir, 'sidecar.pid');
    if (fs.existsSync(legacyPid)) pidFiles.push(legacyPid);
    // Per-session layout: sessions/<hash>/sidecar.pid (current default).
    const sessionsDir = path.join(mapDir, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      try {
        for (const entry of fs.readdirSync(sessionsDir)) {
          const candidate = path.join(sessionsDir, entry, 'sidecar.pid');
          if (fs.existsSync(candidate)) pidFiles.push(candidate);
        }
      } catch {
        // Directory listing failed — keep what we have
      }
    }

    if (pidFiles.length === 0) return false;

    let signalled = false;
    for (const pidPath of pidFiles) {
      let pid: number;
      try {
        const raw = fs.readFileSync(pidPath, 'utf-8').trim();
        pid = parseInt(raw, 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
      } catch {
        continue;
      }
      try {
        process.kill(pid, signal);
        console.log(`[swarm-manager] sidecar signal ${signal} → pid=${pid} hosted=${hosted.id}`);
        signalled = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') continue;  // process already gone — fine
        console.warn(`[swarm-manager] sidecar signal failed: pid=${pid} hosted=${hosted.id}: ${(err as Error).message}`);
      }
    }
    return signalled;
  }

  /**
   * stop() branch for claude-code rows. Destroys the PtyManager session;
   * handleClaudePtyExit observes the exit and updates the row to `stopped`.
   * Returns the row in its final state.
   *
   * Lifecycle subtlety: PtyManager.destroy() sends SIGHUP synchronously and
   * marks its internal state stopped, but the actual process may take a
   * tick (or ignore the signal) before its onExit fires. We mark the row
   * 'stopped' unconditionally after destroy — the user's intent is clear,
   * and the exit handler running later just becomes a no-op (the
   * tuiSessions entry is already gone).
   */
  private async stopTuiKind(hosted: HostedSwarm, strategy: TuiKindStrategy): Promise<HostedSwarm> {
    dal.updateHostedSwarm(hosted.id, { state: 'stopping' });

    const ptySessionId = this.tuiSessions.get(hosted.id);
    if (this.ptyManager && ptySessionId) {
      // Remove from the tracking map BEFORE destroy. If the exit listener
      // fires from destroy(), it'll find no entry and silently no-op.
      // We own the state transition here.
      this.tuiSessions.delete(hosted.id);
      try {
        this.ptyManager.destroy(ptySessionId);
      } catch (err) {
        console.warn(`[swarm-manager] PTY destroy failed for ${hosted.id}: ${(err as Error).message}`);
      }
    }

    // For sidecar-bearing kinds, politely SIGTERM the sidecar so it doesn't
    // linger on its idle timer. Kinds without a sidecar (codex v1) skip.
    if (strategy.hasSidecar) {
      strategy.signalSidecar?.(hosted, 'SIGTERM');
    }

    dal.updateHostedSwarm(hosted.id, { state: 'stopped', error: null });

    // MAP swarm row → offline (preserves swarm_id for any future linkage).
    if (hosted.swarm_id) {
      try {
        mapDal.updateSwarm(hosted.swarm_id, { status: 'offline' });
      } catch {
        /* best-effort */
      }
    }

    this.restartCounts.delete(hosted.id);
    broadcastToChannel('map:discovery', {
      type: 'swarm_stopped',
      data: { hosted_swarm_id: hosted.id },
    });
    return dal.findHostedSwarmById(hosted.id)!;
  }

  /**
   * restart() branch for claude-code rows. Tear down the existing PTY +
   * sidecar, re-mint a fresh onboard token (the previous one's TTL may have
   * lapsed), re-write the prelaunch config, and spawn a new claude PTY
   * against the SAME row (preserves hosted_swarm_id, swarm_id, data_dir).
   *
   * Note: this duplicates the boot phases of spawnClaudeCode rather than
   * extracting a helper. The duplication is bounded (~80 lines) and clearer
   * than threading a "fresh-vs-restart" flag through one method. Refactor
   * to a shared `bootClaudeCodeProcess(hosted)` when the strategy-pattern
   * pass lands (refactor plan §"Approach B preview").
   */
  private async restartTuiKind(hosted: HostedSwarm, strategy: TuiKindStrategy): Promise<HostedSwarm> {
    if (!hosted.swarm_id) {
      throw new SwarmHostingError(
        'RESTART_FAILED',
        `${strategy.kind} row is missing swarm_id; cannot restart in place. Stop and spawn fresh.`,
      );
    }
    if (!hosted.config?.data_dir) {
      throw new SwarmHostingError(
        'RESTART_FAILED',
        `${strategy.kind} row is missing data_dir; cannot restart in place. Stop and spawn fresh.`,
      );
    }
    if (!this.ptyManager) {
      throw new SwarmHostingError(
        'RESTART_NOT_SUPPORTED',
        `PtyManager is not configured. Cannot restart ${strategy.kind} rows without it.`,
      );
    }

    // Resolve the binary BEFORE touching state.
    const tuiBinary = strategy.resolveBinary();
    if (!tuiBinary) {
      throw new SwarmHostingError(
        'RESTART_FAILED',
        `${strategy.kind} binary not found on PATH. Install ${strategy.kind} and retry.`,
      );
    }

    dal.updateHostedSwarm(hosted.id, { state: 'starting', error: null });

    // 1. Tear down the existing PTY (if any) + sidecar (kind-specific).
    const oldPtySid = this.tuiSessions.get(hosted.id);
    if (oldPtySid) {
      this.tuiSessions.delete(hosted.id);
      try { this.ptyManager.destroy(oldPtySid); } catch { /* already gone */ }
    }
    if (strategy.hasSidecar) {
      strategy.signalSidecar?.(hosted, 'SIGTERM');
    }

    // 2. Re-mint the onboard token. Restart may run after the original
    // 24h TTL lapsed, so always rotate.
    let onboardToken: string;
    try {
      const delegated = delegateForSpawn({
        parentAgentId: hosted.spawned_by,
        parentScopes: ['map:*'],
        childAgentId: hosted.swarm_id,
        requestedScopes: ['map:*'],
        ttlMinutes: 24 * 60,
        childDelegatable: true,
      });
      onboardToken = delegated.credentials.token;
    } catch (err) {
      dal.updateHostedSwarm(hosted.id, {
        state: 'failed',
        error: `Failed to mint onboard token: ${(err as Error).message}`,
      });
      throw new SwarmHostingError(
        'ONBOARD_TOKEN_FAILED',
        `Failed to mint onboard token: ${(err as Error).message}`,
      );
    }

    // 3. Re-write per-kind prelaunch files with the rotated token, then
    //    re-trust the workdir.
    const dataDir = path.resolve(hosted.config.data_dir);
    const mapServer = this.instanceUrl.replace(/^http/, 'ws').replace(/\/?$/, '/ws/map');
    fs.mkdirSync(dataDir, { recursive: true });
    strategy.writePrelaunchFiles?.({
      swarmId: hosted.swarm_id,
      hostedSwarmId: hosted.id,
      onboardToken,
      mapServer,
      dataDir,
    });
    strategy.preTrustWorkdir(dataDir, os.homedir());

    // 4. Build env (kind-specific extras + strip).
    const inheritEnv = this.config.credentials?.inherit_env !== false;
    const env: Record<string, string> = {};
    if (inheritEnv) Object.assign(env, process.env as Record<string, string>);
    Object.assign(env, strategy.extraEnv());
    for (const key of strategy.envVarsToStrip()) delete env[key];

    // 5. Spawn the new PTY.
    let ptyInfo;
    try {
      ptyInfo = this.ptyManager.create({
        command: tuiBinary,
        args: [],
        cwd: dataDir,
        env,
        cols: 120,
        rows: 40,
      });
    } catch (err) {
      const msg = (err as Error).message;
      dal.updateHostedSwarm(hosted.id, {
        state: 'failed',
        error: `Restart failed: ${msg}`,
      });
      if (msg.includes('Maximum number of terminal sessions')) {
        throw new SwarmHostingError(
          'MAX_SWARMS_REACHED',
          `Cannot restart ${strategy.kind} — the embedded terminal pool is full.`,
        );
      }
      throw new SwarmHostingError('RESTART_FAILED', `Restart failed: ${msg}`);
    }
    this.tuiSessions.set(hosted.id, ptyInfo.id);
    dal.updateHostedSwarm(hosted.id, { pid: ptyInfo.pid });

    // 6. Bring MAP swarm row back online if it was marked offline by a
    // prior stop. For sidecar-bearing kinds, also wait for the new sidecar
    // to register against our pre-registered swarm_id.
    try {
      mapDal.updateSwarm(hosted.swarm_id, { status: 'online' });
    } catch { /* best-effort */ }

    if (strategy.hasSidecar) {
      const ready = await this.waitForSidecarRegistration(
        hosted.swarm_id,
        strategy.sidecarRegistrationTimeoutMs ?? 60_000,
      );
      if (!ready) {
        this.tuiSessions.delete(hosted.id);
        try { this.ptyManager.destroy(ptyInfo.id); } catch { /* gone */ }
        strategy.signalSidecar?.(hosted, 'SIGTERM');
        dal.updateHostedSwarm(hosted.id, {
          state: 'unhealthy',
          error: `Restart: ${strategy.kind} sidecar did not register within ${(strategy.sidecarRegistrationTimeoutMs ?? 60_000) / 1000}s.`,
        });
        return dal.findHostedSwarmById(hosted.id)!;
      }
    }

    dal.updateHostedSwarm(hosted.id, { state: 'running', error: null });
    broadcastToChannel('map:discovery', {
      type: 'swarm_spawned',
      data: {
        hosted_swarm_id: hosted.id,
        name: hosted.config?.name ?? hosted.id,
        provider: hosted.provider,
        kind: strategy.kind,
        swarm_id: hosted.swarm_id,
      },
    });

    return dal.findHostedSwarmById(hosted.id)!;
  }

  // ==========================================================================
  // codex `mode: 'rpc'` — spawn/stop/restart
  // ==========================================================================
  //
  // Mirrors the spawnTuiKind / stopTuiKind / restartTuiKind shape but routes
  // through CodexAppServerManager instead of PtyManager. The underlying
  // process is `codex app-server` (a JSON-RPC server), and the openhive
  // chat UI drives it via turn/start. The TUI mode is its own separate
  // path (kind=codex + mode=tui → spawnTuiKind with the codex strategy).

  private async spawnCodexRpc(agentId: string, input: SpawnSwarmInput): Promise<HostedSwarm> {
    const name = input.name ?? uniqueNamesGenerator({
      dictionaries: [adjectives, colors, animals],
      separator: '-',
      length: 3,
    });

    // Phase 1: max-swarms validation.
    const activeCount = dal.countActiveHostedSwarms();
    if (activeCount >= this.config.max_swarms) {
      throw new SwarmHostingError(
        'MAX_SWARMS_REACHED',
        `Maximum of ${this.config.max_swarms} hosted swarms reached (${activeCount} active)`,
      );
    }

    const providerType = input.provider ?? this.config.default_provider;
    const provider = this.providers.get(providerType);
    if (!provider) {
      throw new SwarmHostingError('PROVIDER_NOT_AVAILABLE', `Hosting provider "${providerType}" is not configured`);
    }

    if (!this.codexAppServerManager) {
      throw new SwarmHostingError(
        'SPAWN_FAILED',
        'CodexAppServerManager is not configured. SwarmManager.setCodexAppServerManager() must be called during server bootstrap before spawning kind=codex with mode=rpc.',
      );
    }

    // Phase 2: id + data_dir.
    const hostedSwarmId = dal.generateHostedSwarmId();
    const dataDir = path.join(this.config.data_dir, `swarm-${hostedSwarmId}`);

    // Phase 3: hive validation.
    if (input.hive) {
      const { findHiveByName } = await import('../db/dal/hives.js');
      const hive = findHiveByName(input.hive);
      if (!hive) {
        throw new SwarmHostingError('HIVE_NOT_FOUND', `Hive "${input.hive}" not found`);
      }
    }

    // Phase 4: resolve the codex binary BEFORE we touch state.
    const codexBinary = resolveCodexBinary();
    if (!codexBinary) {
      throw new SwarmHostingError(
        'SPAWN_FAILED',
        'codex binary not found on PATH. Install Codex and retry.',
      );
    }

    // Phase 5: MAP pre-registration with a placeholder endpoint. Codex
    // doesn't have an openhive-aware plugin yet, so the placeholder is
    // purely an identity tag — no sidecar will ever dial back. Tagged
    // `internal:cx-rpc:` to distinguish from the TUI codex placeholder.
    let preRegisteredSwarmId: string;
    try {
      const placeholder = `internal:cx-rpc:${hostedSwarmId}`;
      const stale = mapDal.findSwarmByEndpoint(placeholder);
      if (stale) mapDal.deleteSwarm(stale.id);
      const mapResult = registerSwarm(agentId, {
        name,
        description: input.description,
        map_endpoint: placeholder,
        map_transport: 'websocket',
        capabilities: { observation: true, messaging: true, lifecycle: true },
        metadata: {
          ...(input.metadata ?? {}),
          hosted: true,
          hosted_swarm_id: hostedSwarmId,
          provider: providerType,
          kind: 'codex',
          mode: 'rpc',
        },
      });
      preRegisteredSwarmId = mapResult.swarm.id;
      console.log(`[swarm-manager] Pre-registered codex-rpc swarm with stable ID: ${preRegisteredSwarmId}`);
    } catch (err) {
      throw new SwarmHostingError(
        'SPAWN_FAILED',
        `MAP pre-registration failed: ${(err as Error).message}`,
      );
    }

    // Phase 6: build provision config. We don't mint an onboard token —
    // codex's app-server doesn't dial back to openhive (no sidecar in v1).
    // Mode goes on the config so restart and revive can branch correctly.
    const inheritEnv = this.config.credentials?.inherit_env !== false;
    const credentialOverlay = resolveCredentialOverlay(
      this.config.credentials,
      input.hive,
      input.credential_overrides,
    );

    const provisionConfig: SwarmProvisionConfig = {
      name,
      adapter: 'codex',
      adapter_config: input.adapter_config,
      bootstrap_token: '',
      assigned_port: 0,
      data_dir: dataDir,
      resolved_credentials: credentialOverlay,
      inherit_env: inheritEnv,
      workspace: input.workspace,
      bootstrap: input.bootstrap,
      spawn_command_override: codexBinary,
      spawn_args_override: ['app-server', '--listen', 'ws://127.0.0.1:0'],
      mode: 'rpc',
    };

    // Phase 7: persist the row.
    const hosted = dal.createHostedSwarm({
      id: hostedSwarmId,
      kind: 'codex',
      provider: providerType,
      assigned_port: undefined,
      bootstrap_token_hash: undefined,
      config: provisionConfig,
      spawned_by: agentId,
    });
    dal.updateHostedSwarm(hosted.id, { state: 'starting', swarm_id: preRegisteredSwarmId });

    try {
      // Phase 8: clone any workspace repos FIRST (same constraint as TUI
      // path — git clone needs an empty target).
      fs.mkdirSync(dataDir, { recursive: true });
      if (input.workspace) {
        try {
          await cloneWorkspaceRepos(input.workspace, dataDir, process.env as Record<string, string>);
        } catch (err) {
          throw new SwarmHostingError(
            'WORKSPACE_SETUP_FAILED',
            `Workspace clone failed: ${(err as Error).message}`,
          );
        }
      }

      // Phase 9: pre-trust the data_dir so codex doesn't gate on the
      // "Trust this folder?" prompt the first time it loads. (Even though
      // the app-server doesn't render that prompt, codex shares the trust
      // check with its TUI; keeping this consistent prevents surprises if
      // we ever spawn `codex resume` for the same data_dir.)
      preTrustCodexWorkdir(dataDir, os.homedir());

      // Phase 10: build env (mirror TUI hygiene minus the CLAUDE markers).
      const env: Record<string, string> = {};
      if (inheritEnv) Object.assign(env, process.env as Record<string, string>);
      if (credentialOverlay) Object.assign(env, credentialOverlay);
      delete env.CODEX_SESSION_ID;
      delete env.CODEX_THREAD_ID;
      delete env.CODEX_ENTRYPOINT;

      // Phase 11: spawn the app-server, drive initialize → thread/start,
      // optionally fire the initial prompt as the first turn.
      let session;
      try {
        session = await this.codexAppServerManager.create({
          command: codexBinary,
          cwd: dataDir,
          env,
          initialPrompt: input.initial_prompt,
        });
      } catch (err) {
        throw new SwarmHostingError(
          'SPAWN_FAILED',
          `codex-rpc spawn failed: ${(err as Error).message}`,
        );
      }
      this.codexRpcSessions.set(hosted.id, session.id);
      dal.updateHostedSwarm(hosted.id, { pid: session.pid, state: 'running', error: null });

      // Phase 12: broadcast.
      broadcastToChannel('map:discovery', {
        type: 'swarm_spawned',
        data: {
          hosted_swarm_id: hosted.id,
          name,
          provider: providerType,
          kind: 'codex',
          mode: 'rpc',
          swarm_id: preRegisteredSwarmId,
        },
      });

      return dal.findHostedSwarmById(hosted.id)!;
    } catch (err) {
      dal.updateHostedSwarm(hosted.id, {
        state: 'failed',
        error: `codex-rpc spawn failed: ${(err as Error).message}`,
      });
      throw err instanceof SwarmHostingError
        ? err
        : new SwarmHostingError('SPAWN_FAILED', `codex-rpc spawn failed: ${(err as Error).message}`);
    }
  }

  private async stopCodexRpc(hosted: HostedSwarm): Promise<HostedSwarm> {
    dal.updateHostedSwarm(hosted.id, { state: 'stopping' });

    const codexSid = this.codexRpcSessions.get(hosted.id);
    if (this.codexAppServerManager && codexSid) {
      // Remove from the tracking map BEFORE destroy. If the exit listener
      // fires from destroy(), it'll find no entry and silently no-op.
      this.codexRpcSessions.delete(hosted.id);
      try {
        this.codexAppServerManager.destroy(codexSid);
      } catch (err) {
        console.warn(`[swarm-manager] codex-rpc destroy failed for ${hosted.id}: ${(err as Error).message}`);
      }
    }

    dal.updateHostedSwarm(hosted.id, { state: 'stopped', error: null });
    if (hosted.swarm_id) {
      try { mapDal.updateSwarm(hosted.swarm_id, { status: 'offline' }); } catch { /* best-effort */ }
    }
    this.restartCounts.delete(hosted.id);
    broadcastToChannel('map:discovery', {
      type: 'swarm_stopped',
      data: { hosted_swarm_id: hosted.id },
    });
    return dal.findHostedSwarmById(hosted.id)!;
  }

  private async restartCodexRpc(hosted: HostedSwarm): Promise<HostedSwarm> {
    if (!hosted.swarm_id) {
      throw new SwarmHostingError('RESTART_FAILED', 'codex-rpc row is missing swarm_id; stop and spawn fresh.');
    }
    if (!hosted.config?.data_dir) {
      throw new SwarmHostingError('RESTART_FAILED', 'codex-rpc row is missing data_dir; stop and spawn fresh.');
    }
    if (!this.codexAppServerManager) {
      throw new SwarmHostingError('RESTART_NOT_SUPPORTED', 'CodexAppServerManager is not configured.');
    }

    const codexBinary = resolveCodexBinary();
    if (!codexBinary) {
      throw new SwarmHostingError('RESTART_FAILED', 'codex binary not found on PATH. Install Codex and retry.');
    }

    dal.updateHostedSwarm(hosted.id, { state: 'starting', error: null });

    // 1. Tear down the existing session.
    const oldSid = this.codexRpcSessions.get(hosted.id);
    if (oldSid) {
      this.codexRpcSessions.delete(hosted.id);
      try { this.codexAppServerManager.destroy(oldSid); } catch { /* already gone */ }
    }

    const dataDir = path.resolve(hosted.config.data_dir);
    fs.mkdirSync(dataDir, { recursive: true });
    preTrustCodexWorkdir(dataDir, os.homedir());

    // 2. Build env (same hygiene as spawn).
    const inheritEnv = this.config.credentials?.inherit_env !== false;
    const env: Record<string, string> = {};
    if (inheritEnv) Object.assign(env, process.env as Record<string, string>);
    delete env.CODEX_SESSION_ID;
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_ENTRYPOINT;

    // 3. Spawn a fresh session. Restart starts a NEW thread — codex
    // app-server doesn't expose live-thread takeover across processes
    // (proven by the resume probe), so each restart is a clean start.
    let session;
    try {
      session = await this.codexAppServerManager.create({
        command: codexBinary,
        cwd: dataDir,
        env,
      });
    } catch (err) {
      const msg = (err as Error).message;
      dal.updateHostedSwarm(hosted.id, { state: 'failed', error: `Restart failed: ${msg}` });
      throw new SwarmHostingError('RESTART_FAILED', `Restart failed: ${msg}`);
    }
    this.codexRpcSessions.set(hosted.id, session.id);
    dal.updateHostedSwarm(hosted.id, { pid: session.pid, state: 'running', error: null });

    try { mapDal.updateSwarm(hosted.swarm_id, { status: 'online' }); } catch { /* best-effort */ }

    broadcastToChannel('map:discovery', {
      type: 'swarm_spawned',
      data: {
        hosted_swarm_id: hosted.id,
        name: hosted.config?.name ?? hosted.id,
        provider: hosted.provider,
        kind: 'codex',
        mode: 'rpc',
        swarm_id: hosted.swarm_id,
      },
    });

    return dal.findHostedSwarmById(hosted.id)!;
  }

  /**
   * Resolve the openswarm command to an executable form.
   *
   * We resolve the openswarm bin entry directly to avoid the npx indirection,
   * which can cause pid tracking issues (npx spawns a child node process,
   * then exits, making us think the server stopped).
   *
   * Resolution order:
   * 1. dist/server.mjs exists → run bin directly with node (production)
   * 2. src/hosting/index.ts exists → run with tsx (development)
   * 3. Fall back to configured command as-is
   */
  private resolveOpenswarmCommand(configured: string): string {
    if (configured !== 'npx openswarm serve') {
      return configured;
    }

    try {
      const require_ = createRequire(import.meta.url);
      const pkgPath = require_.resolve('openswarm/package.json');
      const pkgDir = path.dirname(pkgPath);
      const binEntry = path.join(pkgDir, 'bin', 'openswarm.mjs');

      // Production: dist/server.mjs exists, run the bin entry directly with node
      const serverBundle = path.join(pkgDir, 'dist', 'server.mjs');
      if (fs.existsSync(serverBundle) && fs.existsSync(binEntry)) {
        const resolved = `node ${binEntry} serve`;
        console.log(`[swarm-manager] Resolved openswarm command: ${resolved}`);
        return resolved;
      }

      // Development: no bundle, run TypeScript source via tsx
      const hostingEntry = path.join(pkgDir, 'src', 'hosting', 'index.ts');
      const tsxBin = path.join(pkgDir, '..', '.bin', 'tsx');
      if (fs.existsSync(hostingEntry) && fs.existsSync(tsxBin)) {
        const resolved = `${tsxBin} ${hostingEntry}`;
        console.log(`[swarm-manager] Server bundle not found, using tsx: ${resolved}`);
        return resolved;
      }

      console.warn('[swarm-manager] Could not resolve openswarm package');
      return configured;
    } catch {
      console.warn('[swarm-manager] Could not resolve openswarm package, using: ' + configured);
      return configured;
    }
  }

  // ==========================================================================
  // Spawn
  // ==========================================================================

  /**
   * Spawn a new OpenSwarm instance.
   *
   * Flow:
   * 1. Validate limits (max swarms, port availability)
   * 2. Allocate a port
   * 3. Generate a bootstrap token with a pre-auth key
   * 4. Create a hosted_swarms DB record
   * 5. Call the hosting provider to provision the instance
   * 6. Wait for health, then register in the MAP hub
   * 7. Update the DB record with the swarm_id
   */
  /**
   * Public entry point. Dispatches to the per-kind spawn pipeline. Existing
   * callers that don't pass kind get the openswarm pipeline (preserves the
   * pre-V50 contract). See docs/HOSTED_SWARM_KINDS_DESIGN.md.
   */
  async spawn(agentId: string, input: SpawnSwarmInput): Promise<HostedSwarm> {
    const kind = input.kind ?? 'openswarm';

    // codex has two modes; the dispatcher branches BEFORE the TUI strategy
    // lookup so `mode: 'rpc'` doesn't accidentally fall through to the TUI
    // path. Default for codex is 'rpc' (chat-driven). 'tui' is opt-in.
    if (kind === 'codex') {
      const mode = input.mode ?? 'rpc';
      if (mode === 'rpc') return this.spawnCodexRpc(agentId, input);
      // mode === 'tui' falls through to the shared TUI pipeline below.
    }

    if (isTuiKind(kind)) {
      const strategy = this.getTuiStrategy(kind);
      if (!strategy) {
        throw new SwarmHostingError('NOT_IMPLEMENTED', `Unsupported TUI kind: ${kind}`);
      }
      return this.spawnTuiKind(agentId, input, strategy);
    }
    return this.spawnOpenswarm(agentId, input);
  }

  /**
   * Look up the per-kind strategy and bind any manager-owned helpers it
   * needs (e.g. signalClaudeCodeSidecar). Returns null if the kind isn't
   * TUI-shaped.
   */
  private getTuiStrategy(kind: HostedSwarmKind): TuiKindStrategy | null {
    return getTuiKindStrategy(kind, {
      signalSidecar: (hosted, signal) => this.signalClaudeCodeSidecar(hosted, signal),
    });
  }

  /**
   * claude-code kind: spawn the `claude` TUI. cc-swarm is a Claude Code
   * plugin (must be installed on the host); its `SessionStart` hook reads
   * the prelaunch `.swarm/claude-swarm/config.json` we write into the
   * swarm's data_dir, detaches the MAP sidecar internally, and the sidecar
   * registers with the openhive hub. We wait for that registration to
   * flip the row to `running`.
   *
   * Differences from spawnOpenswarm:
   *   - No port allocation (claude binds nothing)
   *   - Slim onboard token (no BootstrapToken envelope; cc-swarm reads
   *     `map.auth.credential` from the prelaunch config directly)
   *   - Placeholder endpoint `internal:cc:<hostedSwarmId>` since there's
   *     no inbound MAP server URL on this swarm
   *   - Wait pattern is `getInbound(swarmId)` rather than HTTP `/health`
   *
   * See docs/HOSTED_SWARM_KINDS_DESIGN.md and the milestone-A plan for the
   * design rationale.
   */
  private async spawnTuiKind(
    agentId: string,
    input: SpawnSwarmInput,
    strategy: TuiKindStrategy,
  ): Promise<HostedSwarm> {
    const name = input.name ?? uniqueNamesGenerator({
      dictionaries: [adjectives, colors, animals],
      separator: '-',
      length: 3,
    });

    // Phase 1: max-swarms validation (shared semantics with openswarm path).
    const activeCount = dal.countActiveHostedSwarms();
    if (activeCount >= this.config.max_swarms) {
      throw new SwarmHostingError(
        'MAX_SWARMS_REACHED',
        `Maximum of ${this.config.max_swarms} hosted swarms reached (${activeCount} active)`,
      );
    }

    const providerType = input.provider ?? this.config.default_provider;
    const provider = this.providers.get(providerType);
    if (!provider) {
      throw new SwarmHostingError('PROVIDER_NOT_AVAILABLE', `Hosting provider "${providerType}" is not configured`);
    }

    // Phase 2: skip port allocation — TUI kinds don't bind a server.

    // Phase 3: id + data_dir.
    const hostedSwarmId = dal.generateHostedSwarmId();
    const dataDir = path.join(this.config.data_dir, `swarm-${hostedSwarmId}`);

    // Phase 4: hive validation.
    if (input.hive) {
      const { findHiveByName } = await import('../db/dal/hives.js');
      const hive = findHiveByName(input.hive);
      if (!hive) {
        throw new SwarmHostingError('HIVE_NOT_FOUND', `Hive "${input.hive}" not found`);
      }
    }

    // Phase 5: injected resources NOT YET SUPPORTED for TUI kinds in v1.
    if (input.inject_resources && input.inject_resources.length > 0) {
      console.warn(
        `[swarm-manager] inject_resources is not yet supported for kind=${strategy.kind} (ignoring)`,
      );
    }

    // Phase 6: resolve the binary BEFORE we touch state, so a missing
    // binary fails fast with a clear error rather than after a half-spawned
    // row exists.
    const tuiBinary = strategy.resolveBinary();
    if (!tuiBinary) {
      throw new SwarmHostingError(
        'SPAWN_FAILED',
        `${strategy.kind} binary not found on PATH. Install ${strategy.kind} and retry.`,
      );
    }

    // Phase 7: MAP pre-registration. We use a placeholder endpoint —
    // there's no inbound MAP server on this swarm; the sidecar (if any)
    // dials OUT to openhive's hub. The endpoint is just a stable identity
    // tag for the registry.
    let preRegisteredSwarmId: string;
    try {
      const placeholder = strategy.placeholderEndpoint(hostedSwarmId);
      const stale = mapDal.findSwarmByEndpoint(placeholder);
      if (stale) mapDal.deleteSwarm(stale.id);
      const mapResult = registerSwarm(agentId, {
        name,
        description: input.description,
        map_endpoint: placeholder,
        map_transport: 'websocket',
        capabilities: {
          observation: true,
          messaging: true,
          lifecycle: true,
        },
        metadata: {
          ...(input.metadata ?? {}),
          hosted: true,
          hosted_swarm_id: hostedSwarmId,
          provider: providerType,
          kind: strategy.kind,
        },
      });
      preRegisteredSwarmId = mapResult.swarm.id;
      console.log(`[swarm-manager] Pre-registered ${strategy.kind} swarm with stable ID: ${preRegisteredSwarmId}`);
    } catch (err) {
      throw new SwarmHostingError(
        'SPAWN_FAILED',
        `MAP pre-registration failed: ${(err as Error).message}`,
      );
    }

    // Phase 8: mint slim onboard token. Used by sidecar-based kinds to
    // auth their dial-back; kinds without a sidecar (codex v1) just hold
    // the credential as a no-op.
    let onboardToken: string;
    try {
      const delegated = delegateForSpawn({
        parentAgentId: agentId,
        parentScopes: ['map:*'],
        childAgentId: preRegisteredSwarmId,
        requestedScopes: ['map:*'],
        ttlMinutes: 24 * 60,
        childDelegatable: true,
      });
      onboardToken = delegated.credentials.token;
    } catch (err) {
      throw new SwarmHostingError(
        'ONBOARD_TOKEN_FAILED',
        `Failed to mint onboard token: ${(err as Error).message}`,
      );
    }

    const mapServer = this.instanceUrl.replace(/^http/, 'ws').replace(/\/?$/, '/ws/map');

    // Phase 10: build provision config. Most fields are openswarm-meaningful
    // and have no analog for TUI kinds; we set them to defensible empties.
    const inheritEnv = this.config.credentials?.inherit_env !== false;
    const credentialOverlay = resolveCredentialOverlay(
      this.config.credentials,
      input.hive,
      input.credential_overrides,
    );

    // Phase 10b: resolve repo_id → WORKSPACE_* env vars + clone target.
    // Same contract as the openswarm path (shared helper) but here the
    // provider owns the clone — the TUI process starts IN the repo dir.
    let repoCloneTarget: { url: string; branch: string; localPath: string; existsLocally: boolean } | undefined;
    if (input.repo_id) {
      try {
        const resolved = resolveRepoForSpawn(input.repo_id, dataDir);
        applyRepoEnvVars(credentialOverlay, resolved);
        repoCloneTarget = resolved;
      } catch (err) {
        if (err instanceof RepoResolutionError) {
          throw new SwarmHostingError('REPO_NOT_FOUND', err.message);
        }
        throw err;
      }
    }

    const provisionConfig: SwarmProvisionConfig = {
      name,
      adapter: strategy.adapterLabel(),
      adapter_config: input.adapter_config,
      bootstrap_token: '',
      assigned_port: 0,
      data_dir: dataDir,
      resolved_credentials: credentialOverlay,
      inherit_env: inheritEnv,
      workspace: input.workspace,
      bootstrap: input.bootstrap,
      spawn_command_override: tuiBinary,
      spawn_args_override: [],
      ...(input.repo_id !== undefined && { repo_id: input.repo_id }),
    };

    // Phase 11: persist the row (now that all preconditions have passed).
    const hosted = dal.createHostedSwarm({
      id: hostedSwarmId,
      kind: strategy.kind,
      provider: providerType,
      assigned_port: undefined,
      bootstrap_token_hash: createHash('sha256').update(onboardToken).digest('hex'),
      config: provisionConfig,
      spawned_by: agentId,
    });

    dal.updateHostedSwarm(hosted.id, { state: 'starting', swarm_id: preRegisteredSwarmId });

    try {
      // Phase 12: clone any workspace repos FIRST. `git clone <url> <dir>`
      // requires the target directory to be empty, so we do this before
      // any prelaunch-file writes that would create entries under data_dir.
      fs.mkdirSync(dataDir, { recursive: true });
      if (input.workspace) {
        try {
          await cloneWorkspaceRepos(input.workspace, dataDir, process.env as Record<string, string>);
        } catch (err) {
          throw new SwarmHostingError(
            'WORKSPACE_SETUP_FAILED',
            `Workspace clone failed: ${(err as Error).message}`,
          );
        }
      }

      // Phase 12b: repo_id mount-or-clone. If the resolved path already
      // exists on disk (local checkout or prior clone), skip cloning and
      // just mount it as the working directory. Otherwise clone fresh.
      if (repoCloneTarget && !repoCloneTarget.existsLocally) {
        try {
          await cloneWorkspaceRepos(
            { repos: [{ url: repoCloneTarget.url, branch: repoCloneTarget.branch, path: 'repo' }] },
            dataDir,
            process.env as Record<string, string>,
          );
        } catch (err) {
          throw new SwarmHostingError(
            'WORKSPACE_SETUP_FAILED',
            `Repo clone failed for ${input.repo_id}: ${(err as Error).message}`,
          );
        }
      }

      // Phase 13: per-kind prelaunch files (e.g. cc-swarm config).
      // Written to dataDir (canonical location) AND repo cwd (if different)
      // so the sidecar finds its config regardless of working directory.
      strategy.writePrelaunchFiles?.({
        swarmId: preRegisteredSwarmId,
        hostedSwarmId,
        onboardToken,
        mapServer,
        dataDir,
      });
      if (repoCloneTarget && repoCloneTarget.localPath !== dataDir) {
        strategy.writePrelaunchFiles?.({
          swarmId: preRegisteredSwarmId,
          hostedSwarmId,
          onboardToken,
          mapServer,
          dataDir: repoCloneTarget.localPath,
        });
      }

      // Phase 14: pre-trust the working directory in the TUI's user config
      // so the "Trust this folder?" gate doesn't block first-launch hooks.
      // When a repo was cloned, trust both dataDir (prelaunch files) and the
      // repo clone path (actual cwd). Best-effort: missing/invalid user
      // config just means the user gets the prompt and dismisses it manually.
      strategy.preTrustWorkdir(dataDir, os.homedir());
      if (repoCloneTarget) {
        strategy.preTrustWorkdir(repoCloneTarget.localPath, os.homedir());
      }

      // Phase 15: spawn the TUI via PtyManager. Both kinds are interactive
      // TUIs that need a real TTY (would crash under child_process.spawn).
      if (!this.ptyManager) {
        throw new SwarmHostingError(
          'SPAWN_FAILED',
          `PtyManager is not configured. SwarmManager.setPtyManager() must be called during server bootstrap before spawning kind=${strategy.kind}.`,
        );
      }

      // Build the env: inherit operator env, layer credentials, apply per-
      // kind extras, then strip self-detection markers so a TUI launched
      // from inside another TUI session of the same kind doesn't refuse.
      const env: Record<string, string> = {};
      if (inheritEnv) Object.assign(env, process.env as Record<string, string>);
      if (credentialOverlay) Object.assign(env, credentialOverlay);
      Object.assign(env, strategy.extraEnv());
      for (const key of strategy.envVarsToStrip()) delete env[key];

      // Both `claude` and `codex` accept an initial prompt as the first
      // positional arg, opening their TUI with it prefilled. Empty/unset
      // → no positional, the TUI opens at an empty prompt input.
      const ptyArgs: string[] = [];
      if (input.initial_prompt && input.initial_prompt.trim().length > 0) {
        ptyArgs.push(input.initial_prompt);
      }

      let ptyInfo;
      try {
        ptyInfo = this.ptyManager.create({
          command: tuiBinary,
          args: ptyArgs,
          cwd: repoCloneTarget ? repoCloneTarget.localPath : dataDir,
          env,
          cols: 120,
          rows: 40,
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('Maximum number of terminal sessions')) {
          throw new SwarmHostingError(
            'MAX_SWARMS_REACHED',
            `Cannot spawn ${strategy.kind} — the embedded terminal pool is full. Close some terminal tabs or stop other TUI swarms and try again.`,
          );
        }
        throw err;
      }
      this.tuiSessions.set(hosted.id, ptyInfo.id);

      dal.updateHostedSwarm(hosted.id, { pid: ptyInfo.pid });

      // Phase 16: per-kind readiness wait. Kinds with a sidecar (claude-code)
      // wait for the sidecar's MAP registration; kinds without (codex v1)
      // are ready as soon as the PTY is up. Future codex-swarm plugin will
      // flip codex to hasSidecar=true at no architectural cost.
      if (strategy.hasSidecar) {
        const ready = await this.waitForSidecarRegistration(
          preRegisteredSwarmId,
          strategy.sidecarRegistrationTimeoutMs ?? 60_000,
        );
        if (!ready) {
          this.tuiSessions.delete(hosted.id);
          try { this.ptyManager.destroy(ptyInfo.id); } catch { /* already gone */ }
          strategy.signalSidecar?.(hosted, 'SIGTERM');
          dal.updateHostedSwarm(hosted.id, {
            state: 'unhealthy',
            error: `${strategy.kind} sidecar did not register within ${(strategy.sidecarRegistrationTimeoutMs ?? 60_000) / 1000}s.`,
          });
          console.warn(`[swarm-manager] ${strategy.kind} swarm ${hosted.id} sidecar registration timed out`);
          return dal.findHostedSwarmById(hosted.id)!;
        }
      }

      dal.updateHostedSwarm(hosted.id, { state: 'running', error: null });

      // Phase 17: broadcast (same shape openswarm uses).
      broadcastToChannel('map:discovery', {
        type: 'swarm_spawned',
        data: {
          hosted_swarm_id: hosted.id,
          name,
          provider: providerType,
          kind: strategy.kind,
          swarm_id: preRegisteredSwarmId,
        },
      });

      return dal.findHostedSwarmById(hosted.id)!;
    } catch (err) {
      dal.updateHostedSwarm(hosted.id, {
        state: 'failed',
        error: `${strategy.kind} spawn failed: ${(err as Error).message}`,
      });
      throw new SwarmHostingError(
        'SPAWN_FAILED',
        `${strategy.kind} spawn failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Polls the inbound connection registry for the cc-swarm sidecar's
   * registration against the pre-registered swarm id. Returns true when
   * the sidecar shows up; false on timeout. Polling rather than event-
   * driven because the registration path is several layers deep
   * (WS upgrade → MAP server → connection-registry) and an event hook
   * would be its own refactor — for v1 a 250ms poll with a 15s deadline
   * is fine.
   */
  private async waitForSidecarRegistration(swarmId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (getInbound(swarmId)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /**
   * openswarm kind (existing behavior, unchanged). Was named `spawn()` before
   * the kind-dispatcher was added; renamed for clarity. All openswarm-specific
   * logic — bootstrap-token envelopes, port allocation, MAP pre-registration
   * with `ws://127.0.0.1:<port>` shape — lives here.
   */
  private async spawnOpenswarm(agentId: string, input: SpawnSwarmInput): Promise<HostedSwarm> {
    // Generate a name if none provided
    const name = input.name ?? uniqueNamesGenerator({
      dictionaries: [adjectives, colors, animals],
      separator: '-',
      length: 3,
    });

    // Check limits
    const activeCount = dal.countActiveHostedSwarms();
    if (activeCount >= this.config.max_swarms) {
      throw new SwarmHostingError(
        'MAX_SWARMS_REACHED',
        `Maximum of ${this.config.max_swarms} hosted swarms reached (${activeCount} active)`
      );
    }

    const providerType = input.provider ?? this.config.default_provider;
    const provider = this.providers.get(providerType);
    if (!provider) {
      throw new SwarmHostingError('PROVIDER_NOT_AVAILABLE', `Hosting provider "${providerType}" is not configured`);
    }

    // Generate bootstrap token
    const adapter = input.adapter ?? 'macro-agent';

    // Allocate port(s) — adapters like macro-agent need several consecutive
    // ports (see getPortStride). allocatePorts probes the OS to avoid collisions
    // with stale processes or previously assigned adjacent ports.
    const port = await this.allocatePorts(adapter);
    if (!port) {
      throw new SwarmHostingError(
        'NO_PORTS_AVAILABLE',
        `No ports available in range ${this.config.port_range[0]}-${this.config.port_range[1]}`
      );
    }

    // Pre-generate the hosted-swarm id so we can key data_dir on it.
    // Prior scheme (`swarm-${port}`) drifts the moment a revive picks a
    // different port, so two distinct swarms could end up competing for
    // the same on-disk directory after a port swap. Using the id keeps
    // the data path stable for the lifetime of the row, regardless of
    // port churn.
    const hostedSwarmId = dal.generateHostedSwarmId();
    const dataDir = path.join(this.config.data_dir, `swarm-${hostedSwarmId}`);

    // Validate the hive exists (used by MAP hive-membership plumbing but
    // no longer associated with a preauth key under v4).
    if (input.hive) {
      const { findHiveByName } = await import('../db/dal/hives.js');
      const hive = findHiveByName(input.hive);
      if (!hive) {
        this.releasePorts(port, adapter);
        throw new SwarmHostingError('HIVE_NOT_FOUND', `Hive "${input.hive}" not found`);
      }
    }

    // Resolve injected resources
    let injectedResources: BootstrapToken['resources'];
    if (input.inject_resources && input.inject_resources.length > 0) {
      injectedResources = [];
      for (const resourceId of input.inject_resources) {
        const resource = findResourceById(resourceId);
        if (!resource) continue;
        injectedResources.push({
          id: resource.id,
          resource_type: resource.resource_type,
          name: resource.name,
          git_remote_url: resource.git_remote_url,
          metadata: resource.metadata,
        });
        // Auto-subscribe the spawning agent to the resource
        try {
          subscribeToResource(agentId, resource.id, 'read');
        } catch {
          // Already subscribed or other constraint — ignore
        }
      }
    }

    // Pre-register swarm in MAP hub so we can pass a stable swarm_id
    // to the spawned process. This ensures the sidecar connects with
    // ?swarm_id= and identity is stable across reconnections.
    let preRegisteredSwarmId: string | undefined;
    try {
      const endpoint = `ws://127.0.0.1:${port}`;
      const staleSwarm = mapDal.findSwarmByEndpoint(endpoint);
      if (staleSwarm) {
        mapDal.deleteSwarm(staleSwarm.id);
      }

      const mapResult = registerSwarm(agentId, {
        name,
        description: input.description,
        map_endpoint: endpoint,
        map_transport: 'websocket',
        capabilities: {
          observation: true,
          messaging: true,
          lifecycle: true,
        },
        metadata: {
          ...(input.metadata ?? {}),
          hosted: true,
          provider: providerType,
        },
      });
      preRegisteredSwarmId = mapResult.swarm.id;
      console.log(`[swarm-manager] Pre-registered swarm with stable ID: ${preRegisteredSwarmId}`);
    } catch (err) {
      // Pre-registration is best-effort — sidecar will still auto-register
      console.warn(`[swarm-manager] Pre-registration failed (sidecar will auto-register): ${(err as Error).message}`);
    }

    // Mint a delegated agent-iam token for the spawned swarm subprocess.
    // Replaces the retired preauth-key bootstrap (see RFC v4). The token
    // is the subprocess's Bearer credential for all hub communication.
    let onboardToken: string;
    try {
      const delegated = delegateForSpawn({
        parentAgentId: agentId,
        parentScopes: ['map:*'], // hub-spawned swarms get full scope for now
        childAgentId: preRegisteredSwarmId ?? hostedSwarmId,
        requestedScopes: ['map:*'],
        // Max delegated TTL (24h). Hosted swarms are typically long-
        // lived and have no token-refresh path today (see RFC v4
        // §"Limitations"); shorter TTLs break them within the
        // session. Operators wanting stricter lifetimes should mint
        // via `admin onboard-token --ttl-hours=<n>` out of band.
        ttlMinutes: 24 * 60,
        childDelegatable: true,
      });
      onboardToken = delegated.credentials.token;
    } catch (err) {
      this.releasePorts(port, adapter);
      throw new SwarmHostingError(
        'ONBOARD_TOKEN_FAILED',
        `Failed to mint onboard token: ${(err as Error).message}`,
      );
    }

    const bootstrapToken: BootstrapToken = {
      version: 1,
      openhive_url: this.instanceUrl,
      onboard_token: onboardToken,
      swarm_name: name,
      swarm_id: preRegisteredSwarmId,
      adapter,
      adapter_config: input.adapter_config,
      metadata: input.metadata,
      resources: injectedResources,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
    };

    const tokenString = Buffer.from(JSON.stringify(bootstrapToken)).toString('base64');
    const tokenHash = createHash('sha256').update(tokenString).digest('hex');

    // Resolve credentials for this swarm
    const inheritEnv = this.config.credentials?.inherit_env !== false;
    const credentialOverlay = resolveCredentialOverlay(
      this.config.credentials,
      input.hive,
      input.credential_overrides,
    );

    // Inject WORKSPACE_* env vars when a repo_id is supplied. The spawned
    // swarm's sidecar reads these on connect and emits `x-workspace/repo.declare`
    // — see `references/agent-workspace/docs/design/agent-integration.md`.
    if (input.repo_id) {
      try {
        const resolved = resolveRepoForSpawn(input.repo_id, dataDir);
        applyRepoEnvVars(credentialOverlay, resolved);
      } catch (err) {
        this.releasePorts(port, adapter);
        if (err instanceof RepoResolutionError) {
          throw new SwarmHostingError('REPO_NOT_FOUND', err.message);
        }
        throw err;
      }
    }

    // Persist per-swarm workspace policy on the pre-registered map_swarms row.
    // Runtime declares are gated against this in workspace-handler.ts (when
    // policy gating ships in slice 7+). For now this surfaces the policy via
    // GET /api/v1/map/swarms/:id and is auditable.
    if (input.workspace_policy && preRegisteredSwarmId) {
      try {
        getDatabase().prepare(
          'UPDATE map_swarms SET workspace_policy = ? WHERE id = ?',
        ).run(JSON.stringify(input.workspace_policy), preRegisteredSwarmId);
      } catch (err) {
        // Fail loud, like `repo_id` does. An operator who explicitly asked
        // for a policy at spawn-time deserves to know if persistence
        // failed — silently continuing means the swarm runs with no
        // enforcement when the operator believed it had one.
        throw new SwarmHostingError(
          'WORKSPACE_POLICY_PERSIST_FAILED',
          `Failed to persist workspace_policy: ${(err as Error).message}`,
        );
      }
    }

    const provisionConfig: SwarmProvisionConfig = {
      name,
      adapter,
      adapter_config: input.adapter_config,
      bootstrap_token: tokenString,
      assigned_port: port,
      data_dir: dataDir,
      resolved_credentials: Object.keys(credentialOverlay).length > 0 ? credentialOverlay : undefined,
      inherit_env: inheritEnv,
      credential_resolution: {
        credential_set: this.config.credentials?.default_set,
        hive: input.hive,
        inherit_env: inheritEnv,
      },
      workspace: input.workspace,
      bootstrap: input.bootstrap,
      ...(input.repo_id !== undefined && { repo_id: input.repo_id }),
      ...(input.workspace_policy !== undefined && { workspace_policy: input.workspace_policy }),
    };

    // Create DB record — id is pre-generated so data_dir matches.
    const hosted = dal.createHostedSwarm({
      id: hostedSwarmId,
      provider: providerType,
      spawned_by: agentId,
      assigned_port: port,
      bootstrap_token_hash: tokenHash,
      config: provisionConfig,
    });

    try {
      // Provision via the hosting provider
      dal.updateHostedSwarm(hosted.id, { state: 'starting' });

      // If the caller requested git-sync on this hosted swarm's own
      // workspace, write the opentasks config.json BEFORE the subprocess
      // starts so the embedded daemon picks it up on first boot. This
      // closes the "spawn-time propagation" gap — without it, a fresh
      // hosted swarm always starts with sync off even when the operator
      // already knows they want it on.
      if (input.git_sync?.enabled) {
        try {
          fs.mkdirSync(dataDir, { recursive: true });
          applyGitSyncConfig(dataDir, input.git_sync);
        } catch (err) {
          console.warn(
            `[swarm-manager] git_sync config write failed for ${hosted.id}: ${(err as Error).message}`,
          );
          // Non-fatal: the swarm still spawns, user can PATCH later.
        }
      }

      // Resolve sandbox policy for sandboxed providers
      const sandboxPolicy = this.resolveSandboxPolicy(input.hive);
      const result = provider instanceof SandboxedLocalProvider
        ? await provider.provision(provisionConfig, sandboxPolicy)
        : await provider.provision(provisionConfig);

      // Track instance ↔ hosted swarm mapping
      this.instanceToHostedId.set(result.instance_id, hosted.id);
      this.hostedToInstanceId.set(hosted.id, result.instance_id);

      // Update with provider-specific info
      dal.updateHostedSwarm(hosted.id, {
        pid: result.pid ?? null,
        container_id: result.container_id ?? null,
        deployment_id: result.deployment_id ?? null,
        endpoint: result.endpoint ?? null,
      });

      // Wait for health check
      const endpoint = result.endpoint ?? `ws://127.0.0.1:${port}`;
      const healthy = await this.waitForHealth(port, 30000);

      if (!healthy) {
        dal.updateHostedSwarm(hosted.id, {
          state: 'unhealthy',
          error: 'Health check timed out after 30s',
        });
        // Don't throw — the swarm may still come up. Health monitor will track it.
        console.warn(`[swarm-manager] Swarm ${hosted.id} health check timed out, marking unhealthy`);
        return dal.findHostedSwarmById(hosted.id)!;
      }

      // Update MAP hub registration with hosted_swarm_id metadata.
      // The swarm was pre-registered before spawning (for stable identity).
      // Now enrich it with the hosted swarm ID and mark as running.
      try {
        if (preRegisteredSwarmId) {
          // Enrich the pre-registered swarm with hosted metadata
          mapDal.updateSwarm(preRegisteredSwarmId, {
            metadata: {
              ...(input.metadata ?? {}),
              hosted: true,
              hosted_swarm_id: hosted.id,
              provider: providerType,
            },
          });
        } else {
          // Fallback: pre-registration failed, register now
          const staleSwarm = mapDal.findSwarmByEndpoint(endpoint);
          if (staleSwarm) {
            mapDal.deleteSwarm(staleSwarm.id);
          }

          const mapResult = registerSwarm(agentId, {
            name,
            description: input.description,
            map_endpoint: endpoint,
            map_transport: 'websocket',
            capabilities: {
              observation: true,
              messaging: true,
              lifecycle: true,
            },
            metadata: {
              ...(input.metadata ?? {}),
              hosted: true,
              hosted_swarm_id: hosted.id,
              provider: providerType,
            },
          });
          preRegisteredSwarmId = mapResult.swarm.id;
        }

        dal.updateHostedSwarm(hosted.id, {
          swarm_id: preRegisteredSwarmId,
          endpoint,
          state: 'running',
          error: null,
        });
      } catch (err) {
        // MAP registration failed but process is running
        dal.updateHostedSwarm(hosted.id, {
          endpoint,
          state: 'running',
          error: `MAP registration failed: ${(err as Error).message}`,
        });
        console.warn(`[swarm-manager] Swarm ${hosted.id} is running but MAP registration failed: ${(err as Error).message}`);
      }

      // Broadcast event
      broadcastToChannel('map:discovery', {
        type: 'swarm_spawned',
        data: {
          hosted_swarm_id: hosted.id,
          name,
          provider: providerType,
          endpoint,
        },
      });

      return dal.findHostedSwarmById(hosted.id)!;
    } catch (err) {
      // Clean up on failure
      this.releasePorts(port, adapter);

      dal.updateHostedSwarm(hosted.id, {
        state: 'failed',
        error: (err as Error).message,
      });

      if (err instanceof SwarmHostingError) throw err;
      throw new SwarmHostingError('SPAWN_FAILED', `Failed to spawn swarm: ${(err as Error).message}`);
    }
  }

  // ==========================================================================
  // Stop
  // ==========================================================================

  async stop(hostedSwarmId: string, agentId: string): Promise<HostedSwarm> {
    const hosted = dal.findHostedSwarmById(hostedSwarmId);
    if (!hosted) {
      throw new SwarmHostingError('NOT_FOUND', 'Hosted swarm not found');
    }
    if (hosted.spawned_by !== agentId) {
      throw new SwarmHostingError('NOT_OWNER', 'You did not spawn this swarm');
    }

    // codex `mode: 'rpc'` rows live in CodexAppServerManager. Branch first
    // so they don't fall through to the TUI pipeline (which expects a PTY).
    if (hosted.kind === 'codex' && hosted.config?.mode === 'rpc') {
      return this.stopCodexRpc(hosted);
    }

    // TUI kinds live in PtyManager, not LocalProvider. Destroy the PTY;
    // the exit handler (handleTuiPtyExit) flips the row state.
    if (isTuiKind(hosted.kind)) {
      const strategy = this.getTuiStrategy(hosted.kind);
      if (!strategy) {
        throw new SwarmHostingError('NOT_IMPLEMENTED', `Unsupported TUI kind: ${hosted.kind}`);
      }
      return this.stopTuiKind(hosted, strategy);
    }

    const provider = this.providers.get(hosted.provider);
    if (!provider) {
      throw new SwarmHostingError('PROVIDER_NOT_AVAILABLE', `Provider "${hosted.provider}" not available`);
    }

    dal.updateHostedSwarm(hostedSwarmId, { state: 'stopping' });

    // Find the instance ID in the provider
    const instanceId = this.getInstanceId(hosted);
    if (!instanceId) {
      // No tracked instance — just mark as stopped
      dal.updateHostedSwarm(hostedSwarmId, { state: 'stopped', error: null });
      this.restartCounts.delete(hostedSwarmId);
      return dal.findHostedSwarmById(hostedSwarmId)!;
    }

    // Mark as intentionally stopping so exit handler doesn't auto-restart
    this.stoppingInstances.add(instanceId);

    try {
      await provider.deprovision(instanceId);
    } catch (err) {
      console.warn(`[swarm-manager] Error stopping instance ${instanceId}: ${(err as Error).message}`);
    }

    this.stoppingInstances.delete(instanceId);
    this.instanceToHostedId.delete(instanceId);
    this.hostedToInstanceId.delete(hostedSwarmId);

    // Release port
    if (hosted.assigned_port) {
      this.releasePorts(hosted.assigned_port, hosted.config?.adapter);
    }

    // Mark the MAP hub swarm as offline (but keep the row).
    //
    // We deliberately do NOT delete the map_swarms row here: hosted_swarms.swarm_id
    // has a `REFERENCES map_swarms(id) ON DELETE SET NULL` FK, so deleting would
    // null out the hosted swarm's swarm_id — destroying the linkage needed for
    // restart and durable session resume. Instead, flip status to 'offline' so the
    // swarm disappears from "online" lists while preserving its identity for
    // cold-restart via the saved bootstrap_token.
    if (hosted.swarm_id) {
      try {
        mapDal.updateSwarm(hosted.swarm_id, { status: 'offline' });
      } catch { /* best-effort */ }
    }

    dal.updateHostedSwarm(hostedSwarmId, { state: 'stopped', error: null });
    this.restartCounts.delete(hostedSwarmId);

    broadcastToChannel('map:discovery', {
      type: 'swarm_stopped',
      data: { hosted_swarm_id: hostedSwarmId },
    });

    return dal.findHostedSwarmById(hostedSwarmId)!;
  }

  // ==========================================================================
  // Restart
  // ==========================================================================

  async restart(hostedSwarmId: string, agentId: string): Promise<HostedSwarm> {
    const hostedInitial = dal.findHostedSwarmById(hostedSwarmId);
    if (!hostedInitial) {
      throw new SwarmHostingError('NOT_FOUND', 'Hosted swarm not found');
    }
    if (hostedInitial.spawned_by !== agentId) {
      throw new SwarmHostingError('NOT_OWNER', 'You did not spawn this swarm');
    }

    // codex `mode: 'rpc'` rows route through CodexAppServerManager — branch
    // first so they don't fall through to the TUI restart pipeline.
    // Restart starts a fresh thread (codex app-server doesn't expose live-
    // thread takeover; see the resume-probe deviation in the design doc).
    if (hostedInitial.kind === 'codex' && hostedInitial.config?.mode === 'rpc') {
      return this.restartCodexRpc(hostedInitial);
    }

    // TUI kinds route through PtyManager, not LocalProvider — the openswarm
    // restart machinery (port reuse, provider.restart, autoRestart) doesn't
    // apply. Branch early to a dedicated cold-restart path that tears down
    // the existing PTY/sidecar and re-boots the TUI against the SAME row
    // (preserves hosted_swarm_id, swarm_id, data_dir).
    if (isTuiKind(hostedInitial.kind)) {
      const strategy = this.getTuiStrategy(hostedInitial.kind);
      if (!strategy) {
        throw new SwarmHostingError('NOT_IMPLEMENTED', `Unsupported TUI kind: ${hostedInitial.kind}`);
      }
      return this.restartTuiKind(hostedInitial, strategy);
    }

    // Heal orphaned swarm_id if a prior stop nulled it via the old FK cascade.
    // Repair is idempotent — if swarm_id is already set, this is a no-op.
    // Re-read after repair so downstream sees the healed row.
    this.repairSwarmIdLink(hostedSwarmId, hostedInitial);
    const hosted = dal.findHostedSwarmById(hostedSwarmId)!;

    const provider = this.providers.get(hosted.provider);
    if (!provider) {
      throw new SwarmHostingError('RESTART_NOT_SUPPORTED', `Provider "${hosted.provider}" not available`);
    }

    dal.updateHostedSwarm(hostedSwarmId, { state: 'starting', error: null });

    // Two restart modes:
    //
    //   HOT (bounce): instance is tracked in memory. Reuse provider.restart() —
    //     same port, same config, minimal churn.
    //
    //   COLD (re-provision): no in-memory instance. Happens after a manual stop
    //     (which clears hostedToInstanceId) or after a hub restart. Fall through
    //     to the same cold-start path the crash-recovery auto-restart uses,
    //     which re-provisions from the persisted hosted.config.
    const instanceId = this.getInstanceId(hosted);

    if (instanceId && provider.restart) {
      try {
        const result = await provider.restart(instanceId);

        // provider.restart spawns a fresh process, so the instance id changes.
        // Rewrite both sides of the mapping — otherwise getInstanceId keeps
        // returning the dead one and downstream calls (getLogs, getStatus)
        // hit the "instance not tracked" fallbacks.
        this.instanceToHostedId.delete(instanceId);
        this.instanceToHostedId.set(result.instance_id, hostedSwarmId);
        this.hostedToInstanceId.set(hostedSwarmId, result.instance_id);

        dal.updateHostedSwarm(hostedSwarmId, {
          pid: result.pid ?? null,
          endpoint: result.endpoint ?? null,
          state: 'running',
          error: null,
        });

        if (hosted.swarm_id) {
          try {
            mapDal.heartbeatSwarm(hosted.swarm_id);
          } catch { /* swarm may not exist */ }
        }

        return dal.findHostedSwarmById(hostedSwarmId)!;
      } catch (err) {
        // If the original port is still bound (TIME_WAIT, stale child, another
        // process claimed it), drop the HOT-restart optimization and fall
        // through to the cold-start path — autoRestart allocates a fresh
        // port via `allocatePorts`. Without this, the retried process would
        // bind-fail on boot and crash-loop on the same stuck port.
        if ((err as { code?: string })?.code === 'PORT_IN_USE' && hosted.config) {
          console.warn(
            `[swarm-manager] Port ${hosted.config.assigned_port} stuck on restart of ${hostedSwarmId}; ` +
              `releasing and re-allocating via autoRestart`,
          );
          // Release the stuck port reservation so allocatePorts can reuse it
          // later once the OS finishes TIME_WAIT.
          this.releasePorts(hosted.config.assigned_port, hosted.config.adapter);
          this.hostedToInstanceId.delete(hostedSwarmId);
          this.instanceToHostedId.delete(instanceId);
          try {
            await this.autoRestart(hostedSwarmId, hosted);
            return dal.findHostedSwarmById(hostedSwarmId)!;
          } catch (retryErr) {
            dal.updateHostedSwarm(hostedSwarmId, {
              state: 'failed',
              error: (retryErr as Error).message,
            });
            throw new SwarmHostingError(
              'RESTART_FAILED',
              `Port in use, re-allocation failed: ${(retryErr as Error).message}`,
            );
          }
        }

        dal.updateHostedSwarm(hostedSwarmId, {
          state: 'failed',
          error: (err as Error).message,
        });
        throw new SwarmHostingError('RESTART_FAILED', `Failed to restart: ${(err as Error).message}`);
      }
    }

    // Cold-start path — no tracked instance. Requires the persisted config to
    // re-provision from scratch. The bootstrap token inside `hosted.config`
    // carries the original swarm_id, so the revived process registers under
    // the same identity (no re-registration needed on the hub).
    if (!hosted.config) {
      dal.updateHostedSwarm(hostedSwarmId, {
        state: 'failed',
        error: 'Cannot cold-start: no persisted config',
      });
      throw new SwarmHostingError(
        'RESTART_FAILED',
        'No tracked instance to restart and no persisted config to re-provision from',
      );
    }

    try {
      await this.autoRestart(hostedSwarmId, hosted);
      return dal.findHostedSwarmById(hostedSwarmId)!;
    } catch (err) {
      dal.updateHostedSwarm(hostedSwarmId, {
        state: 'failed',
        error: (err as Error).message,
      });
      throw new SwarmHostingError('RESTART_FAILED', `Cold-start failed: ${(err as Error).message}`);
    }
  }

  // ==========================================================================
  // Logs
  // ==========================================================================

  async getLogs(hostedSwarmId: string, agentId: string, opts?: { lines?: number }): Promise<string> {
    const hosted = dal.findHostedSwarmById(hostedSwarmId);
    if (!hosted) {
      throw new SwarmHostingError('NOT_FOUND', 'Hosted swarm not found');
    }
    if (hosted.spawned_by !== agentId) {
      throw new SwarmHostingError('NOT_OWNER', 'You did not spawn this swarm');
    }

    // codex `mode: 'rpc'` streams via the JSON-RPC notification channel into
    // openhive's chat surface — no scrollback buffer here either, but the
    // hint should point users to the right place.
    if (hosted.kind === 'codex' && hosted.config?.mode === 'rpc') {
      return '(codex-rpc output streams live via JSON-RPC notifications into openhive chat — no scrollback buffer)';
    }

    // TUI kinds live in PtyManager. Output is streamed live to the
    // embedded terminal via WS attach; PtyManager doesn't keep a scrollback
    // buffer that we could replay here. Return a clear hint instead of the
    // misleading "(no tracked instance)" the provider fallback emits.
    if (isTuiKind(hosted.kind)) {
      return `(${hosted.kind} logs stream live in the embedded terminal — no scrollback buffer)`;
    }

    const provider = this.providers.get(hosted.provider);
    if (!provider) return '(provider not available)';

    const instanceId = this.getInstanceId(hosted);
    if (!instanceId) return '(no tracked instance)';
    return provider.getLogs(instanceId, { lines: opts?.lines ?? 100 });
  }

  // ==========================================================================
  // Health Monitoring
  // ==========================================================================

  /** Start the periodic health check loop */
  startHealthMonitor(): void {
    if (this.healthInterval) return;

    this.healthInterval = setInterval(async () => {
      await this.runHealthChecks();
    }, this.config.health_check_interval);

    console.log(`[swarm-manager] Health monitor started (interval: ${this.config.health_check_interval}ms)`);
  }

  /** Stop the health check loop */
  stopHealthMonitor(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  private async runHealthChecks(): Promise<void> {
    const active = dal.getActiveHostedSwarms();

    for (const hosted of active) {
      if (hosted.state === 'stopping' || hosted.state === 'provisioning') continue;

      // TUI kinds (claude-code, codex) live in PtyManager, not
      // LocalProvider. Their liveness comes from the PTY exit handler
      // (handleClaudePtyExit) and, for sidecar-bearing kinds, the
      // sidecar's MAP registration — not an HTTP probe. The default
      // openswarm probe (port+1/health) doesn't apply: there's no port
      // and no HTTP server. Skip explicitly.
      if (isTuiKind(hosted.kind)) continue;

      const provider = this.providers.get(hosted.provider);
      if (!provider) continue;

      const instanceId = this.getInstanceId(hosted);

      // No tracked instance — skip (process may have been managed before a server restart)
      if (!instanceId) continue;

      try {
        const status = await provider.getStatus(instanceId);

        if (status.state === 'stopped' || status.state === 'failed') {
          dal.updateHostedSwarm(hosted.id, {
            state: status.state,
            error: status.error ?? null,
          });
          if (hosted.assigned_port) this.releasePorts(hosted.assigned_port, hosted.config?.adapter);
          continue;
        }

        // If running, try HTTP health check on the gateway port
        if (hosted.assigned_port && status.state === 'running') {
          const httpPort = hosted.assigned_port + 1; // OpenSwarm gateway HTTP is port+1
          const healthy = await this.checkHttpHealth(httpPort);

          if (healthy) {
            // Reset failures, ensure state is running
            if (provider instanceof LocalProvider || provider instanceof SandboxedLocalProvider) {
              (provider as LocalProvider | SandboxedLocalProvider).resetHealthFailures(instanceId);
            }
            if (hosted.state !== 'running') {
              dal.updateHostedSwarm(hosted.id, { state: 'running', error: null });
            }
            // Send heartbeat to MAP hub
            if (hosted.swarm_id) {
              try { mapDal.heartbeatSwarm(hosted.swarm_id); } catch { /* ignore */ }
            }
          } else {
            let failures = 1;
            if (provider instanceof LocalProvider || provider instanceof SandboxedLocalProvider) {
              failures = (provider as LocalProvider | SandboxedLocalProvider).recordHealthFailure(instanceId);
            }

            if (failures >= this.config.max_health_failures) {
              dal.updateHostedSwarm(hosted.id, {
                state: 'unhealthy',
                error: `Health check failed ${failures} consecutive times`,
              });
            }
          }
        }
      } catch (err) {
        console.warn(`[swarm-manager] Health check error for ${hosted.id}: ${(err as Error).message}`);
      }
    }
  }

  // ==========================================================================
  // Startup revival
  // ==========================================================================

  /**
   * Revive hosted swarms that were in active states when openhive last ran.
   *
   * On a server restart, openswarm child processes have almost always died
   * with the parent (detached children get killed by the exit handler;
   * anything that somehow survives is a detached orphan we can't adopt into
   * the provider's in-memory instance map anyway). Meanwhile the
   * `hosted_swarms` rows still say `state = running/starting/unhealthy`.
   *
   * Without revival, those rows become zombies: the UI shows them as
   * online (sidecar status lingers briefly after hub restart too), any
   * action fails because `hostedToInstanceId` is empty, and the user has
   * to manually remove + respawn.
   *
   * Strategy per row:
   *   - PID is alive AND we DON'T track it: orphan — mark failed with a
   *     diagnostic. Killing it blindly is too aggressive (user might want
   *     to diagnose); leaving it claiming `running` is worse (health
   *     monitor can't touch it). `failed` flips to the "restart" UI affordance.
   *   - PID is dead: cold-start via autoRestart (same path crash recovery
   *     uses). This is the common case.
   *   - Never call stop() first — the child process is already gone and
   *     stop tries to gracefully signal it, just wasting time on the
   *     common path.
   *
   * Runs sequentially to cap startup resource churn. If N swarms all
   * revive at once we spawn N openswarm processes + N Claude Code
   * subprocesses, which isn't free.
   */
  async reviveHostedSwarms(): Promise<{ revived: number; orphaned: number; failed: number }> {
    // Rows that SHOULD have a live process. Don't touch stopped/failed —
    // the user deliberately stopped those, or they already failed.
    const { data: candidates } = dal.listHostedSwarms({ limit: 500 });
    const active = candidates.filter(
      (h) => h.state === 'running' || h.state === 'starting' || h.state === 'unhealthy',
    );

    if (active.length === 0) {
      return { revived: 0, orphaned: 0, failed: 0 };
    }

    console.log(`[swarm-manager] Reviving ${active.length} hosted swarm(s) from last run`);

    let revived = 0;
    let orphaned = 0;
    let failed = 0;

    for (const hosted of active) {
      // TUI kinds can't be revived: the PTY is gone (PtyManager is in-
      // memory only), and any per-kind sidecar exited with the TUI or
      // self-stopped on idle. No auto-restart logic applies to
      // interactive TUIs. Mark them stopped with a clear diagnostic so
      // the operator knows to spawn fresh; don't try to provision()
      // through LocalProvider (which would crash without a TTY).
      if (isTuiKind(hosted.kind)) {
        console.log(
          `[swarm-manager] ${hosted.kind} row ${hosted.id} cannot survive hub restart — marking stopped`,
        );
        dal.updateHostedSwarm(hosted.id, {
          state: 'stopped',
          error: `${hosted.kind} session ended with hub restart; spawn fresh to resume`,
          pid: null,
        });
        if (hosted.swarm_id) {
          try { mapDal.updateSwarm(hosted.swarm_id, { status: 'offline' }); } catch { /* best-effort */ }
        }
        // Best-effort sidecar cleanup if this kind has one and it survived.
        const strategy = this.getTuiStrategy(hosted.kind);
        if (strategy?.hasSidecar) strategy.signalSidecar?.(hosted, 'SIGTERM');
        continue;
      }

      const pid = hosted.pid;
      const alive = pid ? isPidAlive(pid) : false;

      if (alive) {
        // Orphan — can't adopt this PID into the provider's instance map
        // without deeper hooks. Mark as failed so the UI surfaces a
        // Restart affordance; the user can click Restart to cold-start
        // a replacement (old orphan will need manual kill).
        console.warn(
          `[swarm-manager] Hosted swarm ${hosted.id} has an orphan PID ${pid} — marking failed (user should restart manually)`,
        );
        dal.updateHostedSwarm(hosted.id, {
          state: 'failed',
          error: `Orphaned PID ${pid} from prior openhive instance — cannot adopt. Use Restart to replace.`,
        });
        orphaned++;
        continue;
      }

      // Dead PID — cold-start via autoRestart. Handles port re-allocation,
      // credential re-resolution, swarm_id repair, health wait.
      if (!hosted.config) {
        console.warn(
          `[swarm-manager] Hosted swarm ${hosted.id} has no saved config — marking failed`,
        );
        dal.updateHostedSwarm(hosted.id, {
          state: 'failed',
          error: 'Cannot revive: no persisted config',
        });
        failed++;
        continue;
      }

      try {
        await this.autoRestart(hosted.id, hosted);
        revived++;
      } catch (err) {
        console.error(
          `[swarm-manager] Failed to revive ${hosted.id}: ${(err as Error).message}`,
        );
        dal.updateHostedSwarm(hosted.id, {
          state: 'failed',
          error: `Revival failed on startup: ${(err as Error).message}`,
        });
        failed++;
      }
    }

    console.log(
      `[swarm-manager] Revival complete — revived: ${revived}, orphaned: ${orphaned}, failed: ${failed}`,
    );
    return { revived, orphaned, failed };
  }

  // ==========================================================================
  // Shutdown
  // ==========================================================================

  /** Gracefully stop all hosted swarms and clean up */
  async shutdown(): Promise<void> {
    this.stopHealthMonitor();

    // Disable exit handler before stopping — otherwise handleProcessExit
    // sees SIGTERM exits as crashes and tries to auto-restart, spawning
    // new child processes that prevent the Node process from exiting.
    const localProvider = this.providers.get('local');
    if (localProvider instanceof LocalProvider) {
      localProvider.onProcessExit = null;
      await localProvider.stopAll();
      localProvider.removeExitHandler();
    }

    const sandboxedProvider = this.providers.get('local-sandboxed');
    if (sandboxedProvider instanceof SandboxedLocalProvider) {
      sandboxedProvider.onProcessExit = null;
      await sandboxedProvider.stopAll();
      sandboxedProvider.removeExitHandler();
    }

    // Mark all active hosted swarms as stopped and clean up MAP registrations
    const active = dal.getActiveHostedSwarms();
    for (const hosted of active) {
      if (hosted.swarm_id) {
        try { mapDal.deleteSwarm(hosted.swarm_id); } catch { /* may already be deleted */ }
      }
      dal.updateHostedSwarm(hosted.id, { state: 'stopped' });
    }

    console.log('[swarm-manager] Shutdown complete');
  }

  // ==========================================================================
  // Process Exit Handler (Immediate Crash Detection)
  // ==========================================================================

  /**
   * Called immediately by LocalProvider when a child process exits.
   * This provides instant crash detection instead of waiting for the
   * next 30s health check interval.
   */
  private handleProcessExit(instanceId: string, code: number | null, signal: string | null): void {
    // If this was an intentional stop, don't do anything
    if (this.stoppingInstances.has(instanceId)) return;

    const hostedId = this.instanceToHostedId.get(instanceId);
    if (!hostedId) return;

    const hosted = dal.findHostedSwarmById(hostedId);
    if (!hosted) return;

    // Already in a terminal state
    if (hosted.state === 'stopped' || hosted.state === 'failed') return;

    const isGraceful = code === 0;
    const eventType = isGraceful ? 'swarm_stopped' as const : 'swarm_offline' as const;
    const errorMsg = isGraceful
      ? 'Process exited gracefully'
      : `Process crashed (code=${code}, signal=${signal})`;

    console.warn(`[swarm-manager] ${eventType}: ${hosted.id} — ${errorMsg}`);

    // Log recent process output to help debug crashes
    if (!isGraceful) {
      const provider = this.providers.get(hosted.provider);
      if (provider) {
        provider.getLogs(instanceId, { lines: 15 }).then((recentLogs) => {
          if (recentLogs && recentLogs !== '(no logs — instance not found)') {
            console.warn(`[swarm-manager] Recent output from ${hosted.id}:\n${recentLogs}`);
          }
        }).catch(() => { /* ignore log retrieval errors */ });
      }
    }

    // Update DB state
    dal.updateHostedSwarm(hostedId, {
      state: isGraceful ? 'stopped' : 'failed',
      error: isGraceful ? null : errorMsg,
    });

    // Release port
    if (hosted.assigned_port) {
      this.releasePorts(hosted.assigned_port, hosted.config?.adapter);
    }

    // Broadcast crash/shutdown event to connected clients
    broadcastToChannel('map:discovery', {
      type: eventType,
      data: {
        hosted_swarm_id: hostedId,
        name: hosted.config?.name,
        code,
        signal,
        error: errorMsg,
      },
    });

    // Auto-restart if configured and this was a crash (not graceful shutdown)
    if (!isGraceful && this.config.auto_restart && hosted.config) {
      const restartCount = this.restartCounts.get(hostedId) ?? 0;

      const maxAttempts = this.config.max_restart_attempts;
      if (maxAttempts > 0 && restartCount >= maxAttempts) {
        console.warn(
          `[swarm-manager] Swarm ${hostedId} exceeded max restart attempts (${maxAttempts}), not restarting`,
        );
        dal.updateHostedSwarm(hostedId, {
          error: `${errorMsg} — exceeded max restart attempts (${maxAttempts})`,
        });
        this.restartCounts.delete(hostedId);
        return;
      }

      this.restartCounts.set(hostedId, restartCount + 1);
      console.log(`[swarm-manager] Auto-restarting swarm ${hostedId} (attempt ${restartCount + 1})`);

      // Clean up old mapping
      this.instanceToHostedId.delete(instanceId);
      this.hostedToInstanceId.delete(hostedId);

      // Re-provision asynchronously
      this.autoRestart(hostedId, hosted).catch((err) => {
        console.error(`[swarm-manager] Auto-restart failed for ${hostedId}: ${(err as Error).message}`);
        dal.updateHostedSwarm(hostedId, {
          state: 'failed',
          error: `Auto-restart failed: ${(err as Error).message}`,
        });
      });
    }
  }

  /**
   * Repair the hosted → map_swarms linkage by decoding the persisted
   * bootstrap_token. Earlier versions of stop() deleted the map_swarms row
   * directly, which (via FK ON DELETE SET NULL) nulled out
   * hosted_swarms.swarm_id — losing the stable identity needed for restart
   * and UI navigation.
   *
   * The bootstrap_token is base64-encoded JSON that includes the
   * pre-registered swarm_id; it's saved on hosted.config and never mutated,
   * so we can always recover the original id.
   *
   * Returns the recovered swarm_id, or null if the token is unusable or the
   * hosted row is missing. Safe to call at any time — the restart path uses
   * this to heal orphaned rows (and also to re-link after a clean stop +
   * map_swarms deletion cycle).
   */
  private repairSwarmIdLink(hostedId: string, hosted: HostedSwarm): string | null {
    if (hosted.swarm_id) return hosted.swarm_id;
    const token = hosted.config?.bootstrap_token;
    if (!token) return null;
    try {
      const payload = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
      const swarmId = typeof payload?.swarm_id === 'string' ? payload.swarm_id : null;
      if (!swarmId) return null;
      dal.updateHostedSwarm(hostedId, { swarm_id: swarmId });
      console.log(`[swarm-manager] Repaired swarm_id linkage for ${hostedId} → ${swarmId}`);
      return swarmId;
    } catch {
      return null;
    }
  }

  /**
   * Re-provision a crashed swarm using its saved config.
   */
  private async autoRestart(hostedId: string, hosted: HostedSwarm): Promise<void> {
    const provider = this.providers.get(hosted.provider);
    if (!provider || !hosted.config) {
      throw new Error('Cannot auto-restart: provider or config not available');
    }

    // Heal orphaned swarm_id before provisioning — the revived sidecar will
    // register under the id encoded in its bootstrap_token, so hosted_swarms
    // must point at that row for UI navigation + heartbeat to work. The
    // repair writes to the DB; use the recovered id alongside the existing
    // hosted handle rather than re-reading (to preserve the non-null
    // narrowing on hosted.config that the guard above established).
    const resolvedSwarmId = hosted.swarm_id ?? this.repairSwarmIdLink(hostedId, hosted);

    dal.updateHostedSwarm(hostedId, { state: 'starting', error: null });

    // Prefer the swarm's previous port so endpoints stay stable across
    // restarts — any client that cached the old URL reconnects cleanly,
    // and the UI/debugging stays coherent. Fall back to the general scan
    // if the old port is held (orphan, another swarm claimed it during
    // downtime, etc.). Probes the OS so we never hand back a port that
    // isn't actually bindable.
    let port: number | null = null;
    const prev = hosted.assigned_port;
    if (prev && (await this.tryReserveSpecificPort(prev, hosted.config.adapter))) {
      port = prev;
      console.log(`[swarm-manager] Reusing previous port ${prev} for ${hostedId}`);
    } else {
      port = await this.allocatePorts(hosted.config.adapter);
      if (port !== null && prev && port !== prev) {
        console.log(
          `[swarm-manager] Previous port ${prev} unavailable for ${hostedId}, allocated ${port}`,
        );
      }
    }
    if (!port) {
      throw new Error('No ports available for restart');
    }

    // Re-resolve credentials from live config (not from DB — secrets are never persisted)
    const credRes = hosted.config.credential_resolution;
    const freshOverlay = resolveCredentialOverlay(
      this.config.credentials,
      credRes?.hive,
    );

    const config: SwarmProvisionConfig = {
      ...hosted.config,
      assigned_port: port,
      resolved_credentials: Object.keys(freshOverlay).length > 0 ? freshOverlay : undefined,
      inherit_env: credRes?.inherit_env ?? (this.config.credentials?.inherit_env !== false),
    };
    const result = await provider.provision(config);

    // Track new instance mapping
    this.instanceToHostedId.set(result.instance_id, hostedId);
    this.hostedToInstanceId.set(hostedId, result.instance_id);

    dal.updateHostedSwarm(hostedId, {
      pid: result.pid ?? null,
      assigned_port: port,
      endpoint: result.endpoint ?? null,
    });

    // Wait for health
    const healthy = await this.waitForHealth(port, 30000);
    if (!healthy) {
      dal.updateHostedSwarm(hostedId, {
        state: 'unhealthy',
        error: 'Health check timed out after restart',
      });
      return;
    }

    dal.updateHostedSwarm(hostedId, { state: 'running', error: null });
    this.restartCounts.delete(hostedId);

    // Send heartbeat if registered in MAP hub. Use resolvedSwarmId so a
    // freshly-repaired linkage (from the bootstrap_token) gets used on the
    // first restart after a stop.
    if (resolvedSwarmId) {
      try {
        mapDal.heartbeatSwarm(resolvedSwarmId);
      } catch { /* swarm may not exist */ }
    }

    broadcastToChannel('map:discovery', {
      type: 'swarm_spawned',
      data: {
        hosted_swarm_id: hostedId,
        name: hosted.config?.name,
        new_port: port,
      },
    });
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Resolve the sandbox policy for a swarm, merging default + hive overrides.
   */
  private resolveSandboxPolicy(hive?: string): SwarmSandboxPolicy | undefined {
    const sandboxConfig = this.config.sandbox;
    if (!sandboxConfig?.enabled) return undefined;

    const defaultPolicy = sandboxConfig.default_policy ?? {};

    if (!hive || !sandboxConfig.hive_overrides?.[hive]) {
      return defaultPolicy;
    }

    // Merge: hive override fields take precedence over defaults
    const hiveOverride = sandboxConfig.hive_overrides[hive];
    return {
      allowed_domains: hiveOverride.allowed_domains ?? defaultPolicy.allowed_domains,
      denied_domains: hiveOverride.denied_domains ?? defaultPolicy.denied_domains,
      allow_local_binding: hiveOverride.allow_local_binding ?? defaultPolicy.allow_local_binding,
      allow_write: hiveOverride.allow_write ?? defaultPolicy.allow_write,
      deny_write: hiveOverride.deny_write ?? defaultPolicy.deny_write,
      deny_read: hiveOverride.deny_read ?? defaultPolicy.deny_read,
      allow_pty: hiveOverride.allow_pty ?? defaultPolicy.allow_pty,
    };
  }

  /**
   * How many consecutive ports the adapter process binds, starting at --port.
   *
   * macro-agent binds three:
   *   port     — ACP WebSocket server
   *   port + 1 — gateway HTTP (health/metrics)
   *   port + 2 — MAP server
   *
   * If we only reserved one, spawning N macro-agent swarms at 9000, 9001, 9002…
   * would collide: swarm #2's --port 9001 clashes with swarm #1's gateway HTTP.
   */
  private getPortStride(adapter: string | undefined): number {
    return adapter === 'macro-agent' ? 3 : 1;
  }

  /** Try to bind briefly to (host, port); resolve true if it was free. */
  private isPortFree(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, host);
    });
  }

  /**
   * Allocate a base port with `stride` consecutive ports all free at the OS
   * level and not already reserved in-memory. Reserves all N ports against
   * concurrent spawns. Returns the base port, or null if none found.
   */
  private async allocatePorts(adapter: string | undefined): Promise<number | null> {
    const stride = this.getPortStride(adapter);
    const [min, max] = this.config.port_range;
    const host = '127.0.0.1';
    const maxBase = max - stride + 1;
    if (maxBase < min) return null;

    for (let base = min; base <= maxBase; base++) {
      // Skip if any port in [base, base+stride-1] is already reserved by
      // another swarm (or an in-flight concurrent spawn).
      let reserved = false;
      for (let i = 0; i < stride; i++) {
        if (this.usedPorts.has(base + i)) {
          reserved = true;
          break;
        }
      }
      if (reserved) continue;

      // OS-level probe: every port must actually be bindable. Re-check
      // usedPorts on each iteration so that a concurrent allocatePorts call
      // reserving while we're awaiting isPortFree is still visible.
      let allFree = true;
      for (let i = 0; i < stride; i++) {
        const p = base + i;
        if (this.usedPorts.has(p) || !(await this.isPortFree(p, host))) {
          allFree = false;
          break;
        }
      }
      if (!allFree) continue;

      // Final synchronous recheck before reservation — once we commit to the
      // Set mutation below, no other async call can slip in until we yield.
      let stillFree = true;
      for (let i = 0; i < stride; i++) {
        if (this.usedPorts.has(base + i)) {
          stillFree = false;
          break;
        }
      }
      if (!stillFree) continue;

      for (let i = 0; i < stride; i++) this.usedPorts.add(base + i);
      return base;
    }
    return null;
  }

  /**
   * Try to reserve a specific base port (plus its stride neighbors). Used
   * by `autoRestart` to give a revived swarm its previous port back when
   * nothing else has claimed it — keeps endpoints stable across restarts
   * instead of letting `allocatePorts` wander to whatever's free from
   * `port_range.min`. Returns true on success (ports are reserved) or
   * false if any port is already taken; caller falls back to the scan.
   */
  private async tryReserveSpecificPort(
    base: number,
    adapter: string | undefined,
  ): Promise<boolean> {
    const stride = this.getPortStride(adapter);
    const [min, max] = this.config.port_range;
    if (base < min || base + stride - 1 > max) return false;

    for (let i = 0; i < stride; i++) {
      if (this.usedPorts.has(base + i)) return false;
    }
    for (let i = 0; i < stride; i++) {
      if (!(await this.isPortFree(base + i, '127.0.0.1'))) return false;
    }
    for (let i = 0; i < stride; i++) {
      if (this.usedPorts.has(base + i)) return false;
    }

    for (let i = 0; i < stride; i++) this.usedPorts.add(base + i);
    return true;
  }

  private releasePorts(basePort: number, adapter: string | undefined): void {
    const stride = this.getPortStride(adapter);
    for (let i = 0; i < stride; i++) {
      this.usedPorts.delete(basePort + i);
    }
  }

  private getInstanceId(hosted: HostedSwarm): string | null {
    // Use the tracked mapping instead of reconstructing from timestamps
    // (SQLite datetime truncates milliseconds, causing ID mismatches)
    return this.hostedToInstanceId.get(hosted.id) ?? null;
  }

  private async waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
    const httpPort = port + 1; // OpenSwarm gateway HTTP is on port+1
    const start = Date.now();
    const interval = 1000;

    while (Date.now() - start < timeoutMs) {
      if (await this.checkHttpHealth(httpPort)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    return false;
  }

  private async checkHttpHealth(httpPort: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`http://127.0.0.1:${httpPort}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check whether a PID is currently running.
 *
 * `process.kill(pid, 0)` sends no signal but throws ESRCH if the process
 * doesn't exist. It can also throw EPERM if the pid belongs to another user —
 * in that case the process IS alive (we just can't signal it), so we treat
 * EPERM as "alive too" for the conservative-adoption path.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

// ============================================================================
// Error Type
// ============================================================================

/**
 * Failure modes that can surface during a `SwarmManager.spawn` call. The
 * union mixes pure swarm-hosting concerns with two repo-domain codes
 * (`REPO_NOT_FOUND`, `WORKSPACE_POLICY_PERSIST_FAILED`) that arise inside
 * the spawn flow when an `input.repo_id` or `input.workspace_policy`
 * argument is supplied. They live here rather than in a separate
 * `RepoSpawnErrorCode` because the caller of `spawn()` only ever sees
 * one error type — a single union surfaces every reason a single call
 * can fail. If repo-related concerns ever move out of the spawn
 * critical path, split them out then.
 */
export type SwarmHostingErrorCode =
  | 'MAX_SWARMS_REACHED'
  | 'PROVIDER_NOT_AVAILABLE'
  | 'NO_PORTS_AVAILABLE'
  | 'HIVE_NOT_FOUND'
  | 'ONBOARD_TOKEN_FAILED'
  | 'WORKSPACE_SETUP_FAILED'
  | 'SPAWN_FAILED'
  | 'NOT_FOUND'
  | 'NOT_OWNER'
  | 'RESTART_NOT_SUPPORTED'
  | 'RESTART_FAILED'
  | 'REPO_NOT_FOUND'
  | 'WORKSPACE_POLICY_PERSIST_FAILED'
  | 'NOT_IMPLEMENTED';

export class SwarmHostingError extends Error {
  code: SwarmHostingErrorCode;

  constructor(code: SwarmHostingErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'SwarmHostingError';
  }
}
