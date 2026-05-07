/**
 * Local Sidecar Hosting Provider
 *
 * Spawns OpenSwarm instances as child processes on the same host.
 * Follows the same pattern as HeadscaleManager (src/headscale/manager.ts).
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type {
  HostingProvider,
  SwarmProvisionConfig,
  ProvisionResult,
  InstanceStatus,
  LogOptions,
  HostedSwarmState,
} from '../types.js';
import { cloneWorkspaceRepos } from './workspace.js';

interface ManagedProcess {
  process: ChildProcess;
  config: SwarmProvisionConfig;
  startedAt: number;
  logBuffer: string[];
  /**
   * Append-only log file path. Location depends on LogConfig.dir:
   *   "tmp"      → ${os.tmpdir()}/openhive-swarm-logs/<instanceId>.log
   *   "data_dir" → <data_dir>/openswarm.log
   *   <path>     → <path>/<instanceId>.log
   * Empty string when file logging is disabled.
   */
  logFilePath: string;
  logStream: fs.WriteStream | null;
  healthFailures: number;
  restartCount: number;
}

/**
 * Where (or whether) to persist the per-swarm log stream.
 *
 * - `enabled: false` → in-memory ring buffer only; nothing hits disk.
 * - `dir: "tmp"`      → ephemeral. Survives swarm restarts during the session
 *                       but is gone on reboot. Good default — bounded blast
 *                       radius, enough for debugging crash-recover loops.
 * - `dir: "data_dir"` → co-located with the swarm's own data directory.
 *                       Survives reboots; pair with data_dir cleanup.
 * - any absolute path → custom directory shared across swarms. The filename
 *                       is `<instanceId>.log` to avoid collisions.
 */
export interface LogConfig {
  enabled: boolean;
  dir: string;
}

/**
 * Signal that the requested port is still bound (usually OS TIME_WAIT from
 * the previous process). The manager catches this and falls back to a fresh
 * port allocation via autoRestart.
 */
export class PortInUseError extends Error {
  readonly code = 'PORT_IN_USE';
  constructor(public readonly port: number) {
    super(`Port ${port} is still bound`);
  }
}

/** Callback fired when a child process exits unexpectedly */
export type ProcessExitHandler = (
  instanceId: string,
  code: number | null,
  signal: string | null,
) => void;

const MAX_LOG_LINES = 1000;

/**
 * Kill a process and its entire process tree.
 * Uses negative PID to send signal to the process group (works because
 * children are spawned with detached: true, making them group leaders).
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = child.pid;
  if (!pid) return false;

  try {
    // Kill the entire process group (negative PID)
    process.kill(-pid, signal);
    return true;
  } catch {
    // Process group may already be dead; try direct kill as fallback
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

export class LocalProvider implements HostingProvider {
  readonly type = 'local' as const;

  private processes = new Map<string, ManagedProcess>();
  private openswarmCommand: string;
  private logConfig: LogConfig;

  /** Called when a managed process exits (for immediate crash detection) */
  onProcessExit: ProcessExitHandler | null = null;

  private exitHandler: () => void;

  constructor(openswarmCommand: string, logConfig?: Partial<LogConfig>) {
    this.openswarmCommand = openswarmCommand;
    this.logConfig = {
      enabled: logConfig?.enabled ?? true,
      dir: logConfig?.dir ?? 'tmp',
    };

    // Safety net: synchronously kill all child process trees if the parent
    // exits before async shutdown completes (e.g. tsx force-kill, double Ctrl+C)
    this.exitHandler = () => {
      for (const [, managed] of this.processes) {
        if (managed.process.exitCode === null) {
          killProcessGroup(managed.process, 'SIGKILL');
        }
      }
    };
    process.once('exit', this.exitHandler);
  }

  /** Remove the process exit handler (call after stopAll to avoid listener leaks) */
  removeExitHandler(): void {
    process.removeListener('exit', this.exitHandler);
  }

  async provision(config: SwarmProvisionConfig): Promise<ProvisionResult> {
    const instanceId = `local_${Date.now()}_${config.assigned_port}`;

    // Ensure data directory exists
    const dataDir = path.resolve(config.data_dir);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Clone workspace repos before spawning the process
    if (config.workspace?.repos.length) {
      await cloneWorkspaceRepos(config.workspace, dataDir, process.env as Record<string, string>);
    }

    // Resolve the binary + args. Two paths:
    //   1. spawn_command_override set → take the override + override_args
    //      verbatim; no openswarm-specific flags appended. Used by
    //      non-openswarm kinds (claude-code, future codex/gemini) so the
    //      provider stays kind-agnostic.
    //   2. Default → split this.openswarmCommand and append openswarm's
    //      hosting-server flags (--port, --host, --adapter).
    let bin: string;
    let args: string[];
    if (config.spawn_command_override) {
      bin = config.spawn_command_override;
      args = config.spawn_args_override ?? [];
    } else {
      // Parse the command (could be 'npx openswarm', 'node /path/to/bin', etc.)
      const parts = this.openswarmCommand.split(/\s+/);
      bin = parts[0];
      const baseArgs = parts.slice(1);

      // Build args for OpenSwarm's hosting server
      args = [
        ...baseArgs,
        '--port', String(config.assigned_port),
        '--host', '127.0.0.1',
      ];

      if (config.adapter) {
        args.push('--adapter', config.adapter);
      }
    }

    // Build environment for child process
    const env: Record<string, string> = {};
    if (config.inherit_env !== false) {
      Object.assign(env, process.env as Record<string, string>);
    }
    if (config.resolved_credentials) {
      Object.assign(env, config.resolved_credentials);
    }
    env.OPENSWARM_BOOTSTRAP_TOKEN = config.bootstrap_token;
    env.OPENSWARM_DATA_DIR = dataDir;

    // Bootstrap-coordinator pass-through. macro-agent's bootV2 reads these
    // env vars and spawns a default coordinator when set, so the swarm is
    // chat-ready without an explicit _macro/spawnAgent call. Going through
    // env (not openswarm CLI args) avoids modifying openswarm's whitelisted
    // bootConfig pass-through.
    if (config.bootstrap?.coordinator) {
      env.MACRO_BOOTSTRAP_COORDINATOR = 'true';
      if (config.bootstrap.cwd) {
        env.MACRO_BOOTSTRAP_CWD = config.bootstrap.cwd;
      }
      // Hosted swarms own the full agent tree for their workspace — a
      // restart should restore every running agent, not just the head
      // coordinator. Standalone macro-agent boots default to 'coordinators'
      // to avoid reviving stale workers that belong to a different use
      // case (ad-hoc CLI runs, test fixtures, etc.).
      env.MACRO_BOOTSTRAP_REHYDRATE = 'all';
    }

    // Strip Claude Code's "I am running inside a Claude Code session" markers
    // from the inherited env. The hosted swarm will launch Claude Code
    // subprocesses (via macro-agent / claude-code-acp); the Claude Code SDK
    // checks these markers and refuses with "Claude Code cannot be launched
    // inside another Claude Code session" if inherited. Without stripping,
    // any openhive instance that itself runs inside a Claude Code session
    // (e.g. during development) cannot spawn hosted macro-agent swarms.
    //
    // Safe to strip unconditionally: the spawned openswarm is a new root
    // process — it's not nested inside our Claude Code session in any
    // meaningful sense.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_EXECPATH;
    delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

    // Note: we intentionally do NOT isolate CLAUDE_CONFIG_DIR. Claude Code's
    // OAuth keychain service name is derived from CLAUDE_CONFIG_DIR — setting
    // a non-default value silently switches to a namespaced entry that doesn't
    // exist, causing "Please run /login" / "Authentication required" even
    // though the user is authenticated in their primary Claude Code session.
    // Stripping CLAUDECODE* above is sufficient in practice.

    // When the resolved command is `node`, redirect to process.execPath so
    // this works inside Electron — packaged Electron apps ship no standalone
    // `node` binary, but process.execPath + ELECTRON_RUN_AS_NODE=1 makes the
    // Electron binary itself act as Node. In plain Node this is a no-op,
    // since process.execPath IS the node binary.
    if (bin === 'node' || bin === 'node.exe') {
      bin = process.execPath;
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    // Spawn as a new process group leader (detached: true) so we can
    // kill the entire tree (openswarm + its subprocesses) via -pid.
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: dataDir,
      detached: true,
    });

    // Persist the log stream so the previous boot's output (including crash
    // traces) is visible via GET /map/hosted/:id/logs even after a respawn —
    // the in-memory ring buffer alone gets wiped on deprovision. Location
    // respects the operator's `swarmHosting.logs` config; disabled means we
    // keep the ring buffer only and never touch disk.
    const logFilePath = this.logConfig.enabled
      ? resolveLogPath(this.logConfig.dir, dataDir, instanceId)
      : '';
    let logStream: fs.WriteStream | null = null;
    if (logFilePath) {
      try {
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
      } catch (err) {
        console.warn(`[local-provider] Could not open log file ${logFilePath}: ${(err as Error).message}`);
      }
    }

    const managed: ManagedProcess = {
      process: child,
      config,
      startedAt: Date.now(),
      logBuffer: [],
      logFilePath,
      logStream,
      healthFailures: 0,
      restartCount: 0,
    };

    const writeLogLine = (entry: string) => {
      managed.logBuffer.push(entry);
      if (managed.logBuffer.length > MAX_LOG_LINES) managed.logBuffer.shift();
      // Best-effort file append — don't block on stream errors.
      try { logStream?.write(entry + '\n'); } catch { /* ignore */ }
    };

    // Boot separator so operators can scan the log file for restart boundaries.
    writeLogLine(
      `[${new Date().toISOString()}] [system] === boot pid=${child.pid ?? '?'} ` +
        `port=${config.assigned_port} cmd="${bin} ${args.join(' ')}" ===`,
    );

    const appendLog = (data: Buffer, stream: string) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        writeLogLine(`[${new Date().toISOString()}] [${stream}] ${line}`);
      }
    };

    child.stdout?.on('data', (data: Buffer) => appendLog(data, 'stdout'));
    child.stderr?.on('data', (data: Buffer) => appendLog(data, 'stderr'));

    child.on('exit', (code, signal) => {
      writeLogLine(
        `[${new Date().toISOString()}] [system] Process exited (code=${code}, signal=${signal})`,
      );
      // Notify the manager immediately about the exit
      this.onProcessExit?.(instanceId, code, signal);
    });

    child.on('error', (err) => {
      writeLogLine(`[${new Date().toISOString()}] [system] Process error: ${err.message}`);
    });

    this.processes.set(instanceId, managed);

    // Wait a moment for the process to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check if process is still running
    if (child.exitCode !== null) {
      const logs = managed.logBuffer.slice(-10).join('\n');
      throw new Error(
        `OpenSwarm process exited immediately (code=${child.exitCode}). ` +
        `Command: ${bin} ${args.join(' ')}\n` +
        `Recent output:\n${logs}`
      );
    }

    const endpoint = `ws://127.0.0.1:${config.assigned_port}`;

    return {
      instance_id: instanceId,
      state: 'running',
      pid: child.pid,
      endpoint,
    };
  }

  async deprovision(instanceId: string): Promise<void> {
    const managed = this.processes.get(instanceId);
    if (!managed) return;

    const child = managed.process;

    if (child.exitCode === null) {
      // Send SIGTERM to the entire process group for graceful shutdown
      killProcessGroup(child, 'SIGTERM');

      // Wait up to 5s for graceful exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (child.exitCode === null) {
            // Force-kill the entire process group
            killProcessGroup(child, 'SIGKILL');
          }
          exitHandler();
        }, 5000);

        const exitHandler = () => {
          clearTimeout(timeout);
          child.removeListener('exit', exitHandler);
          resolve();
        };

        child.on('exit', exitHandler);
      });
    }

    // Remove all listeners on the child process to release closures
    child.removeAllListeners();
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();

    // Close the log stream (file stays on disk; the next provision appends
    // so operators can inspect the full history across restarts).
    try { managed.logStream?.end(); } catch { /* ignore */ }

    this.processes.delete(instanceId);
  }

  async getStatus(instanceId: string): Promise<InstanceStatus> {
    const managed = this.processes.get(instanceId);

    if (!managed) {
      return { state: 'stopped' };
    }

    const child = managed.process;
    const isRunning = child.exitCode === null;

    let state: HostedSwarmState;
    if (!isRunning) {
      state = child.exitCode === 0 ? 'stopped' : 'failed';
    } else if (managed.healthFailures > 0) {
      state = 'unhealthy';
    } else {
      state = 'running';
    }

    return {
      state,
      pid: child.pid,
      uptime_ms: isRunning ? Date.now() - managed.startedAt : undefined,
      error: !isRunning ? `Process exited with code ${child.exitCode}` : undefined,
    };
  }

  async getLogs(instanceId: string, opts?: LogOptions): Promise<string> {
    const managed = this.processes.get(instanceId);
    // Lookup by data_dir when the instance isn't tracked (e.g. the child
    // already exited before the manager wired up its mapping). We still
    // have the persistent log file on disk.
    if (!managed) {
      return this.readLogFileByInstance(instanceId, opts);
    }

    let lines = managed.logBuffer;

    // If the in-memory buffer is small (fresh boot after a restart), tail
    // the persistent log file so operators see the prior boot's output.
    // Skipped when file logging is disabled (empty logFilePath).
    const requested = opts?.lines ?? lines.length;
    if (managed.logFilePath && lines.length < requested) {
      const fromFile = await readTailLines(managed.logFilePath, requested);
      // Combine file history with live buffer, dedup by exact-match on the
      // last N buffer lines (file lags ring buffer by at most a few writes).
      if (fromFile.length) {
        const bufSet = new Set(lines);
        const merged = [...fromFile.filter(l => !bufSet.has(l)), ...lines];
        lines = merged;
      }
    }

    if (opts?.since) {
      const sinceTime = new Date(opts.since).getTime();
      lines = lines.filter((line) => {
        const match = line.match(/^\[(\d{4}-[^\]]+)\]/);
        if (!match) return true;
        return new Date(match[1]).getTime() >= sinceTime;
      });
    }

    if (opts?.lines) {
      lines = lines.slice(-opts.lines);
    }

    return lines.join('\n');
  }

  /**
   * Read logs by instanceId when the process is no longer tracked. The
   * instanceId format is `local_${timestamp}_${port}`, which isn't enough
   * to recover the data_dir on its own — so this falls back to a scan of
   * any remaining tracked process that shares the config's data_dir.
   */
  private async readLogFileByInstance(instanceId: string, opts?: LogOptions): Promise<string> {
    void instanceId;
    // No durable instance→dataDir mapping exists outside `processes`; if
    // the process isn't tracked we have no way to resolve the file. The
    // manager can still surface on-disk logs after a restart because it
    // gives us the NEW instance id, which IS tracked.
    void opts;
    return '(no logs — instance not found)';
  }

  async restart(instanceId: string): Promise<ProvisionResult> {
    const managed = this.processes.get(instanceId);
    if (!managed) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const config = managed.config;
    await this.deprovision(instanceId);

    // Give the OS a moment to fully release the port after the child exits
    // (Linux/macOS sockets can linger briefly in TIME_WAIT even after close).
    // If the original port is still bound after the grace period, surface a
    // typed error so the manager can fall through to a fresh allocation
    // instead of letting the new spawn bind-fail and crash-loop.
    const host = '127.0.0.1';
    const stride = config.adapter === 'macro-agent' ? 3 : 1;
    for (let attempt = 0; attempt < 3; attempt++) {
      let allFree = true;
      for (let i = 0; i < stride; i++) {
        if (!(await isPortFree(config.assigned_port + i, host))) {
          allFree = false;
          break;
        }
      }
      if (allFree) break;
      if (attempt === 2) {
        throw new PortInUseError(config.assigned_port);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    return this.provision(config);
  }

  /** Mark health failure for an instance. Returns the new failure count. */
  recordHealthFailure(instanceId: string): number {
    const managed = this.processes.get(instanceId);
    if (!managed) return 0;
    managed.healthFailures++;
    return managed.healthFailures;
  }

  /** Reset health failure count (e.g. after successful health check) */
  resetHealthFailures(instanceId: string): void {
    const managed = this.processes.get(instanceId);
    if (managed) {
      managed.healthFailures = 0;
    }
  }

  /** Get the restart count for an instance */
  getRestartCount(instanceId: string): number {
    return this.processes.get(instanceId)?.restartCount ?? 0;
  }

  /** Increment the restart count for an instance */
  incrementRestartCount(instanceId: string): number {
    const managed = this.processes.get(instanceId);
    if (!managed) return 0;
    managed.restartCount++;
    return managed.restartCount;
  }

  /** Stop all managed processes (for server shutdown) */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.processes.keys());
    await Promise.all(ids.map((id) => this.deprovision(id)));
  }
}

/**
 * Resolve a `LogConfig.dir` value to a concrete file path.
 *   "tmp"      → ${os.tmpdir()}/openhive-swarm-logs/<hostedSwarmKey>.log
 *   "data_dir" → <dataDir>/openswarm.log
 *   absolute   → <dir>/<hostedSwarmKey>.log
 *
 * `hostedSwarmKey` is `basename(dataDir)` — OpenHive keeps `dataDir` stable
 * across restarts of the same hosted swarm (it's stored in `hosted.config`
 * and reused by `autoRestart`), so keying the log file by it guarantees
 * that multiple boots of the same swarm append to one file. Instance ids
 * rotate on every restart and would scatter the history across files.
 * Falls back to `instanceId` if `dataDir` lacks a usable basename.
 *
 * Exported for unit testing only.
 */
export function resolveLogPath(dir: string, dataDir: string, instanceId: string): string {
  const hostedSwarmKey = path.basename(path.resolve(dataDir)) || instanceId;
  if (dir === 'tmp') {
    return path.join(os.tmpdir(), 'openhive-swarm-logs', `${hostedSwarmKey}.log`);
  }
  if (dir === 'data_dir') {
    return path.join(dataDir, 'openswarm.log');
  }
  return path.join(dir, `${hostedSwarmKey}.log`);
}

/** Briefly bind-probe a port to see if it's free. */
function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Read the last N lines of a file without loading the whole thing into memory.
 * Used when the in-memory ring buffer is smaller than what the caller asked
 * for (e.g. right after a restart). Returns an empty array when the file
 * doesn't exist or can't be read.
 */
async function readTailLines(filePath: string, maxLines: number): Promise<string[]> {
  if (maxLines <= 0) return [];
  try {
    if (!fs.existsSync(filePath)) return [];
  } catch {
    return [];
  }

  return new Promise((resolve) => {
    const result: string[] = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      result.push(line);
      if (result.length > maxLines) result.shift();
    });
    rl.on('close', () => resolve(result));
    rl.on('error', () => resolve(result));
  });
}
