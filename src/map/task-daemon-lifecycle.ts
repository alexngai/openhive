/**
 * OpenTasks Daemon Lifecycle Management
 *
 * Health checks and auto-start for the OpenTasks daemon.
 * Pattern adapted from claude-code-swarm's ensureDaemon().
 */

import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Resolve the daemon socket path for an .opentasks directory.
 * Inlined here to avoid circular import with task-daemon-client.
 */
function resolveDaemonSocket(opentasksDir: string): string {
  const configPath = join(opentasksDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.daemon?.socketPath) return config.daemon.socketPath;
    } catch { /* fall through */ }
  }
  return join(opentasksDir, 'daemon.sock');
}

/**
 * Send a raw JSON-RPC ping to a Unix socket.
 * Returns true if the daemon responds, false otherwise. Never throws.
 */
export function isDaemonAlive(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const id = randomUUID();
    const request = JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: {} }) + '\n';

    let buffer = '';
    const client = net.createConnection(socketPath, () => {
      client.write(request);
    });

    client.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id === id) {
            clearTimeout(timer);
            client.destroy();
            resolve(response.error == null);
            return;
          }
        } catch { /* incomplete JSON */ }
      }
    });

    client.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });

    const timer = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, timeoutMs);
    timer.unref();
  });
}

/**
 * Ensure the OpenTasks daemon is running for the given .opentasks directory.
 * If not alive, spawns `opentasks daemon start` and waits up to 3s.
 * Returns true if daemon is available, false if start failed.
 * Never throws.
 */
export async function ensureDaemon(opentasksDir: string): Promise<boolean> {
  const socketPath = resolveDaemonSocket(opentasksDir);

  // Already alive?
  if (await isDaemonAlive(socketPath)) return true;

  // Try to start
  try {
    mkdirSync(opentasksDir, { recursive: true });

    const child = spawn('opentasks', ['daemon', 'start'], {
      cwd: opentasksDir,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env },
    });
    child.unref();

    // Collect stderr briefly for diagnostics
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Poll for socket readiness (up to 3s)
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await isDaemonAlive(socketPath)) return true;
    }

    if (stderr) {
      console.warn('[task-daemon] daemon start stderr:', stderr.trim());
    }
  } catch (err) {
    console.error('[task-daemon] failed to start daemon:', (err as Error).message);
  }

  return false;
}
