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
  clipboard,
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

// ── Headless / tray-only mode ─────────────────────────────────────────
//
// Headless mode boots the hive server (the forked Node child) WITHOUT
// opening a BrowserWindow. The app lives entirely in the system tray /
// menu bar; the UI window is built on demand when the user picks "Show
// OpenHive". Triggered three ways, in precedence order:
//   1. --no-tray / OPENHIVE_HEADLESS=0  → force headed, this launch
//   2. --tray    / OPENHIVE_HEADLESS=1  → force headless, this launch
//   3. the persisted `headless` app setting → default when no flag given
//
// The flag is `--tray`, NOT `--headless`: `--headless` is a reserved
// Chromium command-line switch and Electron would route it into Chromium
// rather than leave it for us to read. `OPENHIVE_HEADLESS` is fine as an
// env var — no collision risk there.
//
// `headless` is finalised in whenReady, once the settings file is loaded.
// The CLI/env flags are read here at module scope (no app paths needed);
// the persisted setting is folded in later.
const cliHeadless =
  process.argv.includes('--tray') || process.env.OPENHIVE_HEADLESS === '1';
const cliHeaded =
  process.argv.includes('--no-tray') || process.env.OPENHIVE_HEADLESS === '0';
let headless = cliHeadless;

interface HiveEntry {
  child: ChildProcess;
  /**
   * The hive's UI window. `null` in headless/tray mode — both before the
   * user first opens the UI and again after they close it. The hive-child
   * (the actual server process) lives on regardless.
   */
  window: BrowserWindow | null;
  dataDir: string;
  url: string;
  overrides: Record<string, unknown>;
  /**
   * Whether the hive-child server outlives its window. `true` → closing the
   * window just disposes the UI; the server keeps running (a background
   * hive). `false` → closing the window stops the hive (a transient,
   * close-to-quit window). Also drives which hives are persisted to
   * `settings.lastRunningHives` for restore-on-launch. See onHivesChanged().
   */
  keepAlive: boolean;
  /** Stable short id for deep-link routing — `openhive://h/<id>/…`. */
  id: string;
}

/**
 * Resolve the dataDir for the *default* hive (the one auto-opened on launch
 * and on macOS dock-icon re-activation). Distinct from app.getPath('userData')
 * — that's the app's Electron-level state (Crashpad, GPU cache, our own
 * recent-hives.json) which stays at the platform-standard path so the OS
 * treats it conventionally. The hive's own state (SQLite, IAM secret, etc.)
 * lives wherever this resolver points.
 *
 *   1. OPENHIVE_HOME env var — mirrors the openhive CLI's override knob.
 *      Used by the smoke-test to isolate; also lets a power user launch
 *      the app pointed at any data dir from the terminal.
 *   2. ~/.openhive/ — same default as the CLI. Means a user who has been
 *      running `openhive serve` from a terminal will see their existing
 *      data when they install the GUI app, and vice versa. CLI-app parity.
 *
 * The "Open Hive…" / "New Hive…" menu items still let the user point any
 * subsequent hive at an arbitrary path via the file picker; only the
 * launch default changes here.
 */
function defaultHiveDataDir(): string {
  return process.env.OPENHIVE_HOME || path.join(os.homedir(), '.openhive');
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

// Set true once app quit begins. Child-exit handlers and onHivesChanged()
// short-circuit on it: during quit every hive-child exits, and without this
// guard their exit handlers would shrink `settings.lastRunningHives` to []
// — destroying the very set the next launch needs to restore.
let quitting = false;

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

/** Canonicalize a dataDir path so `/foo/Hive` and `/foo/Hive/` coalesce.
 *  Falls back to path.resolve when the dir doesn't exist yet (e.g. just-
 *  picked-from-dialog folder that openHive will create). */
function canonicalize(dataDir: string): string {
  try { return fs.realpathSync(dataDir); }
  catch { return path.resolve(dataDir); }
}

/** Bump dataDir to the front of the MRU list, dedup, persist, refresh menus. */
function recordRecentHive(dataDir: string): void {
  const canonical = canonicalize(dataDir);
  const filtered = recentHives.filter((p) => canonicalize(p) !== canonical);
  recentHives = [canonical, ...filtered].slice(0, RECENT_HIVES_MAX);
  saveRecentHives();
  refreshMenus();
}

function clearRecentHives(): void {
  recentHives = [];
  saveRecentHives();
  refreshMenus();
}

// ── App settings ──────────────────────────────────────────────────────
//
// Supervisor-scoped preferences, persisted under app.getPath('userData')
// alongside recent-hives.json — separate from any per-hive state. Today
// this is just the tray-mode knobs.

interface AppSettings {
  /** Launch into headless/tray-only mode (server runs, no window). */
  headless: boolean;
  /** Register an OS login item so OpenHive auto-starts at sign-in. */
  startAtLogin: boolean;
  /**
   * dataDirs of the background (keepAlive) hives that were running last.
   * Maintained continuously by onHivesChanged() — not just at quit — so a
   * crash still leaves an accurate set. A headless launch restores these.
   */
  lastRunningHives: string[];
  /**
   * Stable hive-id registry: dataDir → short id, used by deep links
   * (`openhive://h/<id>/…`). Persisted so a cold-start deep link can map an
   * id back to a dataDir before that hive has booted.
   */
  hiveIds: Record<string, string>;
}

const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  headless: false,
  startAtLogin: false,
  lastRunningHives: [],
  hiveIds: {},
};

let settings: AppSettings = { ...DEFAULT_SETTINGS };

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings(): AppSettings {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(settingsPath(), 'utf-8'),
    ) as Partial<AppSettings>;
    return {
      headless: parsed.headless === true,
      startAtLogin: parsed.startAtLogin === true,
      lastRunningHives: Array.isArray(parsed.lastRunningHives)
        ? parsed.lastRunningHives.filter((p): p is string => typeof p === 'string')
        : [],
      hiveIds: (parsed.hiveIds && typeof parsed.hiveIds === 'object'
        && !Array.isArray(parsed.hiveIds))
        ? Object.fromEntries(
            Object.entries(parsed.hiveIds as Record<string, unknown>)
              .filter((e): e is [string, string] => typeof e[1] === 'string'),
          )
        : {},
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify(settings, null, 2),
      'utf-8',
    );
  } catch {
    /* disk full / readonly fs — non-fatal */
  }
}

/**
 * Sync the OS login-item registration to `settings.startAtLogin`.
 * A sign-in auto-start passes `--tray` so it lands in the tray rather
 * than stealing focus with a window. `setLoginItemSettings` is a no-op on
 * Linux — autostart there needs an XDG `.desktop` file we don't ship yet,
 * which is why the tray toggle is disabled on Linux.
 */
function applyLoginItemSetting(): void {
  if (process.platform === 'linux') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.startAtLogin,
      args: ['--tray'],
    });
  } catch {
    /* login item is a convenience, not load-bearing — non-fatal */
  }
}

/** Apply a settings patch, persist it, and re-sync derived OS state. */
function updateSettings(patch: Partial<AppSettings>): void {
  settings = { ...settings, ...patch };
  saveSettings();
  applyLoginItemSetting();
  refreshTrayMenu();
}

/**
 * dataDirs that were in the restore set this launch but whose hive folder
 * was missing (deleted, or an unmounted drive). Kept *out* of the running
 * `hives` map but folded back into `settings.lastRunningHives` by
 * onHivesChanged() — so a transient unmount auto-recovers next launch
 * rather than silently dropping the hive from auto-start.
 */
let unavailableHives: string[] = [];

/**
 * Call after any change to the set of running hives (spawn, stop, crash,
 * window close, keepAlive toggle). Persists the auto-start set for
 * restore-on-launch and rebuilds the tray so its "Running Hives" list
 * stays accurate. Persisting continuously (rather than only at quit) means
 * a crash still leaves a correct `lastRunningHives`.
 *
 * The persisted set is (running keepAlive hives) ∪ (unavailableHives) — see
 * `unavailableHives` for why the missing ones are retained.
 *
 * NOT called from before-quit's mass `hives.clear()` — that would wipe the
 * set right before exit; the last per-hive change already recorded it.
 */
function onHivesChanged(): void {
  if (quitting) return;  // don't persist the set as it drains during quit
  const running = [...hives.values()]
    .filter((entry) => entry.keepAlive)
    .map((entry) => entry.dataDir);
  settings.lastRunningHives = [...new Set([...running, ...unavailableHives])];
  saveSettings();
  refreshTrayMenu();
}

// ── Hive-id registry ──────────────────────────────────────────────────
//
// A stable, short, URL-safe id per hive dataDir, used by deep links
// (`openhive://h/<id>/<route>`). Persisted in settings.hiveIds (dataDir →
// id) so a cold-start deep link can resolve an id to a dataDir before that
// hive has booted.

/** Derive a URL-safe id stub from a dataDir's basename. */
function slugifyHiveId(dataDir: string): string {
  const base = path.basename(dataDir)
    .toLowerCase()
    .replace(/^\.+/, '')          // ~/.openhive → "openhive"
    .replace(/[^a-z0-9]+/g, '-')  // spaces / punctuation → dash
    .replace(/^-+|-+$/g, '');     // trim leading/trailing dashes
  return base || 'hive';
}

/** Return the hive's id, assigning + persisting a fresh one on first use.
 *  Collisions (same basename, different dir) get a `-2`, `-3`, … suffix. */
function ensureHiveId(dataDir: string): string {
  const existing = settings.hiveIds[dataDir];
  if (existing) return existing;
  const taken = new Set(Object.values(settings.hiveIds));
  const base = slugifyHiveId(dataDir);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  settings.hiveIds = { ...settings.hiveIds, [dataDir]: id };
  saveSettings();
  return id;
}

/** Reverse the registry: hive id → dataDir, or undefined if unknown. */
function resolveHiveId(id: string): string | undefined {
  for (const [dir, hid] of Object.entries(settings.hiveIds)) {
    if (hid === id) return dir;
  }
  return undefined;
}

/** Rebuild + reattach both the application menu and the macOS dock menu.
 *  Safe to call before app-ready (no-op until then). */
function refreshMenus(): void {
  if (!app.isReady()) return;
  Menu.setApplicationMenu(buildMenu());
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(buildDockMenu());
  }
}

/**
 * Open a hive's window — focusing it if already open, building the window
 * if headless mode deferred it, or booting a fresh hive at this dataDir.
 * Always results in a visible window: it's the user-initiated "open"
 * action (menus, recent-hives, tray). The headless launch path boots the
 * server windowless instead by calling spawnHive directly.
 */
async function openHive(
  dataDir: string,
  opts: { withWindow?: boolean; keepAlive?: boolean } = {},
): Promise<void> {
  const withWindow = opts.withWindow ?? true;
  const existing = hives.get(dataDir);
  if (existing) {
    if (opts.keepAlive !== undefined) {
      existing.keepAlive = opts.keepAlive;
      onHivesChanged();
    }
    if (withWindow) {
      const window = existing.window && !existing.window.isDestroyed()
        ? existing.window
        : await createHiveWindow(existing);
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    recordRecentHive(dataDir);
    return;
  }
  try {
    await spawnHive(dataDir, {}, { withWindow, keepAlive: opts.keepAlive });
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

/** True if any hive currently has a live, non-destroyed window. */
function anyHiveWindowOpen(): boolean {
  for (const entry of hives.values()) {
    if (entry.window && !entry.window.isDestroyed()) return true;
  }
  return false;
}

/**
 * Focus the first hive that already has a live window. Returns null when
 * no hive has a window (e.g. headless mode before the UI is opened) —
 * callers that must guarantee a window should use showHive() instead.
 */
function focusFirstHive(): BrowserWindow | null {
  for (const entry of hives.values()) {
    const window = entry.window;
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
      return window;
    }
  }
  return null;
}

/**
 * Surface a hive window whatever the current state: focus an open one,
 * lazily build the window for a running-but-windowless headless hive, or
 * boot the default hive if nothing is running. This is what the tray's
 * "Show OpenHive", tray click, and dock/second-instance activations route
 * through.
 */
async function showHive(): Promise<BrowserWindow | null> {
  const focused = focusFirstHive();
  if (focused) return focused;

  const first = hives.values().next().value as HiveEntry | undefined;
  if (first) {
    const window = await createHiveWindow(first);
    if (window.isMinimized()) window.restore();
    window.focus();
    return window;
  }

  // Nothing running at all — boot the default hive with a window.
  await openHive(defaultHiveDataDir());
  const booted = hives.values().next().value as HiveEntry | undefined;
  return booted?.window ?? null;
}

/**
 * Surface one *specific* hive's window — focusing it, or building it on
 * demand if the hive is running windowless. Used by the tray's per-hive
 * "Show Window". Boots the hive first if it isn't running at all.
 */
async function showHiveByDir(dataDir: string): Promise<BrowserWindow | null> {
  const entry = hives.get(dataDir);
  if (!entry) {
    await openHive(dataDir, { withWindow: true });
    return hives.get(dataDir)?.window ?? null;
  }
  const window = entry.window && !entry.window.isDestroyed()
    ? entry.window
    : await createHiveWindow(entry);
  if (window.isMinimized()) window.restore();
  window.focus();
  return window;
}

/**
 * Stop one hive: send its child the graceful stop, destroy any window, and
 * drop it from the registry. Deleting the entry first means the child's
 * exit handler treats the exit as intentional (no crash dialog).
 */
function stopHive(dataDir: string): void {
  const entry = hives.get(dataDir);
  if (!entry) return;
  hives.delete(dataDir);
  if (entry.window && !entry.window.isDestroyed()) entry.window.destroy();
  if (entry.child.pid && !entry.child.killed) {
    entry.child.send({ type: 'stop' });
    // Backstop: force-kill if the graceful stop doesn't take.
    setTimeout(() => {
      if (!entry.child.killed) entry.child.kill();
    }, 3000);
  }
  onHivesChanged();
}

/** Flip a hive's keepAlive flag (tray "Keep Running in Background"). */
function setHiveKeepAlive(dataDir: string, value: boolean): void {
  const entry = hives.get(dataDir);
  if (!entry) return;
  entry.keepAlive = value;
  onHivesChanged();
}

// Renderer-ready tracking. A hive's renderer signals readiness via the
// `openhive:renderer-ready` IPC once the React app has mounted *and* the
// deep-link hook has subscribed. Cold-start deep links (clicked while the
// app was closed, or while headless with no window) wait on this so the
// IPC doesn't fire into a renderer that hasn't subscribed yet.
//
// Why a ping instead of `did-finish-load`: did-finish-load fires after the
// HTML is parsed, but React's useEffect (where the deep-link hook attaches)
// runs after the commit phase — usually within microtasks but not
// guaranteed, and Suspense boundaries can defer it further.
//
// Tracked per-webContents (not a single app-wide promise) so it stays
// correct across headless open→close→reopen cycles, where the "first"
// window keeps changing identity.
const readyRenderers = new WeakSet<WebContents>();
const rendererReadyWaiters = new WeakMap<WebContents, Array<() => void>>();

function markRendererReady(wc: WebContents): void {
  readyRenderers.add(wc);
  const waiters = rendererReadyWaiters.get(wc);
  if (waiters) {
    rendererReadyWaiters.delete(wc);
    for (const resolve of waiters) resolve();
  }
}

/** Resolve once the given window's renderer has signalled readiness. */
function whenRendererReady(window: BrowserWindow): Promise<void> {
  const wc = window.webContents;
  if (readyRenderers.has(wc)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = rendererReadyWaiters.get(wc) ?? [];
    list.push(resolve);
    rendererReadyWaiters.set(wc, list);
  });
}

// Resolves when whenReady has finished the initial supervisor boot (hive-id
// registry loaded, restore set spawned). Cold-start deep links await this so
// they can't race the restore loop into a double-spawn, nor try to resolve a
// hive id before settings.hiveIds is populated.
let markBootComplete: () => void = () => {};
const bootComplete = new Promise<void>((resolve) => { markBootComplete = resolve; });

/**
 * Split an `openhive://` URL into an optional target hive id and the route
 * URL to forward to that hive's renderer. `openhive://h/<id>/<route>`
 * targets a specific hive; anything else has no id and targets the
 * focused/first hive — the pre-multi-hive contract, unchanged for
 * single-hive users. `h/` is safe to reserve: the SPA has no `/h` route.
 */
function parseDeepLink(url: string): { hiveId?: string; forward: string } {
  const rest = url.slice('openhive://'.length);
  const m = /^h\/([^/]+)(?:\/(.*))?$/.exec(rest);
  if (m) return { hiveId: m[1], forward: `openhive://${m[2] ?? ''}` };
  return { forward: url };
}

async function processDeepLink(url: string): Promise<void> {
  if (!url.startsWith('openhive://')) return;
  // Hold cold-start links until the supervisor's initial boot is done.
  await bootComplete;

  const { hiveId, forward } = parseDeepLink(url);
  // Resolve the target window: a specific hive by id (booting it if it
  // isn't running), or — for an id-less link or an unknown id — the
  // focused/first hive.
  let target: BrowserWindow | null;
  if (hiveId) {
    const dataDir = resolveHiveId(hiveId);
    target = dataDir ? await showHiveByDir(dataDir) : await showHive();
  } else {
    target = await showHive();
  }
  if (!target || target.isDestroyed()) return;

  // Route the URL once the renderer has subscribed to the deep-link channel.
  await whenRendererReady(target);
  if (target.isDestroyed()) return;
  if (target.isMinimized()) target.restore();
  target.focus();
  target.webContents.send('openhive:deep-link', forward);
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
    // Relaunch with no deep link — the user wants the app surfaced.
    void showHive();
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
// Preload (electron-app/src/preload.cts) exposes these as
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

ipcMain.on('openhive:renderer-ready', (event) => {
  markRendererReady(event.sender);
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
// Menu-bar/system-tray entry, always present. In headed mode it's a
// convenience for when every window is closed; in headless/tray-only mode
// it is the *only* surface — "Show OpenHive" lazily builds the UI window.
// The menu also carries the two tray-mode toggles (start in background,
// open at login). Held in a module-level ref so GC doesn't collect the
// Tray and drop the icon from the menu bar.
let tray: Tray | null = null;

/** Per-hive submenu for the tray "Running Hives" list. */
function buildHiveTraySubmenu(entry: HiveEntry): MenuItemConstructorOptions[] {
  return [
    { label: `ID: ${entry.id}`, enabled: false },
    { type: 'separator' },
    { label: 'Show Window', click: () => { void showHiveByDir(entry.dataDir); } },
    { label: 'Stop', click: () => { stopHive(entry.dataDir); } },
    {
      label: 'Restart',
      click: () => { void restartHive(entry.dataDir, entry.overrides); },
    },
    {
      label: 'Copy Deep Link',
      toolTip: `openhive://h/${entry.id}/`,
      click: () => { clipboard.writeText(`openhive://h/${entry.id}/`); },
    },
    { type: 'separator' },
    {
      label: 'Keep Running in Background',
      type: 'checkbox',
      checked: entry.keepAlive,
      toolTip: 'When off, closing this hive’s window stops its server',
      click: (item) => { setHiveKeepAlive(entry.dataDir, item.checked); },
    },
  ];
}

function buildTrayMenu(): Menu {
  const items: MenuItemConstructorOptions[] = [];

  // Running hives — the headless control panel. Each is a submenu of
  // per-hive lifecycle actions; a "●" marks the ones with an open window.
  if (hives.size > 0) {
    items.push({ label: 'Running Hives', enabled: false });
    for (const entry of hives.values()) {
      const windowed = !!entry.window && !entry.window.isDestroyed();
      items.push({
        label: `  ${windowed ? '●' : '○'}  ${shortenPath(entry.dataDir)}`,
        toolTip: entry.dataDir,
        submenu: buildHiveTraySubmenu(entry),
      });
    }
  } else {
    items.push({ label: 'No hives running', enabled: false });
  }
  items.push({ type: 'separator' });

  items.push({
    label: 'New Hive in Background…',
    toolTip: 'Boot a hive server with no window',
    click: () => { void promptOpenHive({ withWindow: false }); },
  });
  items.push({
    label: 'New Hive (with window)…',
    click: () => { void promptOpenHive({ withWindow: true }); },
  });
  items.push({ label: 'Open Recent', submenu: buildOpenRecentSubmenu() });
  items.push({ type: 'separator' });

  items.push({
    label: 'Open in Background on Launch',
    type: 'checkbox',
    checked: settings.headless,
    toolTip: 'Start in the tray without opening a window',
    click: (item) => { updateSettings({ headless: item.checked }); },
  });
  items.push({
    label: 'Open at Login',
    type: 'checkbox',
    checked: settings.startAtLogin,
    // setLoginItemSettings is a no-op on Linux — disable the control
    // there rather than offer a toggle that silently does nothing.
    enabled: process.platform !== 'linux',
    click: (item) => { updateSettings({ startAtLogin: item.checked }); },
  });
  items.push({ type: 'separator' });
  items.push({ label: 'Quit OpenHive', click: () => app.quit() });

  return Menu.buildFromTemplate(items);
}

/** Reattach the tray context menu — call after a settings change so the
 *  checkbox states reflect the new values. No-op before the tray exists. */
function refreshTrayMenu(): void {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function setupTray(): void {
  const templateIcon = path.join(__dirname, '..', 'build', 'tray-iconTemplate.png');
  const fallbackIcon = path.join(__dirname, '..', 'build', 'icon.png');
  const iconPath = fs.existsSync(templateIcon) ? templateIcon : fallbackIcon;
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return;  // missing asset — skip tray silently

  tray = new Tray(image);
  tray.setToolTip('OpenHive');
  tray.setContextMenu(buildTrayMenu());

  // Left-click (macOS) / single-click (Linux) surfaces the window without
  // needing the context menu.
  tray.on('click', () => { void showHive(); });
}

/** "Choose folder" dialog → openHive. Shared by the menu + tray.
 *  Parents the dialog to the focused or first hive window so macOS attaches
 *  it as a sheet instead of floating it free. `withWindow: false` boots the
 *  new hive headless (tray "New Hive in Background…"); such hives are
 *  keepAlive so closing a later-opened window doesn't stop them. */
async function promptOpenHive(
  opts: { withWindow?: boolean } = {},
): Promise<void> {
  const withWindow = opts.withWindow ?? true;
  const firstWindow = [...hives.values()]
    .map((e) => e.window)
    .find((w): w is BrowserWindow => !!w && !w.isDestroyed());
  const parent = BrowserWindow.getFocusedWindow() ?? firstWindow ?? undefined;
  const r = parent
    ? await dialog.showOpenDialog(parent, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose a folder for the new hive',
      })
    : await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose a folder for the new hive',
      });
  if (r.canceled || !r.filePaths[0]) return;
  await openHive(r.filePaths[0], {
    withWindow,
    keepAlive: withWindow ? undefined : true,
  });
}

// ── Splash window ─────────────────────────────────────────────────────
//
// Cold start spawns a hive-child + waits for Fastify to bind, which can
// take 2-5 seconds. Without a splash the user clicks the icon, the dock
// bounces, then nothing visible happens. The splash fills that gap with
// the brand mark + "Starting…" so users know the app is alive.
//
// Lifecycle:
//   - showSplash() called from whenReady BEFORE spawnHive (synchronous)
//   - dismissSplash() called from the first hive window's ready-to-show
//   - also dismissed on hive boot failure so the error dialog isn't behind it

let splash: BrowserWindow | null = null;

function showSplash(): void {
  // Skip in dev — the dev `electron .` launch is fast enough that the
  // splash flickers in/out and feels worse than no splash. Packaged builds
  // have the slower hive-boot from the cold disk read of node_modules.
  if (!app.isPackaged) return;

  // Transparent logo so the splash's dark background shows through the
  // negative space (hexagon / frame edges) instead of sitting inside an
  // opaque tile that looks like a sticker on the panel.
  const iconPath = path.join(__dirname, '..', 'build', 'logo-transparent.png');
  let iconData = '';
  try { iconData = fs.readFileSync(iconPath).toString('base64'); }
  catch { /* missing — splash still works, just without the logo */ }

  splash = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#0b0a0c',
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  // Inline HTML keeps the splash self-contained — no extra file to ship.
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0b0a0c;color:#fef3c7;
      font:500 14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      -webkit-user-select:none;cursor:default}
    body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
    img{width:120px;height:120px;animation:p 1.6s ease-in-out infinite}
    .t{font-size:18px;letter-spacing:.02em}
    .s{font-size:12px;color:#7a7b7e}
    @keyframes p{0%,100%{opacity:.95}50%{opacity:.55}}
  </style></head><body>
    ${iconData ? `<img src="data:image/png;base64,${iconData}" alt="">` : ''}
    <div class="t">OpenHive</div>
    <div class="s">Starting…</div>
  </body></html>`;
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  splash.once('ready-to-show', () => splash?.show());
}

function dismissSplash(): void {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}

// ── Lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  recentHives = loadRecentHives();
  settings = loadSettings();

  // Finalise headless mode now the persisted setting is available. An
  // explicit flag this launch (either direction) overrides the setting.
  headless = cliHeaded ? false : (cliHeadless || settings.headless);

  // Keep the OS login item in sync with the saved preference.
  applyLoginItemSetting();

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

  // Headless: the hive server boots without a window, so there's nothing
  // for the splash to bridge to — skip it entirely.
  if (!headless) showSplash();

  const defaultHive = defaultHiveDataDir();

  if (headless) {
    // Restore the background hives from the last session — boot them
    // windowless + keepAlive. Sequential: pickFreePort has a race window,
    // so we never boot two hives concurrently. Per-hive failures are
    // non-fatal — log and skip; the app still comes up in the tray.
    const restoring = settings.lastRunningHives.length > 0;
    // Dedupe — a hand-edited settings.json could list a dir twice, and a
    // second spawnHive() for the same dataDir would orphan the first child.
    const toBoot = restoring
      ? [...new Set(settings.lastRunningHives)]
      : [defaultHive];
    // Pre-scan for missing folders BEFORE booting any hive. A restore entry
    // whose folder is gone (deleted, or an unmounted drive) must not be
    // booted — spawnHiveChild would mkdir it and a blank hive would appear.
    // `.openhive-root` is openhive's own sentinel, present in every
    // initialized hive. Missing ones go to `unavailableHives` (kept, not
    // pruned — see that var). The scan must complete before the first
    // spawnHive(), whose onHivesChanged() reads `unavailableHives` — scan
    // it lazily and a later-discovered miss would be dropped.
    const bootable: string[] = [];
    for (const dir of toBoot) {
      if (restoring && !fs.existsSync(path.join(dir, '.openhive-root'))) {
        console.warn(`[supervisor] hive unavailable, skipped: ${dir}`);
        unavailableHives.push(dir);
      } else {
        bootable.push(dir);
      }
    }

    let bootedAny = false;
    for (const dir of bootable) {
      try {
        await spawnHive(dir, {}, { withWindow: false, keepAlive: true });
        recordRecentHive(dir);
        bootedAny = true;
      } catch (err) {
        console.warn(
          `[supervisor] hive failed to restore: ${dir} — ${(err as Error).message}`,
        );
      }
    }
    // Restore set was non-empty but nothing came up — boot the default hive
    // so the app isn't left with an empty tray.
    if (!bootedAny && restoring) {
      try {
        await spawnHive(defaultHive, {}, { withWindow: false, keepAlive: true });
        recordRecentHive(defaultHive);
        bootedAny = true;
      } catch (err) {
        console.warn(
          `[supervisor] default hive failed to boot — ${(err as Error).message}`,
        );
      }
    }
    if (Notification.isSupported()) {
      // Stay resident in the tray regardless — surface what didn't come up.
      if (unavailableHives.length > 0) {
        new Notification({
          title: 'OpenHive',
          body: unavailableHives.length === 1
            ? `Hive folder unavailable — skipped: ${path.basename(unavailableHives[0])}`
            : `${unavailableHives.length} hive folders unavailable — skipped`,
        }).show();
      }
      if (!bootedAny) {
        new Notification({
          title: 'OpenHive',
          body: 'No hives could be started. Open one from the tray.',
        }).show();
      }
    }
  } else {
    try {
      await spawnHive(defaultHive, {}, { withWindow: true });
      recordRecentHive(defaultHive);
    } catch (err) {
      dismissSplash();
      // Smoke test: a boot failure must exit non-zero so CI fails. Bypasses
      // the error dialog (no one to see it) and app.quit()'s exit code 0.
      if (process.env.OPENHIVE_SMOKE_TEST) {
        console.error(
          `[smoke-test] FAIL: hive did not boot — ${(err as Error).message}`,
        );
        app.exit(1);
        return;
      }
      dialog.showErrorBox(
        'OpenHive failed to start',
        (err as Error).message,
      );
      app.quit();
      return;
    }
  }

  // Smoke test: spawnHive resolving means the hive-child loaded `openhive`
  // and its full dependency closure, and the Fastify server is listening —
  // exactly the path that breaks when the packaged asar is missing a module.
  // That is the whole check; exit cleanly so CI can assert on exit code 0
  // without needing a display or any interaction.
  if (process.env.OPENHIVE_SMOKE_TEST) {
    console.log('[smoke-test] PASS: hive booted, openhive server is listening');
    for (const { child } of hives.values()) child.kill();
    app.exit(0);
    return;
  }

  // Headless on macOS: drop the dock icon so OpenHive is a true menu-bar
  // app. The icon comes back via app.dock.show() when a window is opened
  // from the tray (see createHiveWindow's ready-to-show), and hides again
  // when the last hive window closes (see the window 'closed' handler).
  if (headless && process.platform === 'darwin') {
    app.dock?.hide();
  }

  refreshMenus();
  setupTray();
  // Initial boot done — cold-start deep links queued on bootComplete may
  // now resolve hive ids and route without racing the restore loop.
  markBootComplete();

  // Auto-update: only in packaged builds. Skipped on `electron .` dev
  // launches (app.isPackaged === false). Publish destination is declared
  // in package.json's `build.publish` (GitHub Releases); electron-updater
  // reads the same config to know where to check.
  if (app.isPackaged) {
    try {
      const autoUpdater = await loadAutoUpdater();
      // Record updater wiring health on the global. The e2e test reads this
      // via Playwright's app.evaluate(), which runs in a context with no
      // `require` / `import()` and so can't probe electron-updater itself.
      // True iff electron-updater resolved to a usable object — the exact
      // thing the CJS-interop regression broke (autoUpdater came back
      // undefined). This records the result of the *real* loadAutoUpdater()
      // call, not a re-implementation.
      (globalThis as Record<string, unknown>).__openhiveAutoUpdaterReady =
        typeof autoUpdater?.checkForUpdatesAndNotify === 'function';
      autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => {
        console.warn(`[supervisor] auto-update check failed: ${err.message}`);
      });
    } catch (err) {
      (globalThis as Record<string, unknown>).__openhiveAutoUpdaterReady = false;
      console.warn(
        `[supervisor] auto-update unavailable: ${(err as Error).message}`,
      );
    }
  }
});

app.on('activate', () => {
  if (!app.isReady()) return;
  if (hives.size === 0) {
    void openHive(defaultHiveDataDir());
  } else if (!anyHiveWindowOpen()) {
    // A headless hive is running but has no window — surface one.
    void showHive();
  }
});

app.on('window-all-closed', () => {
  // Headless/tray mode: the app stays resident in the tray with the hive
  // server still running, so closing the last window must not quit.
  if (headless) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  // Freeze the running-hive set: from here on, child-exit handlers must not
  // mutate `settings.lastRunningHives` (see `quitting`). Its current value
  // is what the next launch restores.
  quitting = true;
  if (hives.size === 0) return;
  e.preventDefault();
  // Snapshot bounds before app.exit() — that path bypasses window 'close'
  // events, so the per-hive close-handler never gets to persist them.
  // Headless hives may have no window — nothing to snapshot there.
  for (const { window, dataDir } of hives.values()) {
    if (window && !window.isDestroyed()) saveWindowState(dataDir, window);
  }
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
//
// A hive is two things with independent lifetimes:
//   - the hive-child: a forked Node process running the Fastify server
//   - the window:     a BrowserWindow rendering the SPA against that server
// They used to be created together. Headless mode splits them — the child
// always boots; the window is built on demand. spawnHiveChild boots the
// server, createHiveWindow builds its UI, and spawnHive orchestrates both.

/**
 * Fork a hive-child and wait for its Fastify server to bind. Resolves with
 * the child handle and the loopback URL. Creates no window.
 */
async function spawnHiveChild(
  dataDir: string,
  overrides: Record<string, unknown>,
): Promise<{ child: ChildProcess; url: string }> {
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

  return { child, url };
}

/**
 * Build the BrowserWindow for an already-running hive entry and load the
 * SPA. Idempotent — returns the existing window if one is already open.
 * In headless mode this is deferred until the user opens the UI from the
 * tray; in headed mode spawnHive calls it inline.
 */
async function createHiveWindow(entry: HiveEntry): Promise<BrowserWindow> {
  if (entry.window && !entry.window.isDestroyed()) return entry.window;

  const { dataDir, url } = entry;
  const state = loadWindowState(dataDir);
  const window = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    backgroundColor: '#0b0a0c',
    webPreferences: {
      // preload.cjs, NOT .js: the renderer is sandboxed (Electron default),
      // and a sandboxed preload is executed as CommonJS. This package is
      // `"type": "module"`, so a `.js` emit is ESM — Electron would throw
      // `SyntaxError: Cannot use import statement outside a module` and the
      // whole `window.openhive` bridge would silently never appear. The
      // source is `preload.cts`; NodeNext compiles `.cts` → `.cjs` (CJS).
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (state.maximized) window.maximize();
  if (state.fullscreen) window.setFullScreen(true);
  hardenWebContents(window.webContents, new URL(url).origin);
  window.once('ready-to-show', () => {
    window.show();
    dismissSplash();
    // Headless macOS hid the dock icon — bring it back now there's a window.
    if (process.platform === 'darwin') app.dock?.show();
  });
  // Recover from renderer crashes by reloading the same hive URL. The
  // hive-child Fastify server is a separate process and is unaffected, so
  // the page reload is enough — no need to respawn anything. We don't
  // reload on 'clean-exit' (not really a crash) or 'killed' (the user did
  // it deliberately, e.g. from Activity Monitor).
  window.webContents.on('render-process-gone', (_e, details) => {
    if (window.isDestroyed()) return;
    if (details.reason === 'clean-exit' || details.reason === 'killed') return;
    console.warn(`[supervisor] renderer gone (${details.reason}) — reloading`);
    window.reload();
  });

  entry.window = window;

  // 'close' fires before 'closed' — bounds are still readable here.
  // Saving on 'closed' would be too late: the BrowserWindow is destroyed.
  window.on('close', () => saveWindowState(dataDir, window));

  window.on('closed', () => {
    const existing = hives.get(dataDir);
    if (!existing) return;  // already stopped via stopHive / a crash
    existing.window = null;
    if (existing.keepAlive) {
      // Background hive: closing the UI just disposes the window — the
      // server keeps running, reachable again from the tray. Re-hide the
      // macOS dock icon (headless mode) once no hive window remains.
      if (headless && process.platform === 'darwin' && !anyHiveWindowOpen()) {
        app.dock?.hide();
      }
      refreshTrayMenu();  // the "● windowed" marker changed
      return;
    }
    // Transient hive: closing the window stops it.
    if (existing.child.pid && !existing.child.killed) {
      existing.child.send({ type: 'stop' });
    }
    hives.delete(dataDir);
    onHivesChanged();
  });

  try {
    await window.loadURL(url);
  } catch (err) {
    if (!window.isDestroyed()) window.destroy();
    entry.window = null;
    throw err;
  }
  return window;
}

/**
 * Surface a crashed hive to the user. With a window we parent a modal
 * Restart/Close dialog to it; headless we fall back to an OS notification
 * (a modal with no window to anchor would be invisible / un-dismissable).
 * We never auto-restart — a silent crash loop is worse than a quiet stop.
 */
function handleHiveCrash(
  dataDir: string,
  overrides: Record<string, unknown>,
  logPath: string,
  code: number,
  window: BrowserWindow | null,
  keepAlive: boolean,
): void {
  const detail = `Hive at ${dataDir} exited (code ${code}). See ${logPath} for details.`;

  if (window && !window.isDestroyed()) {
    dialog
      .showMessageBox(window, {
        type: 'error',
        title: 'Hive crashed',
        message: detail,
        buttons: ['Restart', 'Close'],
      })
      .then((r) => {
        if (r.response === 0) {
          void spawnHive(dataDir, overrides, { withWindow: true, keepAlive });
        } else if (!window.isDestroyed()) {
          window.close();
        }
      })
      .catch(() => { /* dialog dismissed */ });
    return;
  }

  // Headless: notify, and offer a one-click restart.
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'OpenHive — hive stopped',
      body: `${path.basename(dataDir)} crashed (code ${code}). Click to restart.`,
    });
    n.on('click', () => {
      void spawnHive(dataDir, overrides, { withWindow: false, keepAlive });
    });
    n.show();
  }
}

/**
 * Boot a hive: fork the child server, register it, and — unless headless
 * (or overridden via options.withWindow) — open its window.
 */
async function spawnHive(
  dataDir: string,
  overrides: Record<string, unknown> = {},
  options: { withWindow?: boolean; keepAlive?: boolean } = {},
): Promise<HiveEntry> {
  const withWindow = options.withWindow ?? !headless;
  // Default keepAlive to the global mode: a headless app's hives are
  // background services; a headed app's hives are close-to-quit windows.
  // "New Hive in Background…" and the restore path pass keepAlive: true.
  const keepAlive = options.keepAlive ?? headless;
  const logPath = path.join(dataDir, 'logs', 'hive.log');

  const { child, url } = await spawnHiveChild(dataDir, overrides);

  const entry: HiveEntry = {
    child, window: null, dataDir, url, overrides, keepAlive,
    id: ensureHiveId(dataDir),
  };
  hives.set(dataDir, entry);
  // A dir that just booted is, by definition, available again.
  unavailableHives = unavailableHives.filter((d) => d !== dataDir);
  onHivesChanged();

  // Long-lived crash handler. The 'exit before ready' listener inside
  // spawnHiveChild has already settled by now; this one catches a child
  // dying *after* a successful boot.
  child.on('exit', (code) => {
    if (quitting) return;  // app shutting down — before-quit owns cleanup
    const stillTracked = hives.get(dataDir);
    // User-initiated close/stop already deleted the entry; nothing to do.
    if (!stillTracked) return;
    hives.delete(dataDir);
    onHivesChanged();
    if (code === 0) return;  // clean stop — not a crash
    const window = stillTracked.window;
    if (window?.isDestroyed()) return;
    handleHiveCrash(dataDir, overrides, logPath, code ?? -1, window, keepAlive);
  });

  if (withWindow) {
    try {
      await createHiveWindow(entry);
    } catch (err) {
      // Window failed to load — tear the whole hive down so we don't leak
      // an orphaned, unreachable child process.
      hives.delete(dataDir);
      onHivesChanged();
      child.kill();
      throw err;
    }
  }
  return entry;
}

/** Kill the current hive-child and boot a fresh one with new config,
 *  reusing the existing window (if any) rather than orphaning it. */
export async function restartHive(
  dataDir: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const existing = hives.get(dataDir);
  if (!existing) return;
  const { window, keepAlive } = existing;
  existing.child.kill();
  hives.delete(dataDir);

  const next = await spawnHive(dataDir, overrides, {
    withWindow: false,
    keepAlive,
  });
  if (window && !window.isDestroyed()) {
    next.window = window;
    await window.loadURL(next.url);
  }
}

// ── Menu ──────────────────────────────────────────────────────────────

/**
 * Resolve electron-updater's `autoUpdater`.
 *
 * electron-updater is CommonJS and exposes `autoUpdater` through an
 * `Object.defineProperty` lazy getter (it defers loading the platform-
 * specific updater). Node's cjs-module-lexer can't see defineProperty-based
 * exports, so `await import('electron-updater')` yields a namespace whose
 * named `autoUpdater` binding is `undefined` — only `.default` (the real
 * `module.exports`) carries the getter. Destructuring the named export
 * silently gave `undefined`, hence the runtime
 * `Cannot read properties of undefined (reading 'checkForUpdatesAndNotify')`.
 * Reaching through `.default` fixes it; the `?? mod` fallback keeps it
 * working if a future electron-updater ships a proper ESM-friendly export.
 */
async function loadAutoUpdater() {
  const mod = await import('electron-updater');
  return (mod.default ?? mod).autoUpdater;
}

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
    const autoUpdater = await loadAutoUpdater();
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

/**
 * Right-click-the-dock-icon menu (macOS only). Mirrors the Hive menu's
 * actionable bits — New Hive… and recents — so users don't have to bring
 * a window forward just to switch hives. macOS adds Quit/Hide itself, so
 * we deliberately omit those.
 */
function buildDockMenu(): Menu {
  const items: MenuItemConstructorOptions[] = [
    { label: 'New Hive…', click: () => { void promptOpenHive(); } },
  ];
  if (recentHives.length > 0) {
    items.push({ type: 'separator' });
    items.push({ label: 'Open Recent', submenu: buildOpenRecentSubmenu() });
  }
  return Menu.buildFromTemplate(items);
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
          click: () => { void promptOpenHive(); },
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
