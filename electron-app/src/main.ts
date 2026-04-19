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
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Force app name/userData path before any app API use. Electron falls back
// to "Electron" when it can't find name metadata via its usual lookup
// (happens with `electron <script>` invocations in dev).
app.setName('OpenHive');

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
  // useful from a terminal launch).
  const writeStream = fs.createWriteStream(logPath, { flags: 'a' });
  child.stdout?.on('data', (b) => { writeStream.write(b); process.stderr.write(b); });
  child.stderr?.on('data', (b) => { writeStream.write(b); process.stderr.write(b); });

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
      config: { dataDir, host: '127.0.0.1', port: 0, ...overrides },
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
function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
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
