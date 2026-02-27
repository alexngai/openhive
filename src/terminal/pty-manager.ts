/**
 * PTY Manager
 *
 * Manages pseudo-terminal sessions for web-based terminal access.
 * Each session spawns a PTY process and bridges it to a WebSocket connection.
 *
 * Adapted from references/swarmcraft/src/server/terminal/pty-manager.ts
 */

import { EventEmitter } from 'node:events';
// @ts-expect-error — @lydell/node-pty ships types but NodeNext can't resolve them
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { nanoid } from 'nanoid';

// =============================================================================
// Types
// =============================================================================

export interface TerminalSessionConfig {
  /** Command to run (defaults to user's shell) */
  command?: string;
  /** Command arguments */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Initial columns (default: 80) */
  cols?: number;
  /** Initial rows (default: 24) */
  rows?: number;
}

export type TerminalSessionStatus = 'running' | 'stopped' | 'failed';

export interface TerminalSessionInfo {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  status: TerminalSessionStatus;
  pid: number;
  createdAt: number;
  stoppedAt: number | null;
  exitCode: number | null;
}

interface TerminalSessionState {
  id: string;
  config: Required<Pick<TerminalSessionConfig, 'command' | 'args' | 'cwd' | 'cols' | 'rows'>>;
  ptyProcess: IPty;
  status: TerminalSessionStatus;
  createdAt: number;
  stoppedAt: number | null;
  exitCode: number | null;
}

/** Maximum number of concurrent terminal sessions */
const MAX_SESSIONS = 20;

// =============================================================================
// PTY Manager
// =============================================================================

export class PtyManager extends EventEmitter {
  private sessions: Map<string, TerminalSessionState> = new Map();

  /**
   * Create a new terminal session.
   */
  create(config: TerminalSessionConfig = {}): TerminalSessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum number of terminal sessions (${MAX_SESSIONS}) reached`);
    }

    const id = nanoid();
    const shell = config.command || process.env.SHELL || 'bash';
    const args = config.args || [];
    const cwd = config.cwd || process.env.HOME || process.cwd();
    const cols = config.cols || 80;
    const rows = config.rows || 24;

    const env = {
      ...process.env,
      ...config.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };

    const ptyProcess = ptySpawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env as Record<string, string>,
    });

    const state: TerminalSessionState = {
      id,
      config: { command: shell, args, cwd, cols, rows },
      ptyProcess,
      status: 'running',
      createdAt: Date.now(),
      stoppedAt: null,
      exitCode: null,
    };

    this.sessions.set(id, state);

    // Forward PTY data
    ptyProcess.onData((data: string) => {
      this.emit('session.data', { sessionId: id, data });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      state.status = 'stopped';
      state.stoppedAt = Date.now();
      state.exitCode = exitCode;

      this.emit('session.exit', { sessionId: id, exitCode, signal });
      console.log(`[terminal] Session ${id} exited: code=${exitCode}, signal=${signal}`);
    });

    this.emit('session.created', { sessionId: id, pid: ptyProcess.pid });
    console.log(`[terminal] Session ${id} created: ${shell} ${args.join(' ')}, PID=${ptyProcess.pid}`);

    return this.getInfo(id)!;
  }

  /**
   * Write data to a terminal session (user input).
   */
  write(sessionId: string, data: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Terminal session ${sessionId} not found`);
    }
    if (state.status !== 'running') {
      throw new Error(`Terminal session ${sessionId} is not running`);
    }

    state.ptyProcess.write(data);
  }

  /**
   * Resize a terminal session.
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Terminal session ${sessionId} not found`);
    }
    if (state.status !== 'running') return;

    state.ptyProcess.resize(cols, rows);
    state.config.cols = cols;
    state.config.rows = rows;

    this.emit('session.resized', { sessionId, cols, rows });
  }

  /**
   * Destroy a terminal session.
   */
  destroy(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Terminal session ${sessionId} not found`);
    }

    if (state.status === 'running') {
      state.ptyProcess.kill();
      state.status = 'stopped';
      state.stoppedAt = Date.now();
    }

    this.sessions.delete(sessionId);
    this.emit('session.destroyed', { sessionId });
    console.log(`[terminal] Session ${sessionId} destroyed`);
  }

  /**
   * List all terminal sessions.
   */
  list(): TerminalSessionInfo[] {
    return Array.from(this.sessions.keys())
      .map((id) => this.getInfo(id))
      .filter((info): info is TerminalSessionInfo => info !== null);
  }

  /**
   * Get info about a specific terminal session.
   */
  getInfo(sessionId: string): TerminalSessionInfo | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;

    return {
      id: state.id,
      command: state.config.command,
      args: state.config.args,
      cwd: state.config.cwd,
      cols: state.config.cols,
      rows: state.config.rows,
      status: state.status,
      pid: state.ptyProcess.pid,
      createdAt: state.createdAt,
      stoppedAt: state.stoppedAt,
      exitCode: state.exitCode,
    };
  }

  /**
   * Destroy all sessions (for graceful shutdown).
   */
  destroyAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      try {
        this.destroy(id);
      } catch {
        // Ignore errors during shutdown
      }
    }
  }
}
