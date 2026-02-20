/**
 * Local Sidecar Hosting Provider
 *
 * Spawns OpenSwarm instances as child processes on the same host.
 * Follows the same pattern as HeadscaleManager (src/headscale/manager.ts).
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  HostingProvider,
  SwarmProvisionConfig,
  ProvisionResult,
  InstanceStatus,
  LogOptions,
  HostedSwarmState,
} from '../types.js';

interface ManagedProcess {
  process: ChildProcess;
  config: SwarmProvisionConfig;
  startedAt: number;
  logBuffer: string[];
  healthFailures: number;
  restartCount: number;
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

  /** Called when a managed process exits (for immediate crash detection) */
  onProcessExit: ProcessExitHandler | null = null;

  private exitHandler: () => void;

  constructor(openswarmCommand: string) {
    this.openswarmCommand = openswarmCommand;

    // Safety net: synchronously kill all child process trees if the parent
    // exits before async shutdown completes (e.g. tsx force-kill, double Ctrl+C)
    this.exitHandler = () => {
      for (const [, managed] of this.processes) {
        if (managed.process.exitCode === null) {
          killProcessGroup(managed.process, 'SIGKILL');
        }
      }
    };
    process.on('exit', this.exitHandler);
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

    // Parse the command (could be 'npx openswarm', 'node /path/to/bin', etc.)
    const parts = this.openswarmCommand.split(/\s+/);
    const bin = parts[0];
    const baseArgs = parts.slice(1);

    // Build args for OpenSwarm's hosting server
    const args = [
      ...baseArgs,
      '--port', String(config.assigned_port),
      '--host', '127.0.0.1',
    ];

    if (config.adapter) {
      args.push('--adapter', config.adapter);
    }

    // Pass bootstrap token as env var
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENSWARM_BOOTSTRAP_TOKEN: config.bootstrap_token,
      OPENSWARM_DATA_DIR: dataDir,
    };

    // Spawn as a new process group leader (detached: true) so we can
    // kill the entire tree (openswarm + its subprocesses) via -pid.
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: dataDir,
      detached: true,
    });

    const managed: ManagedProcess = {
      process: child,
      config,
      startedAt: Date.now(),
      logBuffer: [],
      healthFailures: 0,
      restartCount: 0,
    };

    // Capture stdout/stderr into ring buffer
    const appendLog = (data: Buffer, stream: string) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        const entry = `[${new Date().toISOString()}] [${stream}] ${line}`;
        managed.logBuffer.push(entry);
        if (managed.logBuffer.length > MAX_LOG_LINES) {
          managed.logBuffer.shift();
        }
      }
    };

    child.stdout?.on('data', (data: Buffer) => appendLog(data, 'stdout'));
    child.stderr?.on('data', (data: Buffer) => appendLog(data, 'stderr'));

    child.on('exit', (code, signal) => {
      const entry = `[${new Date().toISOString()}] [system] Process exited (code=${code}, signal=${signal})`;
      managed.logBuffer.push(entry);

      // Notify the manager immediately about the exit
      this.onProcessExit?.(instanceId, code, signal);
    });

    child.on('error', (err) => {
      const entry = `[${new Date().toISOString()}] [system] Process error: ${err.message}`;
      managed.logBuffer.push(entry);
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
          resolve();
        }, 5000);

        child.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

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
    if (!managed) return '(no logs — instance not found)';

    let lines = managed.logBuffer;

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

  async restart(instanceId: string): Promise<ProvisionResult> {
    const managed = this.processes.get(instanceId);
    if (!managed) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const config = managed.config;
    await this.deprovision(instanceId);
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
