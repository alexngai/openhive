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
  Notification,
  Tray,
  crashReporter,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as os from 'node:os';
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

// Local-only crash dump capture. We don't run a Sentry-style upload
// endpoint; crashes get written to <userData>/Crashpad/ for the user (or
// us, when they share a bug report) to inspect. Must be called before
// app.whenReady to capture early-startup crashes.
crashReporter.start({
  uploadToServer: false,
  productName: 'OpenHive',
  ignoreSystemCrashHandler: false,
});

// Register as the OS handler for openhive:// URLs. Clicking such a URL
// from a browser, terminal, or other app will route through `open-url`
// (macOS) or a fresh argv entry (Linux/Windows, surfaced via the
// single-instance second-instance event).
//
// Dev-mode caveat: when running unpackaged (`electron dist/main.js`),
// macOS registers Electron itself as the handler — which is useless. We
// only register in packaged builds where the .app bundle owns the scheme.
if (app.isPackaged) {
  app.setAsDefaultProtocolClient('openhive');
}

// Augment $PATH for GUI launches. Apps started from Finder/Dock inherit a
// minimal $PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), missing the locations
// where most users have their actual `git`, `node`, `headscale`, etc. The
// hive-child fork inherits this PATH, so OpenHive's swarm/git/network
// integrations would silently fail without it.
//
// Order: prepend (don't replace) so any user-set PATH still wins for
// duplicates. Non-existent dirs are harmless — PATH lookup just skips them.
{
  const extras: string[] = [];
  if (process.platform === 'darwin') {
    extras.push(
      '/opt/homebrew/bin', '/opt/homebrew/sbin',  // Apple Silicon Homebrew
      '/usr/local/bin', '/usr/local/sbin',        // Intel Homebrew + manual
    );
  }
  extras.push(path.join(os.homedir(), '.local', 'bin')); // XDG user-bin
  const sep = process.platform === 'win32' ? ';' : ':';
  process.env.PATH = [...extras, process.env.PATH ?? ''].filter(Boolean).join(sep);
}

// Lock the chromium-side colour scheme to dark. The SPA is dark-only and
// already sets `documentElement.className = 'dark'` early in index.html;
// this covers what the SPA can't reach — native scrollbars, file dialogs,
// devtools, the brief pre-paint flash on window create.
nativeTheme.themeSource = 'dark';

// macOS About panel + Linux `app.showAboutPanel()` content. Without this,
// "About OpenHive" shows an empty Electron-default sheet.
app.setAboutPanelOptions({
  applicationName: 'OpenHive',
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
  copyright: `© ${new Date().getFullYear()} Alex Ngai`,
  website: 'https://github.com/alexngai/openhive',
});

// Dev-mode dock icon. Packaged builds get the icon from electron-builder's
// `build.mac.icon` (baked into the .app's Resources); dev launches via
// `electron dist/main.js` would otherwise show Electron's default.
if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
  const devIcon = path.join(__dirname, '..', 'build', 'icon.png');
  if (fs.existsSync(devIcon)) {
    try { app.dock.setIcon(devIcon); } catch { /* non-fatal */ }
  }
}

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

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
  fullscreen?: boolean;
}

const DEFAULT_WINDOW_STATE: Readonly<WindowState> = { width: 1280, height: 800 };

function windowStatePath(dataDir: string): string {
  return path.join(dataDir, 'window-state.json');
}

/**
 * Load saved window bounds for this hive, falling back to defaults if the
 * file is missing/corrupt or the saved rectangle no longer overlaps any
 * connected display (e.g. user disconnected the external monitor it was on).
 */
function loadWindowState(dataDir: string): WindowState {
  let parsed: Partial<WindowState> | undefined;
  try {
    parsed = JSON.parse(
      fs.readFileSync(windowStatePath(dataDir), 'utf-8'),
    ) as Partial<WindowState>;
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }

  const state: WindowState = {
    width: typeof parsed.width === 'number' ? parsed.width : DEFAULT_WINDOW_STATE.width,
    height: typeof parsed.height === 'number' ? parsed.height : DEFAULT_WINDOW_STATE.height,
    x: typeof parsed.x === 'number' ? parsed.x : undefined,
    y: typeof parsed.y === 'number' ? parsed.y : undefined,
    maximized: parsed.maximized === true,
    fullscreen: parsed.fullscreen === true,
  };

  if (state.x !== undefined && state.y !== undefined) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return (
        state.x! < a.x + a.width &&
        state.x! + state.width > a.x &&
        state.y! < a.y + a.height &&
        state.y! + state.height > a.y
      );
    });
    if (!onScreen) {
      state.x = undefined;
      state.y = undefined;
    }
  }
  return state;
}

function saveWindowState(dataDir: string, window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  // getNormalBounds() returns the un-maximized / un-fullscreen rect, so a
  // user who quits while maximized still gets a sensible restored size next
  // launch even if they un-maximize it.
  const bounds = window.getNormalBounds();
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  };
  try {
    fs.writeFileSync(
      windowStatePath(dataDir),
      JSON.stringify(state, null, 2),
      'utf-8',
    );
  } catch {
    /* disk full / readonly fs — non-fatal */
  }
}

/**
 * Lock the renderer to the hive's loopback origin. Anything that would
 * navigate the main frame elsewhere (target=_blank, window.open, in-page
 * link to an external site) is intercepted and handed to the OS browser.
 *
 * Two layers:
 *   - setWindowOpenHandler: blocks `window.open` / `target="_blank"` from
 *     spawning a chrome-less Electron window with full nodeIntegration off
 *     but still our process. Always defer to the user's browser instead.
 *   - will-navigate: blocks main-frame navigations to off-origin URLs,
 *     opening them externally instead. Same-origin navigations (the SPA's
 *     own router transitions) pass through untouched.
 */
function hardenWebContents(contents: WebContents, hiveOrigin: string): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }
    if (target.origin === hiveOrigin) return;
    event.preventDefault();
    if (target.protocol === 'http:' || target.protocol === 'https:') {
      void shell.openExternal(url);
    }
  });
}

type ChildMessage =
  | { type: 'ready'; url: string }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'log'; level: string; msg: string };

const hives = new Map<string, HiveEntry>();

// ── Recent hives ──────────────────────────────────────────────────────
//
// Persisted MRU list of dataDir paths the user has opened. Surfaced as the
// "Open Recent" submenu under Hive. Lives at the supervisor scope (under
// app.getPath('userData')), not per-hive, so it tracks every hive the user
// has interacted with regardless of which one they're in right now.

const RECENT_HIVES_MAX = 10;
let recentHives: string[] = [];

function recentHivesPath(): string {
  return path.join(app.getPath('userData'), 'recent-hives.json');
}

function loadRecentHives(): string[] {
  try {
    const raw = fs.readFileSync(recentHivesPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string').slice(0, RECENT_HIVES_MAX);
  } catch {
    return [];
  }
}

function saveRecentHives(): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(
      recentHivesPath(),
      JSON.stringify(recentHives, null, 2),
      'utf-8',
    );
  } catch {
    /* non-fatal */
  }
}

/** Bump dataDir to the front of the MRU list, dedup, persist, refresh menu. */
function recordRecentHive(dataDir: string): void {
  const filtered = recentHives.filter((p) => p !== dataDir);
  recentHives = [dataDir, ...filtered].slice(0, RECENT_HIVES_MAX);
  saveRecentHives();
  if (app.isReady()) Menu.setApplicationMenu(buildMenu());
}

function clearRecentHives(): void {
  recentHives = [];
  saveRecentHives();
  Menu.setApplicationMenu(buildMenu());
}

/**
 * Focus an already-open hive's window, or boot a new hive at this dataDir.
 * Used by the "New Hive…" menu, the recent-hives submenu, and the default
 * userData spawn on launch.
 */
async function openHive(dataDir: string): Promise<void> {
  const existing = hives.get(dataDir);
  if (existing) {
    if (existing.window.isMinimized()) existing.window.restore();
    existing.window.focus();
    recordRecentHive(dataDir);
    return;
  }
  try {
    await spawnHive(dataDir);
    recordRecentHive(dataDir);
  } catch (err) {
    dialog.showErrorBox('Could not open hive', (err as Error).message);
  }
}

// ── Deep links (openhive://…) ─────────────────────────────────────────
//
// URLs arrive via two paths:
//   - macOS: `app.on('open-url')` — the OS delegates to the running app.
//   - Linux/Windows: the URL shows up as an argv entry when the OS launches
//     us (caught by the single-instance lock's `second-instance` handler,
//     which inspects the extra argv it received).
//
// Renderer integration lives in src/web/hooks/useDeepLinks.ts — the hook
// subscribes to the `openhive:deep-link` IPC channel and maps URLs to
// react-router routes.

function focusFirstHive(): BrowserWindow | null {
  const first = hives.values().next().value;
  if (!first) return null;
  const { window } = first;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  return window;
}

// Resolved when the first hive's renderer has finished loading — i.e. when
// the React app has mounted and the deep-link IPC listener is wired. Cold-
// start deep links (clicked while the app was closed) wait on this so the
// IPC doesn't fire into a renderer that hasn't subscribed yet.
let firstHiveReady: Promise<BrowserWindow> | null = null;
let firstHiveReadyResolve: ((w: BrowserWindow) => void) | null = null;
function ensureFirstHivePromise(): Promise<BrowserWindow> {
  if (!firstHiveReady) {
    firstHiveReady = new Promise<BrowserWindow>((resolve) => {
      firstHiveReadyResolve = resolve;
    });
  }
  return firstHiveReady;
}

async function processDeepLink(url: string): Promise<void> {
  if (!url.startsWith('openhive://')) return;
  // Send to whichever hive is already loaded, or wait for one if cold.
  const live = focusFirstHive();
  const target = live ?? await ensureFirstHivePromise();
  if (live !== target) {
    if (target.isMinimized()) target.restore();
    target.focus();
  }
  target.webContents.send('openhive:deep-link', url);
}

function findDeepLinkInArgv(argv: string[]): string | undefined {
  return argv.find((a) => a.startsWith('openhive://'));
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  // Queue until ready — macOS can deliver open-url during app boot.
  if (app.isReady()) void processDeepLink(url);
  else app.whenReady().then(() => { void processDeepLink(url); });
});

// ── Single-instance lock ──────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const deepLink = findDeepLinkInArgv(argv);
    if (deepLink) {
      void processDeepLink(deepLink);
      return;
    }
    focusFirstHive();
  });
  // Handle the initial launch argv too — the URL that triggered the launch
  // is in process.argv on Linux/Windows. macOS uses open-url instead.
  const initial = findDeepLinkInArgv(process.argv.slice(1));
  if (initial) {
    app.whenReady().then(() => { void processDeepLink(initial); });
  }
}

// ── IPC: renderer → main bridge ───────────────────────────────────────
//
// Preload (electron-app/src/preload.ts) exposes these as
// `window.openhive.{notify,setBadge}`. Main validates payload shape then
// hands off to the OS.

interface NotifyPayload {
  title: string;
  body: string;
  /** Optional `openhive://` URL or hash fragment to focus on click. */
  route?: string;
}

function isNotifyPayload(x: unknown): x is NotifyPayload {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return typeof p.title === 'string'
    && typeof p.body === 'string'
    && (p.route === undefined || typeof p.route === 'string');
}

ipcMain.on('openhive:notify', (event, payload: unknown) => {
  if (!isNotifyPayload(payload)) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: payload.title,
    body: payload.body,
    silent: false,
  });
  n.on('click', () => {
    // Focus the BrowserWindow that requested the notification — not just
    // the first hive — so multi-hive users land in the right window.
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (sender && !sender.isDestroyed()) {
      if (sender.isMinimized()) sender.restore();
      if (!sender.isVisible()) sender.show();
      sender.focus();
      if (payload.route) {
        sender.webContents.send('openhive:focus-route', payload.route);
      }
    }
  });
  n.show();
});

ipcMain.on('openhive:set-badge', (_event, raw: unknown) => {
  const count = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(0, Math.floor(raw))
    : 0;
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '');
  } else {
    app.setBadgeCount(count);
  }
});

// ── Tray icon ─────────────────────────────────────────────────────────
//
// Menu-bar/system-tray entry that's always present. Clicking brings the
// first hive window forward; the submenu offers Show/New Hive/Quit for
// when the window is fully hidden (closed on Linux, minimized-into-dock
// on macOS). Held in a module-level ref so GC doesn't collect the Tray
// and drop the icon from the menu bar.
let tray: Tray | null = null;

function setupTray(): void {
  const templateIcon = path.join(__dirname, '..', 'build', 'tray-iconTemplate.png');
  const fallbackIcon = path.join(__dirname, '..', 'build', 'icon.png');
  const iconPath = fs.existsSync(templateIcon) ? templateIcon : fallbackIcon;
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return;  // missing asset — skip tray silently

  tray = new Tray(image);
  tray.setToolTip('OpenHive');

  const rebuild = (): void => {
    if (!tray) return;
    const menu = Menu.buildFromTemplate([
      {
        label: 'Show OpenHive',
        click: () => { focusFirstHive(); },
      },
      {
        label: 'New Hive…',
        click: async () => {
          const r = await dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
            title: 'Choose a folder for the new hive',
          });
          if (r.canceled || !r.filePaths[0]) return;
          await openHive(r.filePaths[0]);
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();

  // Left-click (macOS) / single-click (Linux) focuses the window without
  // needing the context menu.
  tray.on('click', () => { focusFirstHive(); });
}

// ── Lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  recentHives = loadRecentHives();

  // Conservative permission posture: deny everything the SPA hasn't asked
  // for yet. We can whitelist as we add features (e.g. native notifications
  // in Tier 3 will need 'notifications'). Both handlers must agree —
  // requestHandler covers prompts; checkHandler covers synchronous APIs
  // like `navigator.permissions.query()`.
  const allowed: ReadonlySet<string> = new Set([
    'fullscreen',                 // SPA terminal/trajectory views may go fullscreen
    'clipboard-sanitized-write',  // copy buttons throughout the UI
  ]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return allowed.has(permission);
  });

  const defaultHive = app.getPath('userData');
  try {
    await spawnHive(defaultHive);
    recordRecentHive(defaultHive);
  } catch (err) {
    dialog.showErrorBox(
      'OpenHive failed to start',
      (err as Error).message,
    );
    app.quit();
    return;
  }
  Menu.setApplicationMenu(buildMenu());
  setupTray();

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

app.on('activate', () => {
  if (hives.size === 0 && app.isReady()) {
    void openHive(app.getPath('userData'));
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

  const state = loadWindowState(dataDir);
  const window = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    backgroundColor: '#0b0a0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (state.maximized) window.maximize();
  if (state.fullscreen) window.setFullScreen(true);
  hardenWebContents(window.webContents, new URL(url).origin);
  window.once('ready-to-show', () => window.show());
  // First hive ready → resolve the deep-link wait. Subsequent hives don't
  // re-resolve. Listener attached before loadURL so we can't miss the event.
  window.webContents.once('did-finish-load', () => {
    if (firstHiveReadyResolve) {
      firstHiveReadyResolve(window);
      firstHiveReadyResolve = null;
    }
  });
  try {
    await window.loadURL(url);
  } catch (err) {
    if (!window.isDestroyed()) window.destroy();
    throw err;
  }

  const entry: HiveEntry = { child, window, dataDir, url, overrides };
  hives.set(dataDir, entry);

  // 'close' fires before 'closed' — bounds are still readable here.
  // Saving on 'closed' would be too late: the BrowserWindow is destroyed.
  window.on('close', () => saveWindowState(dataDir, window));

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

const REPO_URL = 'https://github.com/alexngai/openhive';
const ISSUES_URL = `${REPO_URL}/issues`;
const DOCS_URL = `${REPO_URL}#readme`;
const RELEASES_URL = `${REPO_URL}/releases`;

/** Truncate a long path for menu display: keep the last two segments. */
function shortenPath(p: string): string {
  const parts = p.split(path.sep).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…${path.sep}${parts.slice(-2).join(path.sep)}`;
}

function buildOpenRecentSubmenu(): MenuItemConstructorOptions[] {
  if (recentHives.length === 0) {
    return [{ label: 'No recent hives', enabled: false }];
  }
  const items: MenuItemConstructorOptions[] = recentHives.map((dataDir) => ({
    label: shortenPath(dataDir),
    toolTip: dataDir,
    click: () => { void openHive(dataDir); },
  }));
  items.push({ type: 'separator' });
  items.push({ label: 'Clear Menu', click: () => clearRecentHives() });
  return items;
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
            await openHive(r.filePaths[0]);
          },
        },
        { type: 'separator' },
        { label: 'Open Recent', submenu: buildOpenRecentSubmenu() },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Documentation', click: () => { void shell.openExternal(DOCS_URL); } },
        { label: 'Releases',      click: () => { void shell.openExternal(RELEASES_URL); } },
        { label: 'Report an Issue…', click: () => { void shell.openExternal(ISSUES_URL); } },
        { type: 'separator' },
        { label: 'View on GitHub',   click: () => { void shell.openExternal(REPO_URL); } },
      ],
    },
  ]);
}
