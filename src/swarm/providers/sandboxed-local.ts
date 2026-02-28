/**
 * Sandboxed Local Hosting Provider
 *
 * Extends the local sidecar provider with OS-level sandboxing via
 * @anthropic-ai/sandbox-runtime (bubblewrap on Linux, seatbelt on macOS).
 *
 * Swarm processes are restricted to:
 * - Only write to their own data directory
 * - Only reach allowed network domains
 * - Cannot read sensitive host paths (~/.ssh, ~/.gnupg, etc.)
 *
 * Falls back to unsandboxed local provider if sandbox dependencies
 * are missing (with a warning).
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
  SwarmSandboxPolicy,
} from '../types.js';
import { cloneWorkspaceRepos } from './workspace.js';

interface ManagedProcess {
  process: ChildProcess;
  config: SwarmProvisionConfig;
  startedAt: number;
  logBuffer: string[];
  healthFailures: number;
  restartCount: number;
  sandboxPolicy: SwarmSandboxPolicy | undefined;
}

/** Callback fired when a child process exits unexpectedly */
export type ProcessExitHandler = (
  instanceId: string,
  code: number | null,
  signal: string | null,
) => void;

const MAX_LOG_LINES = 1000;

/** Default paths that swarm processes should never read */
const DEFAULT_DENY_READ = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.config/gcloud',
  '~/.azure',
  '~/.kube',
];

/** Default paths that swarm processes should never write */
const DEFAULT_DENY_WRITE = [
  '~/.bashrc',
  '~/.zshrc',
  '~/.profile',
  '~/.gitconfig',
];

/**
 * Kill a process and its entire process tree.
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = child.pid;
  if (!pid) return false;

  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Check if sandbox-runtime dependencies are available on this system.
 */
function checkSandboxAvailability(): { available: boolean; warnings: string[] } {
  try {
    const { SandboxManager } = require('@anthropic-ai/sandbox-runtime') as typeof import('@anthropic-ai/sandbox-runtime');

    if (!SandboxManager.isSupportedPlatform()) {
      return {
        available: false,
        warnings: ['Sandbox runtime is not supported on this platform (requires Linux or macOS)'],
      };
    }

    const depCheck = SandboxManager.checkDependencies();
    if (depCheck.errors.length > 0) {
      return {
        available: false,
        warnings: depCheck.errors.map((e) => `Sandbox dependency missing: ${e}`),
      };
    }

    return { available: true, warnings: depCheck.warnings };
  } catch {
    return {
      available: false,
      warnings: ['@anthropic-ai/sandbox-runtime package not installed'],
    };
  }
}

export class SandboxedLocalProvider implements HostingProvider {
  readonly type = 'local-sandboxed' as const;

  private processes = new Map<string, ManagedProcess>();
  private openswarmCommand: string;
  private defaultPolicy: SwarmSandboxPolicy | undefined;
  private sandboxAvailable: boolean;

  /** Called when a managed process exits (for immediate crash detection) */
  onProcessExit: ProcessExitHandler | null = null;

  private exitHandler: () => void;

  constructor(
    openswarmCommand: string,
    defaultPolicy?: SwarmSandboxPolicy,
  ) {
    this.openswarmCommand = openswarmCommand;
    this.defaultPolicy = defaultPolicy;

    const { available, warnings } = checkSandboxAvailability();
    this.sandboxAvailable = available;

    if (!available) {
      for (const w of warnings) {
        console.warn(`[sandboxed-local] ${w}`);
      }
      console.warn('[sandboxed-local] Falling back to unsandboxed local provider');
    } else {
      console.log('[sandboxed-local] Sandbox runtime available');
    }

    this.exitHandler = () => {
      for (const [, managed] of this.processes) {
        if (managed.process.exitCode === null) {
          killProcessGroup(managed.process, 'SIGKILL');
        }
      }
    };
    process.on('exit', this.exitHandler);
  }

  /** Remove the process exit handler */
  removeExitHandler(): void {
    process.removeListener('exit', this.exitHandler);
  }

  /** Check if sandbox is available on this system */
  isSandboxAvailable(): boolean {
    return this.sandboxAvailable;
  }

  async provision(
    config: SwarmProvisionConfig,
    sandboxPolicy?: SwarmSandboxPolicy,
  ): Promise<ProvisionResult> {
    const instanceId = `sandbox_${Date.now()}_${config.assigned_port}`;

    // Ensure data directory exists
    const dataDir = path.resolve(config.data_dir);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Clone workspace repos before spawning the process
    if (config.workspace?.repos.length) {
      await cloneWorkspaceRepos(config.workspace, dataDir, process.env as Record<string, string>);
    }

    // Parse the command
    const parts = this.openswarmCommand.split(/\s+/);
    const bin = parts[0];
    const baseArgs = parts.slice(1);

    const args = [
      ...baseArgs,
      '--port', String(config.assigned_port),
      '--host', '127.0.0.1',
    ];

    if (config.adapter) {
      args.push('--adapter', config.adapter);
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

    // Merge sandbox policy: per-spawn overrides > default policy
    const effectivePolicy = sandboxPolicy ?? this.defaultPolicy;

    let child: ChildProcess;

    if (this.sandboxAvailable && effectivePolicy) {
      child = await this.spawnSandboxed(bin, args, env, dataDir, config.assigned_port, effectivePolicy);
    } else {
      // Unsandboxed fallback
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        cwd: dataDir,
        detached: true,
      });
    }

    const managed: ManagedProcess = {
      process: child,
      config,
      startedAt: Date.now(),
      logBuffer: [],
      healthFailures: 0,
      restartCount: 0,
      sandboxPolicy: effectivePolicy,
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
      this.onProcessExit?.(instanceId, code, signal);
    });

    child.on('error', (err) => {
      const entry = `[${new Date().toISOString()}] [system] Process error: ${err.message}`;
      managed.logBuffer.push(entry);
    });

    this.processes.set(instanceId, managed);

    // Wait a moment for the process to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (child.exitCode !== null) {
      const logs = managed.logBuffer.slice(-10).join('\n');
      throw new Error(
        `Sandboxed OpenSwarm process exited immediately (code=${child.exitCode}). ` +
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

  /**
   * Spawn a process wrapped with sandbox-runtime restrictions.
   *
   * Uses SandboxManager.wrapWithSandbox() to generate a wrapped command
   * that enforces filesystem and network restrictions at the OS level.
   */
  private async spawnSandboxed(
    bin: string,
    args: string[],
    env: Record<string, string>,
    dataDir: string,
    port: number,
    policy: SwarmSandboxPolicy,
  ): Promise<ChildProcess> {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
    const { SandboxRuntimeConfigSchema } = await import('@anthropic-ai/sandbox-runtime');

    // Build the sandbox-runtime config from our SwarmSandboxPolicy
    const srtConfig = SandboxRuntimeConfigSchema.parse({
      network: {
        allowedDomains: policy.allowed_domains ?? [],
        deniedDomains: policy.denied_domains ?? [],
        allowLocalBinding: policy.allow_local_binding ?? true,
      },
      filesystem: {
        denyRead: [
          ...(policy.deny_read ?? DEFAULT_DENY_READ),
        ],
        allowWrite: [
          dataDir,
          ...(policy.allow_write ?? []),
        ],
        denyWrite: [
          ...(policy.deny_write ?? DEFAULT_DENY_WRITE),
        ],
      },
      allowPty: policy.allow_pty ?? false,
    });

    // Initialize sandbox manager with this config
    await SandboxManager.initialize(srtConfig);

    // Build the full command string to wrap
    const fullCommand = `${bin} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;

    // Wrap the command with sandbox restrictions
    const wrappedCommand = await SandboxManager.wrapWithSandbox(fullCommand);

    console.log(`[sandboxed-local] Sandbox-wrapped command for port ${port}`);

    // Spawn the wrapped command through a shell
    const child = spawn('sh', ['-c', wrappedCommand], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: dataDir,
      detached: true,
    });

    // Clean up sandbox resources after the command finishes
    child.on('exit', () => {
      SandboxManager.cleanupAfterCommand();
    });

    return child;
  }

  async deprovision(instanceId: string): Promise<void> {
    const managed = this.processes.get(instanceId);
    if (!managed) return;

    const child = managed.process;

    if (child.exitCode === null) {
      killProcessGroup(child, 'SIGTERM');

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (child.exitCode === null) {
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
    const policy = managed.sandboxPolicy;
    await this.deprovision(instanceId);
    return this.provision(config, policy);
  }

  /** Mark health failure for an instance. Returns the new failure count. */
  recordHealthFailure(instanceId: string): number {
    const managed = this.processes.get(instanceId);
    if (!managed) return 0;
    managed.healthFailures++;
    return managed.healthFailures;
  }

  /** Reset health failure count */
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

  /** Stop all managed processes */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.processes.keys());
    await Promise.all(ids.map((id) => this.deprovision(id)));
  }
}
