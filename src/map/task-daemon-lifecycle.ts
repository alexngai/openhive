/**
 * OpenTasks Daemon Lifecycle Management
 *
 * Health checks and auto-start for the OpenTasks daemon.
 * The daemon is the single source of truth for task graphs.
 * OpenHive auto-starts it on first query if not running.
 */

import * as net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, basename, dirname, resolve, relative } from 'node:path';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';

// ============================================================================
// Socket Resolution
// ============================================================================

/**
 * Resolve the daemon socket path for an .opentasks directory.
 * Inlined here to avoid circular import with task-daemon-client.
 */
export function resolveDaemonSocket(opentasksDir: string): string {
  const configPath = join(opentasksDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.daemon?.socketPath) return config.daemon.socketPath;
    } catch { /* fall through */ }
  }

  // Check standard location
  const directSocket = join(opentasksDir, 'daemon.sock');
  if (existsSync(directSocket)) return directSocket;

  // Check nested .opentasks/daemon.sock
  const nestedSocket = join(opentasksDir, '.opentasks', 'daemon.sock');
  if (existsSync(nestedSocket)) return nestedSocket;

  // Check .git/opentasks/daemon.sock — multi-location daemon (opentasks >= 0.1.0)
  // walks up from opentasksDir to find the git root
  const projectRoot = resolveProjectRoot(opentasksDir);
  const gitSocket = join(projectRoot, '.git', 'opentasks', 'daemon.sock');
  if (existsSync(gitSocket)) return gitSocket;

  return directSocket;
}

/**
 * Resolve the project root (cwd for daemon start) from an opentasks directory.
 * The daemon expects to run from the project root (parent of .opentasks/).
 */
function resolveProjectRoot(opentasksDir: string): string {
  const resolved = resolve(opentasksDir);
  // If the dir IS .opentasks, use its parent
  if (basename(resolved) === '.opentasks') return dirname(resolved);
  // If the dir contains .opentasks, it's already the project root
  if (existsSync(join(resolved, '.opentasks'))) return resolved;
  // Otherwise use the dir itself
  return resolved;
}

// ============================================================================
// Health Check
// ============================================================================

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

// ============================================================================
// Auto-Start
// ============================================================================

/**
 * Generate a deterministic 8-char location hash.
 * Mirrors opentasks' generateLocationIdentity logic.
 */
function generateLocationHash(opentasksDir: string): string {
  const parentDir = dirname(resolve(opentasksDir));
  let seed = resolve(opentasksDir);

  // Try to use git remote URL for a stable, portable hash
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { cwd: parentDir, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    const remoteUrl = execSync('git remote get-url origin', { cwd: gitRoot, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    if (remoteUrl) {
      const relativePath = relative(gitRoot, parentDir) || '.';
      seed = `${remoteUrl}:${relativePath}`;
    }
  } catch { /* no git or no remote — use path */ }

  const hash = createHash('sha256').update(seed).digest();
  // Base36 encode first 5 bytes → 8 chars
  let result = '';
  for (let i = 0; i < 5 && result.length < 8; i++) {
    result += hash[i].toString(36).padStart(2, '0');
  }
  return result.slice(0, 8);
}

/**
 * Ensure the .opentasks directory is fully initialized (equivalent to `opentasks init`).
 * Creates config.json with location identity, graph.jsonl, and .gitignore.
 *
 * If extraConfig is provided (from resource metadata.opentasks_config),
 * it's merged into the generated config.json.
 */
export function ensureInitialized(opentasksDir: string, extraConfig?: Record<string, unknown>): void {
  mkdirSync(opentasksDir, { recursive: true });

  const configPath = join(opentasksDir, 'config.json');
  if (!existsSync(configPath)) {
    const locationName = basename(dirname(resolve(opentasksDir))) || 'default';
    const config: Record<string, unknown> = {
      version: '1.0',
      location: {
        hash: generateLocationHash(opentasksDir),
        uuid: randomUUID(),
        name: locationName,
      },
      ...extraConfig,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  const graphPath = join(opentasksDir, 'graph.jsonl');
  if (!existsSync(graphPath)) {
    writeFileSync(graphPath, '');
  }

  const gitignorePath = join(opentasksDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, [
      'cache.db', 'cache.db-wal', 'cache.db-shm',
      'write.lock', 'daemon.sock', 'daemon.lock', '',
    ].join('\n'));
  }
}

/**
 * Ensure the OpenTasks daemon is running for the given .opentasks directory.
 * If not alive, initializes the directory if needed and spawns the daemon.
 * Returns true if daemon is available, false if start failed.
 * Never throws.
 */
export async function ensureDaemon(opentasksDir: string): Promise<boolean> {
  // Resolve the actual .opentasks directory
  const resolved = resolve(opentasksDir);
  const otDir = basename(resolved) === '.opentasks'
    ? resolved
    : existsSync(join(resolved, '.opentasks'))
      ? join(resolved, '.opentasks')
      : resolved;

  const projectRoot = resolveProjectRoot(otDir);
  let socketPath = resolveDaemonSocket(otDir);

  // Already alive?
  if (await isDaemonAlive(socketPath)) return true;

  // Also check .git/opentasks/ — multi-location daemon may be running there
  const gitSocket = join(projectRoot, '.git', 'opentasks', 'daemon.sock');
  if (gitSocket !== socketPath && existsSync(gitSocket) && await isDaemonAlive(gitSocket)) {
    return true;
  }

  // Ensure the directory is initialized
  try {
    ensureInitialized(otDir);
  } catch (err) {
    console.warn('[task-daemon] failed to initialize .opentasks dir:', (err as Error).message);
    return false;
  }

  // Start the daemon.
  //
  // Resolve the `opentasks` bin via require.resolve and invoke it through
  // process.execPath so this works inside Electron (where the package lives
  // in the asar but isn't on $PATH). In plain Node process.execPath === node,
  // so behavior is identical to `node <bin>`. Fall back to a $PATH lookup if
  // the package isn't resolvable (e.g. dev without the dep linked).
  let daemonBin = 'opentasks';
  let daemonArgs = ['daemon', 'start'];
  const daemonEnv: Record<string, string> = { ...(process.env as Record<string, string>) };

  try {
    const require_ = createRequire(import.meta.url);
    const pkgJsonPath = require_.resolve('opentasks/package.json');
    const pkgDir = dirname(pkgJsonPath);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
      bin?: string | Record<string, string>;
    };
    const binField = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.opentasks;
    if (binField) {
      daemonBin = process.execPath;
      daemonArgs = [resolve(pkgDir, binField), 'daemon', 'start'];
      daemonEnv.ELECTRON_RUN_AS_NODE = '1';
    }
  } catch {
    // fall through to $PATH-based lookup
  }

  try {
    const child = spawn(daemonBin, daemonArgs, {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: daemonEnv,
    });
    child.unref();

    // Collect stderr for diagnostics
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Poll for socket readiness (up to 5s — first start can be slow)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));

      // Re-resolve socket path after daemon starts (it may have created config)
      if (i === 4) {
        socketPath = resolveDaemonSocket(otDir);
      }

      if (await isDaemonAlive(socketPath)) return true;
    }

    if (stderr) {
      console.warn(`[task-daemon] daemon start stderr (cwd: ${projectRoot}):`, stderr.trim());
    } else {
      console.warn(`[task-daemon] daemon did not become ready within 5s (socket: ${socketPath}, cwd: ${projectRoot})`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('ENOENT')) {
      console.warn('[task-daemon] opentasks CLI not found in PATH — cannot auto-start daemon');
    } else {
      console.error('[task-daemon] failed to start daemon:', msg);
    }
  }

  return false;
}
