/**
 * Electron supervisor (main process).
 *
 * Owns no hive state — manages windows and forks one Node child process
 * per hive (via node:child_process.fork against the Electron binary with
 * ELECTRON_RUN_AS_NODE=1, see electron/hive-child.ts). Each hive lives in
 * its own Node process with its own module scope, so OpenHive's singleton
 * state (db, jwks, storage) doesn't collide across hives.
 */
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
} from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Preallocate an OS-chosen free port before the hive child boots.
 * We can't pass `port: 0` because OpenHive's SwarmManager reads
 * `config.port` at createHive() time — long before fastify.listen() assigns
 * a real port — and bakes that stale value into every hosted-swarm
 * bootstrap token as the openhive_url. Any coordinator then tries to call
 * back to `http://127.0.0.1:0` and fails.
 *
 * Small race: between the probe closing its socket and the hive binding,
 * another process could steal the port. Acceptable for a dev-loop tool.
 * Proper fix belongs server-side (update instanceUrl after listen() with
 * the bound port). Track as follow-up.
 */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('pickFreePort: address() returned non-object'));
      }
    });
    srv.on('error', reject);
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Swallow EPIPE on stderr/stdout — when the app is launched from Finder
// or the Dock (packaged) macOS wires process.stderr to a dead pipe, and
// any plain console.log / .error would otherwise throw an uncaught EPIPE
// that crashes the supervisor before the window opens.
for (const s of [process.stderr, process.stdout]) {
  s.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err;
  });
}

// Force app name/userData path before any app API use. Electron falls back
// to "Electron" when it can't find name metadata via its usual lookup
// (happens with `electron <script>` invocations in dev).
app.setName('OpenHive');

// Dev-only: expose Chromium's remote debugging protocol so tools like
// chrome://inspect or chrome-devtools-mcp can attach directly to the
// renderer. Set OPENHIVE_REMOTE_DEBUG=<port> (e.g. 9223) to enable.
if (process.env.OPENHIVE_REMOTE_DEBUG) {
  app.commandLine.appendSwitch(
    'remote-debugging-port',
    process.env.OPENHIVE_REMOTE_DEBUG,
  );
}

interface HiveEntry {
  child: ChildProcess;
  window: BrowserWindow;
  dataDir: string;
  url: string;
  overrides: Record<string, unknown>;
}

type ChildMessage =
  | { type: 'ready'; url: string }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'log'; level: string; msg: string };

const hives = new Map<string, HiveEntry>();

// ── Single-instance lock ──────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const first = hives.values().next().value;
    if (first?.window) {
      if (first.window.isMinimized()) first.window.restore();
      first.window.focus();
    }
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    await spawnHive(app.getPath('userData'));
  } catch (err) {
    dialog.showErrorBox(
      'OpenHive failed to start',
      (err as Error).message,
    );
    app.quit();
    return;
  }
  Menu.setApplicationMenu(buildMenu());

  // Auto-update: only in packaged builds. Skipped on `electron .` dev
  // launches (app.isPackaged === false). Publish destination is declared
  // in package.json's `build.publish` (GitHub Releases); electron-updater
  // reads the same config to know where to check.
  if (app.isPackaged) {
    try {
      const { autoUpdater } = await import('electron-updater');
      autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => {
        console.warn(`[supervisor] auto-update check failed: ${err.message}`);
      });
    } catch (err) {
      console.warn(
        `[supervisor] auto-update unavailable: ${(err as Error).message}`,
      );
    }
  }
});

app.on('activate', async () => {
  if (hives.size === 0 && app.isReady()) {
    await spawnHive(app.getPath('userData')).catch(() => { /* already surfaced */ });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (hives.size === 0) return;
  e.preventDefault();
  await Promise.allSettled(
    [...hives.values()].map(({ child }) =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.send({ type: 'stop' });
        setTimeout(() => { child.kill(); resolve(); }, 3000);
      }),
    ),
  );
  hives.clear();
  app.exit(0);
});

// ── Hive lifecycle ────────────────────────────────────────────────────
async function spawnHive(
  dataDir: string,
  overrides: Record<string, unknown> = {},
): Promise<HiveEntry> {
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const logPath = path.join(dataDir, 'logs', 'hive.log');

  const childEntry = path.join(__dirname, 'hive-child.js');
  // Use node:child_process.fork rather than Electron's utilityProcess.
  // utilityProcess runs in a restricted Node environment that refuses to
  // load several native modules OpenHive requires (notably better-sqlite3).
  // A standard child_process.fork spawning the Electron binary with
  // ELECTRON_RUN_AS_NODE=1 gives us a plain Node runtime (Electron's
  // embedded Node) with full native-module compatibility.
  const child = fork(childEntry, [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  // Pipe child stdio into the per-hive log file. Also echo to the
  // supervisor's stderr during dev (invisible in packaged builds, but
  // useful from a terminal launch). Writes are wrapped: packaged Electron
  // apps launched from Finder/Dock inherit a closed/unavailable stderr
  // pipe, and the raw `process.stderr.write` throws EPIPE, which as an
  // uncaught exception takes down the supervisor before the BrowserWindow
  // opens.
  const writeStream = fs.createWriteStream(logPath, { flags: 'a' });
  writeStream.on('error', () => { /* disk full / rotation — keep running */ });
  const teeWrite = (buf: Buffer) => {
    try { writeStream.write(buf); } catch { /* ignore */ }
    try { process.stderr.write(buf); } catch { /* EPIPE etc — ignore */ }
  };
  child.stdout?.on('data', teeWrite);
  child.stderr?.on('data', teeWrite);

  const port = await pickFreePort();

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('hive boot timeout (60s)')),
      60_000,
    );
    child.on('message', (msg: ChildMessage) => {
      if (msg.type === 'ready') {
        clearTimeout(timer);
        resolve(msg.url);
      } else if (msg.type === 'error' && msg.fatal) {
        clearTimeout(timer);
        reject(new Error(msg.message));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`hive-child exited before ready (code ${code})`));
    });
    child.send({
      type: 'start',
      config: { dataDir, host: '127.0.0.1', port, ...overrides },
    });
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await window.loadURL(url);

  const entry: HiveEntry = { child, window, dataDir, url, overrides };
  hives.set(dataDir, entry);

  window.on('closed', () => {
    const existing = hives.get(dataDir);
    if (existing?.child.pid && !existing.child.killed) {
      existing.child.send({ type: 'stop' });
    }
    hives.delete(dataDir);
  });

  child.on('exit', (code) => {
    const stillTracked = hives.get(dataDir);
    // User-initiated close already deleted the entry; don't show crash dialog.
    if (!stillTracked) return;
    hives.delete(dataDir);
    if (code === 0 || window.isDestroyed()) return;

    dialog
      .showMessageBox(window, {
        type: 'error',
        title: 'Hive crashed',
        message: `Hive at ${dataDir} exited (code ${code}). See ${logPath} for details.`,
        buttons: ['Restart', 'Close'],
      })
      .then((r) => {
        if (r.response === 0) void spawnHive(dataDir, overrides);
        else if (!window.isDestroyed()) window.close();
      })
      .catch(() => { /* dialog dismissed */ });
  });

  return entry;
}

/** Kill the current hive-child and boot a fresh one with new config. */
export async function restartHive(
  dataDir: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const existing = hives.get(dataDir);
  if (!existing) return;
  const { window } = existing;
  existing.child.kill();
  hives.delete(dataDir);

  const next = await spawnHive(dataDir, overrides);
  if (!window.isDestroyed()) {
    await window.loadURL(next.url);
  }
}

// ── Menu ──────────────────────────────────────────────────────────────

/**
 * Manual update check — menu-item driven. `checkForUpdatesAndNotify` on
 * app-ready handles the passive path; this one surfaces "you're on the
 * latest version" / "checking now…" for users who want to force it.
 *
 * No-op in dev launches (app.isPackaged=false) — electron-updater refuses
 * to run there anyway; we present a friendly message rather than an error.
 */
async function manualCheckForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Updates are only checked in packaged builds.',
      detail: 'Run from a signed .dmg or AppImage to enable auto-update.',
    });
    return;
  }
  try {
    const { autoUpdater } = await import('electron-updater');
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    if (!latest || latest === app.getVersion()) {
      await dialog.showMessageBox({
        type: 'info',
        message: `You're on the latest version (${app.getVersion()}).`,
      });
    }
    // If a newer version exists, electron-updater downloads in the
    // background and fires its own native "ready to install" notification
    // via the update-downloaded event. No further UI needed here.
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      message: 'Update check failed',
      detail: (err as Error).message,
    });
  }
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      // Override the default appMenu so we can inject "Check for Updates…"
      // near the top — matches the macOS convention for About / Preferences.
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => { void manualCheckForUpdates(); } },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Hive',
      submenu: [
        {
          label: 'New Hive…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: async () => {
            const r = await dialog.showOpenDialog({
              properties: ['openDirectory', 'createDirectory'],
              title: 'Choose a folder for the new hive',
            });
            if (r.canceled || !r.filePaths[0]) return;
            const dataDir = r.filePaths[0];
            if (hives.has(dataDir)) {
              hives.get(dataDir)!.window.focus();
              return;
            }
            try {
              await spawnHive(dataDir);
            } catch (err) {
              dialog.showErrorBox('Could not open hive', (err as Error).message);
            }
          },
        },
      ],
    },
    { role: 'windowMenu' },
  ]);
}
