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
import { fileURLToPath } from 'node:url';
import { join, basename, dirname, resolve, relative } from 'node:path';
import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';

// ============================================================================
// Socket Resolution
// ============================================================================

/**
 * Resolve the git "common dir" for a directory — a faithful mirror of
 * opentasks' `getGitCommonDir`. Uses `git rev-parse --git-common-dir` so it is
 * correct across project structures: normal repos, linked worktrees (returns
 * the shared common dir, not the per-worktree gitdir), submodules, and nested
 * paths. Returns null outside a git repo. Keeping this identical to opentasks
 * is what makes the socket resolution below match the daemon in every layout,
 * not just the current checkout.
 */
function getGitCommonDir(cwd: string): string | null {
  try {
    const out = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return resolve(cwd, out);
  } catch {
    return null;
  }
}

/**
 * Where the opentasks daemon binds its socket for a given `.opentasks` dir —
 * a mirror of opentasks' `daemonHomeFor`. Inside a git repo the daemon runs in
 * multi-location mode under `<git-common-dir>/opentasks`; otherwise it runs
 * single-location in the `.opentasks` dir itself. Kept in lockstep with
 * opentasks so OpenHive probes exactly where the daemon listens.
 */
export function daemonHomeFor(opentasksDir: string): string {
  const gitCommonDir = getGitCommonDir(dirname(opentasksDir));
  return gitCommonDir ? join(gitCommonDir, 'opentasks') : opentasksDir;
}

/**
 * Resolve the daemon socket path for an .opentasks directory.
 * Inlined here to avoid circular import with task-daemon-client.
 */
export function resolveDaemonSocket(opentasksDir: string): string {
  // An explicit config override always wins.
  const configPath = join(opentasksDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.daemon?.socketPath) return config.daemon.socketPath;
    } catch { /* fall through */ }
  }

  // Callers pass either the `.opentasks` dir or the project root that contains
  // it — normalize to the `.opentasks` dir for the home computation.
  const resolved = resolve(opentasksDir);
  const otDir = basename(resolved) === '.opentasks'
    ? resolved
    : existsSync(join(resolved, '.opentasks'))
      ? join(resolved, '.opentasks')
      : resolved;

  // Inside a git repo the daemon runs multi-location under
  // `<git-common-dir>/opentasks` (mirrors opentasks' daemonHomeFor). Resolve
  // there *deterministically* — even before the daemon has started — otherwise
  // we'd probe the plain `.opentasks/daemon.sock` and miss the running daemon,
  // reporting "daemon not ready" though it is listening.
  const home = daemonHomeFor(otDir);
  if (home !== otDir) return join(home, 'daemon.sock');

  // Single-location (non-git): prefer an already-existing socket, else default.
  const directSocket = join(opentasksDir, 'daemon.sock');
  if (existsSync(directSocket)) return directSocket;
  const nestedSocket = join(opentasksDir, '.opentasks', 'daemon.sock');
  if (existsSync(nestedSocket)) return nestedSocket;
  return directSocket;
}

/**
 * Maximum usable byte length of a Unix-domain socket path on this platform.
 *
 * The kernel's `sockaddr_un.sun_path` is a fixed-size buffer and the path must
 * be NUL-terminated, so the usable length is one byte less than the buffer:
 *   - macOS / *BSD: `sun_path` is 104 bytes → 103 usable
 *   - Linux:        `sun_path` is 108 bytes → 107 usable
 *   - Windows:      named pipes, not `sun_path` → no comparable limit
 *
 * Over the limit the kernel silently truncates the path on `bind()`, which
 * collides otherwise-distinct daemons onto a single socket file and surfaces as
 * a bogus `EADDRINUSE` — or an unreachable daemon that "never becomes ready".
 * This is the most common "daemon won't start" gotcha for deeply-nested
 * checkouts, and the raw failure gives no hint why.
 */
export function maxUnixSocketPathBytes(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return Number.POSITIVE_INFINITY; // named pipes, not sun_path
  if (platform === 'linux') return 107;
  return 103; // darwin, *bsd, and a conservative default for unknown unix
}

/**
 * Returns a clear, actionable message if `socketPath` is too long to bind on
 * this platform, or `null` if it fits. Applied before we probe or spawn the
 * daemon so an unbindable path fails fast with a diagnosis instead of the
 * cryptic `EADDRINUSE` / readiness-timeout the OS truncation would otherwise
 * produce.
 *
 * Note the offending path is fixed by *where the checkout lives*, not something
 * OpenHive can rewrite: inside a git repo opentasks binds
 * `<git-common-dir>/opentasks/daemon.sock` (multi-location) and ignores any
 * configured socket filename, so the only remedy is a shorter path on disk.
 */
export function diagnoseSocketPathLength(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const limit = maxUnixSocketPathBytes(platform);
  const len = Buffer.byteLength(socketPath, 'utf8');
  if (len <= limit) return null;
  return [
    `[task-daemon] socket path is ${len} bytes but ${platform} allows at most ${limit} — ` +
      `the OS truncates longer paths on bind(), which surfaces as a bogus EADDRINUSE or a ` +
      `daemon that never becomes ready.`,
    `  path: ${socketPath}`,
    `  Fix: point the hub's data dir / task graph at a shorter absolute path (e.g. a short ` +
      `root like ~/oh or /tmp/oh), or run the hub from a less deeply-nested checkout.`,
  ].join('\n');
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
 * Resolve the absolute path to the `opentasks` CLI entry (`dist/cli.js`).
 *
 * We deliberately do NOT use `require.resolve('opentasks/package.json')` or
 * `require.resolve('opentasks')`: the package ships an ESM-only `exports` map
 * (`"."` → `import` only, no `./package.json` subpath), so under the bundled
 * server's CJS `createRequire` both throw `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 * That silently fell back to spawning a bare `opentasks` (not on `$PATH` in the
 * production image) → ENOENT → auto-start always failed. Instead, walk up
 * `node_modules` from this module and read the package's own `bin` field
 * directly off disk. Works identically in dev (`src/`) and the Docker image
 * (`/app/dist` + `/app/node_modules`). Returns null if not locatable.
 */
export function resolveOpentasksCliPath(): string | null {
  let cur = dirname(fileURLToPath(import.meta.url));
  // Walk up to the filesystem root, checking <dir>/node_modules/opentasks.
  for (;;) {
    const pkgDir = join(cur, 'node_modules', 'opentasks');
    const pkgJson = join(pkgDir, 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8')) as {
          bin?: string | Record<string, string>;
        };
        const binField = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.opentasks;
        if (binField) return resolve(pkgDir, binField);
      } catch { /* malformed — keep walking */ }
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** signal-0 liveness probe — true if a process with `pid` exists. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reap a stale opentasks daemon lock so auto-start doesn't fail with `ELOCKED`
 * for ~10s after an ungraceful shutdown (e.g. SIGKILL on container restart).
 *
 * opentasks locks each location with proper-lockfile: a JSON content file
 * `daemon.lock` (carries the holder pid) plus proper-lockfile's own
 * `daemon.lock.lock` directory. On a clean release both are removed; on a hard
 * kill the `.lock` dir lingers and proper-lockfile only treats it as stale
 * after its 10s window — and opentasks acquires with `retries: 0`, so the next
 * daemon throws `LOCK_HELD` immediately and auto-start fails until the window
 * elapses.
 *
 * Callers invoke this only after confirming the socket is dead, so any lock
 * found here is genuinely orphaned. We still re-check the content file's pid to
 * avoid racing a daemon that's actively starting. Never throws.
 */
export function reapStaleDaemonLock(lockDir: string): void {
  const contentLock = join(lockDir, 'daemon.lock');
  const properLock = join(lockDir, 'daemon.lock.lock');
  if (!existsSync(contentLock) && !existsSync(properLock)) return;

  // If a live process still owns the content lock, leave everything alone —
  // it's a real daemon mid-startup, not an orphan.
  if (existsSync(contentLock)) {
    try {
      const { pid } = JSON.parse(readFileSync(contentLock, 'utf-8')) as { pid?: number };
      if (typeof pid === 'number' && isProcessAlive(pid)) return;
    } catch { /* unreadable/malformed — treat as stale */ }
  }

  try { rmSync(properLock, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(contentLock, { force: true }); } catch { /* ignore */ }
  console.warn(`[task-daemon] reaped stale daemon lock in ${lockDir}`);
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

  // Fail fast on an unbindable socket path. A path longer than the platform's
  // `sun_path` limit is truncated by the kernel on bind(), so the daemon can
  // never be reached — probing and spawning would just burn the 5s readiness
  // window and report a cryptic timeout. Surface the real cause instead.
  const pathProblem = diagnoseSocketPathLength(socketPath);
  if (pathProblem) {
    console.error(pathProblem);
    return false;
  }

  // Already alive? `socketPath` now resolves via daemonHomeFor, so it already
  // points at the multi-location `<git-common-dir>/opentasks` socket in a git
  // repo — no separate git-socket probe needed.
  if (await isDaemonAlive(socketPath)) return true;

  // Ensure the directory is initialized
  try {
    ensureInitialized(otDir);
  } catch (err) {
    console.warn('[task-daemon] failed to initialize .opentasks dir:', (err as Error).message);
    return false;
  }

  // The socket is confirmed dead above, so any daemon lock left behind is
  // orphaned (typically from a SIGKILLed container). Reap it now so the spawn
  // below doesn't hit proper-lockfile's ~10s ELOCKED window. Check every
  // candidate location dir; the Set dedups when they coincide.
  // dirname(socketPath) is the resolved daemon home (git-common-dir or the
  // .opentasks dir), so it already covers the multi-location case.
  for (const dir of new Set([
    otDir,
    dirname(socketPath),
  ])) {
    reapStaleDaemonLock(dir);
  }

  // Start the daemon.
  //
  // Resolve the `opentasks` bin off disk (see resolveOpentasksCliPath — the
  // package's exports map makes require.resolve unusable) and invoke it through
  // process.execPath so this works inside Electron (where the package lives in
  // the asar but isn't on $PATH) and the production Docker image (where
  // `opentasks` is likewise not on $PATH). In plain Node process.execPath ===
  // node, so behavior is identical to `node <bin>`. Fall back to a $PATH lookup
  // only if the package isn't locatable (e.g. dev without the dep linked).
  let daemonBin = 'opentasks';
  let daemonArgs = ['daemon', 'start'];
  const daemonEnv: Record<string, string> = { ...(process.env as Record<string, string>) };

  const cliPath = resolveOpentasksCliPath();
  if (cliPath) {
    daemonBin = process.execPath;
    daemonArgs = [cliPath, 'daemon', 'start'];
    daemonEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  try {
    const child = spawn(daemonBin, daemonArgs, {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: daemonEnv,
    });
    child.unref();

    // A failed spawn (e.g. `opentasks` not on PATH) surfaces as an async
    // 'error' event, NOT a synchronous throw. Without a listener Node treats
    // it as an unhandled 'error' and crashes the whole hub. Swallow it here —
    // the readiness poll below will simply time out and we return false.
    let spawnError: Error | null = null;
    child.on('error', (err: Error) => { spawnError = err; });

    // Collect stderr for diagnostics
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Poll for socket readiness (up to 5s — first start can be slow)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));

      // Bail early if the spawn itself failed (e.g. binary not found).
      if (spawnError) {
        const msg = (spawnError as Error).message;
        if (msg.includes('ENOENT')) {
          console.warn('[task-daemon] opentasks CLI not found — cannot auto-start daemon');
        } else {
          console.error('[task-daemon] failed to start daemon:', msg);
        }
        return false;
      }

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
