# OpenHive as an Electron Desktop App

**Status:** Draft — open for iteration
**Owner:** TBD
**Last updated:** 2026-04-18

## Goals

Ship OpenHive (Fastify backend + React/Vite frontend) as a single-download desktop app that a user can install and run with no terminal, no `npm install`, and no manual config.

### Non-goals (for v1)

- **Windows.** Three features (opentasks daemon IPC over Unix sockets, PTY terminal via `sh -c`, sandboxed swarm provider) are fundamentally Unix-only. macOS and Linux are the v1 targets; Windows is deferred indefinitely.
- Replacing the current Node package or CLI distribution. The Electron app is an *additional* delivery channel, not a replacement.
- Bundling external mesh binaries (Headscale, Tailscale). These remain opt-in; users who want mesh networking install the binary themselves, same as the CLI today.

---

## Why this is feasible

Three properties of the current code make this relatively cheap:

1. **`createHive()` is already a clean programmatic entry** (`src/server.ts:63`). It accepts either a config path or a partial `Config` object and returns `{ fastify, config, start(), stop() }`. The Electron hive-child process calls it directly — no refactor of `cli.ts` needed.
2. **The frontend is same-origin and fully relative.** `src/web/lib/api.ts` uses `/api/v1`; `useWebSocket.ts` builds its URL from `window.location.host` + `/ws`. Whatever host/port Fastify binds to, the frontend adapts. No `VITE_API_URL` plumbing required.
3. **Data directory is already overridable.** `src/data-dir.ts` honors `OPENHIVE_HOME` and an explicit override. Pointing OpenHive at `app.getPath('userData')` is a one-line change.

Fastify already serves the built SPA from `dist/web/` (`server.ts:559`), so the Electron renderer just loads `http://127.0.0.1:<port>/`. We do **not** need `file://` asset loading or a separate static server.

---

## Proposed architecture

One **supervisor process** (Electron main) plus **one Node utility process per hive**. Each hive process owns its own `createHive()` instance, its own SQLite file, and its own ephemeral port. The supervisor holds no hive state — it only manages windows and child lifecycle.

```
┌──────────────────────────────────────────────────────────┐
│ Electron main (supervisor — no hive state)              │
│  - app.whenReady() → spawnHive(userData)                │
│  - Map<dataDir, { child, window, url }>                 │
│  - Menu: "New Hive…" → pick dataDir → spawnHive()       │
│  - Crash dialog on child exit                           │
└─────┬──────────────────────────────────┬─────────────────┘
      │ utilityProcess.fork              │
      ▼                                  ▼
┌────────────────────────────┐  ┌────────────────────────────┐
│ hive-child (default hive)  │  │ hive-child (optional 2nd)  │
│   createHive({             │  │   createHive({             │
│     dataDir: userData,     │  │     dataDir: otherDir,     │
│     host: '127.0.0.1',     │  │     host: '127.0.0.1',     │
│     port: 0,               │  │     port: 0,               │
│   })                       │  │   })                       │
│   → postMessage(ready,url) │  │   → postMessage(ready,url) │
└─────────────┬──────────────┘  └─────────────┬──────────────┘
              │ loopback                      │ loopback
              ▼                               ▼
       BrowserWindow A                 BrowserWindow B
       loadURL(childA.url)             loadURL(childB.url)
```

**Why process-per-hive:** the server holds critical state at *module* scope (`db/index.ts`, `initJwks`, `initTokenService`, storage singletons). Isolating each hive in its own Node process means zero server-side refactor — every hive gets its own module scope. Bonus: one hive crashing doesn't take down the others, and SwarmHub mode switching reduces to "respawn the child."

**Key shape decisions:**

- **Supervisor owns no hive state.** Main is a pure window + child manager. All Fastify/DB/sync state lives in utility processes.
- **Bind loopback-only** (`127.0.0.1`) with an **ephemeral port** (`port: 0`) inside each hive child, so we don't clash with a user's `openhive serve` on `:7836` and don't expose the API to the LAN.
- **Every hive runs in a utilityProcess, including the default one.** Consistent mental model costs ~100MB of extra memory over the single-process design and buys cleaner code + crash isolation.
- **Single-instance Electron app.** `app.requestSingleInstanceLock()` focuses the existing window on second launch. Multi-hive is a menu click, not a second app instance.
- **No separate Vite dev server in production.** The hive child's Fastify serves the built SPA. Dev mode can still use `vite` externally — see Dev Mode below.
- **SwarmHub mode switching = respawn the hive child.** See [SwarmHub mode switching](#swarmhub-mode-switching-respawn-the-hive-child).

### IPC protocol (supervisor ↔ hive-child)

Minimum viable surface — expand as needed.

| Direction | Message | Purpose |
|---|---|---|
| → child | `{ type: 'start', config }` | Run `createHive(config)` + `.start()`. |
| → child | `{ type: 'stop' }` | Graceful shutdown (`hive.stop()` then `process.exit(0)`). |
| ← child | `{ type: 'ready', url }` | Fastify listening; supervisor loads `url` in the window. |
| ← child | `{ type: 'error', message, fatal }` | Boot or runtime failure; fatal triggers crash dialog. |
| ← child | `{ type: 'log', level, msg }` | Optional: forward pino logs to `<userData>/logs/hive-<slug>.log`. |

Restart = kill + respawn. The child itself never handles "switch config" — the supervisor owns that.

---

## Reference sketch

Starting point for `electron/main.ts` and `electron/hive-child.ts`. Not production — missing log rotation, persisted settings, recent-hives list, crash-report telemetry. But it's enough to get Phase 1 launching.

### `electron/main.ts` (supervisor)

```ts
import {
  app, BrowserWindow, Menu, dialog,
  utilityProcess, UtilityProcess,
} from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

interface HiveEntry {
  child: UtilityProcess;
  window: BrowserWindow;
  dataDir: string;
  url: string;
}

const hives = new Map<string, HiveEntry>();

// Single-instance: focus existing window on second launch
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

app.whenReady().then(async () => {
  await spawnHive(app.getPath('userData'));
  Menu.setApplicationMenu(buildMenu());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  e.preventDefault();
  await Promise.allSettled(
    [...hives.values()].map(({ child }) =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.postMessage({ type: 'stop' });
        setTimeout(() => { child.kill(); resolve(); }, 3000);
      })
    )
  );
  app.exit(0);
});

async function spawnHive(
  dataDir: string,
  overrides: Record<string, unknown> = {},
): Promise<HiveEntry> {
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const logPath = path.join(dataDir, 'logs', 'hive.log');

  const child = utilityProcess.fork(
    path.join(__dirname, 'hive-child.js'),
    [],
    {
      serviceName: `openhive-${path.basename(dataDir)}`,
      stdio: 'pipe',
    },
  );
  child.stdout?.pipe(fs.createWriteStream(logPath, { flags: 'a' }));
  child.stderr?.pipe(fs.createWriteStream(logPath, { flags: 'a' }));

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('hive boot timeout (30s)')),
      30_000,
    );
    child.on('message', (msg: any) => {
      if (msg.type === 'ready') { clearTimeout(timer); resolve(msg.url); }
      else if (msg.type === 'error' && msg.fatal) {
        clearTimeout(timer); reject(new Error(msg.message));
      }
    });
    child.postMessage({
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

  const entry: HiveEntry = { child, window, dataDir, url };
  hives.set(dataDir, entry);

  window.on('closed', () => {
    child.postMessage({ type: 'stop' });
    hives.delete(dataDir);
  });

  child.on('exit', (code) => {
    if (code !== 0 && !window.isDestroyed()) {
      dialog.showMessageBox(window, {
        type: 'error',
        title: 'Hive crashed',
        message: `Hive at ${dataDir} exited (code ${code}).`,
        buttons: ['Restart', 'Close'],
      }).then((r) => {
        if (r.response === 0) spawnHive(dataDir, overrides);
        else window.close();
      });
    }
  });

  return entry;
}

export async function restartHive(
  dataDir: string,
  overrides: Record<string, unknown>,
) {
  const existing = hives.get(dataDir);
  if (!existing) return;
  existing.child.kill();
  hives.delete(dataDir);
  const next = await spawnHive(dataDir, overrides);
  // Reuse the same window the user already had open
  await existing.window.loadURL(next.url);
}

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
          click: async () => {
            const r = await dialog.showOpenDialog({
              properties: ['openDirectory', 'createDirectory'],
              title: 'Choose a folder for the new hive',
            });
            if (!r.canceled && r.filePaths[0]) await spawnHive(r.filePaths[0]);
          },
        },
      ],
    },
  ]);
}
```

### `electron/hive-child.ts` (utilityProcess entry)

```ts
type HiveServer = { start(): Promise<string>; stop(): Promise<void> };

let hive: HiveServer | null = null;

process.parentPort.on('message', async ({ data }) => {
  try {
    if (data.type === 'start') {
      // Dynamic import so hive-child compiles to CJS while loading ESM openhive.
      const { createHive } = await import('openhive');
      hive = await createHive(data.config);
      const url = await hive.start();
      process.parentPort.postMessage({ type: 'ready', url });
    } else if (data.type === 'stop') {
      if (hive) await hive.stop();
      process.exit(0);
    }
  } catch (err) {
    process.parentPort.postMessage({
      type: 'error',
      message: (err as Error).message,
      fatal: true,
    });
    process.exit(1);
  }
});
```

### What the sketch deliberately omits

- **The `process.execPath` spawn fix** — lives in `src/swarm/providers/local.ts`, `src/swarm/providers/sandboxed-local.ts`, and `src/map/task-daemon-lifecycle.ts`, not in the Electron entry. See [Compatibility work](#compatibility-work).
- **Settings persistence** — `<userData>/config.json` read/write. Supervisor passes the loaded config into `spawnHive` overrides; preferences UI writes back and calls `restartHive`.
- **Recent hives list** — persist opened data dirs in `<userData>/recent-hives.json`, surface in the Hive menu submenu.
- **macOS `activate` handler** — reopen the default hive's window when the user clicks the dock icon with no windows open.
- **Log rotation** — the sketch appends forever. Rotate at boot (`hive.log` → `hive.log.1`) or switch to `pino-rotating-file` once we move logging to proper pino streams.

---

## Build & distribution

### Toolchain

- **`electron`** — app shell
- **`electron-builder`** — packaging + code signing + auto-update
- **`electron-rebuild`** (or `@electron/rebuild`) — native module rebuilds

### New directory layout

```
electron/
├── main.ts           # Supervisor entry: windows, menu, spawnHive()
├── hive-child.ts     # utilityProcess entry: wraps createHive() + IPC
├── preload.ts        # Renderer preload (minimal — no IPC needed v1)
├── tsconfig.json     # Separate tsconfig, CommonJS output
└── menu.ts           # App menu (incl. "New Hive…")
```

### Build pipeline

```
npm run build:electron
  ├── npm run build:server       # existing tsup → dist/
  ├── npm run build:web          # existing vite → dist/web/
  ├── tsc -p electron/           # → dist-electron/{main,hive-child,preload}.js
  └── electron-builder            # → release/OpenHive-<ver>.dmg
```

The `electron-builder` config declares three files/dirs to include in the asar:
- `dist/` (server + web bundle — consumed by hive-child)
- `dist-electron/` (main, hive-child, preload)
- `node_modules/` with `asarUnpack` for native deps (see below)

### `package.json` additions (sketch)

```json
{
  "main": "dist-electron/main.js",
  "scripts": {
    "build:electron": "npm run build && tsc -p electron && electron-builder",
    "dev:electron": "concurrently \"npm run dev\" \"npm run dev:web\" \"wait-on http://localhost:5173 && electron .\""
  },
  "build": {
    "appId": "com.openhive.desktop",
    "productName": "OpenHive",
    "files": ["dist/**", "dist-electron/**"],
    "asarUnpack": [
      "node_modules/better-sqlite3/**",
      "node_modules/bcrypt/**",
      "node_modules/sharp/**",
      "node_modules/@lydell/node-pty/**"
    ],
    "mac": { "category": "public.app-category.developer-tools" }
  }
}
```

The existing `"main": "dist/index.mjs"` is the Node library entry; the Electron entry replaces it **only in the packaged build**. We'll need to either move the library entry under `exports["."]` (already there) and flip `"main"`, or keep two package.json files (standard electron-builder pattern).

---

## Compatibility work

Everything in OpenHive works under Electron on macOS/Linux with two small server-side changes plus the standard native-rebuild dance.

### 1. Native module rebuilds

OpenHive depends on several native N-API modules:

| Module | Used for | Notes |
|---|---|---|
| `better-sqlite3` | Primary DB | The canary — if this loads, the rebuild pipeline works |
| `bcrypt` | Password hashing | Straightforward rebuild |
| `sharp` | Image processing | Largest native deps; worth early smoke testing |
| `@lydell/node-pty` | Terminal tunneling | Rebuilds cleanly on macOS/Linux |

These are compiled against Node's ABI, not Electron's. Without rebuilding, they fail at `require()` time with cryptic ABI errors.

**Fix:** `@electron/rebuild` runs automatically as part of `electron-builder`'s postinstall when it detects native modules. Each native dep must be listed in `asarUnpack` — native `.node` files can't be loaded from inside an asar archive.

### 2. Spawning Node children via `process.execPath`

Two spawn sites assume `node` / `opentasks` are on `$PATH`, which isn't true inside an Electron bundle:

- `src/swarm/providers/local.ts:224` — `spawn(bin, args, ...)` where `bin` resolves to `node`
- `src/swarm/providers/sandboxed-local.ts:249` — same pattern
- `src/map/task-daemon-lifecycle.ts:218` — `spawn('opentasks', ['daemon', 'start'])`

The fix is Electron's standard pattern: use `process.execPath` (the Electron binary, which runs as Node when invoked with `ELECTRON_RUN_AS_NODE=1`), and resolve the target script path via `require.resolve` rather than `$PATH`.

```ts
// Before
spawn('node', [swarm-runnerBin, 'serve'], { env: process.env, ... });

// After
spawn(process.execPath, [swarm-runnerBin, 'serve'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  ...
});
```

For opentasks, `require.resolve('opentasks/package.json')` finds the bundled package; the daemon entry is at `<pkgDir>/bin/opentasks.js` (or similar — to confirm at implementation).

These edits are safe to land on `main` regardless of Electron — `process.execPath` in normal Node is just the `node` binary, and `ELECTRON_RUN_AS_NODE` is ignored outside Electron. Zero regression risk for the CLI distribution.

**Budget:** ~half a day including smoke-testing an actual hosted swarm spawn from a packaged `.app`.

### 3. External-binary features (unchanged from CLI)

These features already require the user to install a binary — no change from today's behavior:

- `git` commands (task daemon project detection, cascade integration) — virtually all users have this
- Headscale / Tailscale mesh networking — opt-in, off by default; users who want mesh install the binary themselves

GUI-launched macOS apps inherit a limited `$PATH` that typically includes `/usr/bin` (so system git works) but excludes `/usr/local/bin` and Homebrew locations. If a user has git only in `/opt/homebrew/bin`, the features silently fail. Acceptable for v1; fixable later by prepending common locations to `$PATH` in the supervisor.

---

## Other packaging considerations

### Config file discovery (`src/data-dir.ts:91`)

`findConfigFile()` checks `process.cwd()` first. In an installed Electron app, `process.cwd()` is the OS-dependent working dir at launch time (usually `/` on macOS), which will never contain `openhive.config.json`. This is fine — it falls through to `<dataDir>/config.json`, which we control.

First-launch flow: the app creates `<userData>/.openhive-root` and writes a minimal `config.json` if one doesn't exist. `ensureDataDir()` already exists for this (`data-dir.ts:47`).

### Auth mode

Default the Electron build to `auth.mode: 'local'`. The local-auth code path already treats every request as the auto-provisioned local agent (`server.ts:82`), which is exactly what a single-user desktop app wants. No login UI needed on first launch.

### CORS + hostname guard

With loopback-only binding and the renderer loading the same origin, CORS isn't triggered. The hostname guard middleware (`api/middleware/hostname-guard.ts`) needs to allow `127.0.0.1` — check whether the current default does.

### Logging

Fastify's default `pino` logger writes to stdout. In an installed Electron app, stdout is invisible. Redirect to `<userData>/logs/openhive-<date>.log` using `pino.destination()`. Rotate manually or accept unbounded growth in v1.

### Auto-update

`electron-builder` integrates with `electron-updater` out of the box. For v1, ship a GitHub Releases feed and enable auto-update behind a user preference. Signing (required on macOS for auto-update) means we need an Apple Developer account — flag this as a prerequisite.

### Code signing

- **macOS:** Apple Developer ID + notarization. Without this, the app shows a scary Gatekeeper warning on first launch.
- **Linux:** No signing needed; ship AppImage or `.deb`.

Signing is a chore, not a risk. Budget a day for macOS (the Apple Developer account + notarization dance is the slow part).

---

## Dev mode

During development we want hot-reload on both sides:

```
Terminal 1:  npm run dev           # tsx watch, Fastify on :3000
Terminal 2:  npm run dev:web       # Vite dev server on :5173
Terminal 3:  electron .            # loads http://localhost:5173
                                   # Vite proxies /api → :3000
```

Electron main detects `NODE_ENV=development` and either:
- Loads the Vite dev URL directly (faster iteration), or
- Starts an in-process Fastify + loads the Fastify URL (closer to prod).

Both should work; default to option 1 for dev velocity.

---

## Phased rollout

### Phase 1 — "It launches on macOS" (target: ~4 days)

- `electron/main.ts` supervisor: spawns default hive via `utilityProcess.fork()`, manages BrowserWindow lifecycle
- `electron/hive-child.ts` entry: wraps `createHive()` and speaks the IPC protocol
- Minimal IPC surface: `start`, `stop`, `ready`, `error`
- **`process.execPath` spawn fix** landed on `main`: `swarm/providers/local.ts`, `swarm/providers/sandboxed-local.ts`, `map/task-daemon-lifecycle.ts`
- `electron-builder` config producing unsigned `.dmg`
- Native module rebuild validated in utilityProcess (`better-sqlite3`, `bcrypt`, `sharp`, `@lydell/node-pty`)
- Smoke test: open app, create post, spawn a hosted swarm, restart, data persists

### Phase 2 — "It ships on macOS" (target: 1 week after Phase 1)

- macOS signing + notarization
- Auto-update wired to GitHub Releases
- App menu (Quit, Preferences, About, **New Hive…**)
- Per-hive logs: child stdout/stderr → `<userData>/logs/hive-<slug>.log`
- First-launch onboarding (set display name, pick instance name)
- **SwarmHub mode switching** — preferences toggle triggers supervisor to respawn the hive child with new config
- **Multi-hive UX** — "New Hive…" data-dir picker + recent-hives list in the menu
- Crash dialog on hive child exit (offer to restart)

### Phase 3 — "Linux ships too" (target: ~2 days after Phase 2)

- Linux AppImage + `.deb`
- Rebuild native modules for Linux x64 and arm64
- Validate the `process.execPath` spawn fix on Linux (should be identical to macOS)
- Tray icon + background mode (macOS + Linux)
- Deep linking (`openhive://` URLs)

---

## Decisions

1. **CWD `.openhive/` behavior — no.** Desktop always uses `app.getPath('userData')` (or a user-chosen alternate dir when opening a second hive). The CLI already handles the "launch here" case; duplicating it invites "which data dir is real?" confusion.
2. **Instance model — supervisor + one utilityProcess per hive.** Single-instance Electron app focuses the existing window on second launch. Multi-hive is a natural consequence of the process-per-hive design: "New Hive…" in the menu forks another child. One hive is the default UX; additional hives are a menu click away.
3. **App name and icon — using existing placeholders for now.** We have icons available; a final `.icns` / `.ico` / `.png` set can land before public release.
4. **SwarmHub mode switching — respawn the hive child.** Supervisor kills the utilityProcess and forks a new one with the updated config. OS-level teardown sidesteps the in-process singleton audit entirely. See [SwarmHub mode switching](#swarmhub-mode-switching-respawn-the-hive-child).
5. **Hidden child-process deps — none surprising.** Grep confirms the spawn/exec call sites are only `opentasks`, `swarm-runner` (via swarm providers), `git`, and `headscale`/`tailscale` version probes (CLI-only, not server). Node-child spawns are fixed via `process.execPath` (see [Compatibility work](#compatibility-work)); `git` relies on the user's system install (unchanged from CLI).
6. **Platform scope — macOS and Linux only.** Windows is not a v1 target. Three features (opentasks daemon IPC over Unix sockets, PTY terminal via `sh -c`, sandboxed swarm provider) are fundamentally Unix-only; porting them to Windows is a separate body of work we're not taking on.

## SwarmHub mode switching (respawn the hive child)

Toggling `auth.mode` between `'local'` and `'swarmhub'` requires reinitializing JWKS, the SwarmHub connector, and auth middleware. Because each hive runs in its own utilityProcess, switching modes is just respawning the child.

### Design

```ts
async function restartHive(dataDir: string, overrides: Partial<Config>) {
  const existing = hives.get(dataDir)!;
  existing.child.kill();                        // OS-level teardown
  const next = await spawnHive(dataDir, overrides);
  await existing.window.loadURL(next.url);      // reattach the same window
  hives.set(dataDir, { ...next, window: existing.window });
}
```

When the user toggles SwarmHub in preferences:

1. Save the new auth config to `<userData>/config.json`.
2. Supervisor kills the hive child, forks a fresh one with the updated config.
3. Window reloads the new URL; the frontend's existing WebSocket auto-reconnect handles the ~1s gap.

This is strictly cleaner than in-process `stop() → start()` because the OS does the teardown for us — no singleton audit, no leak-detection test, no "did we unhook every listener?" anxiety. If the new child fails to boot, the old one is already gone; supervisor shows the crash dialog and lets the user correct the config.

### Budget

~2-4 hours once the supervisor + hive-child infrastructure is in place (Phase 1). The preferences UI hook is the only custom work.

---

## Not doing

- **Windows.** Opentasks daemon IPC uses Unix sockets; the PTY terminal uses `sh -c`; the sandboxed swarm provider uses macOS sandbox-exec or Linux bwrap. Each of these needs a dedicated Windows port. Not in v1-v3 scope.
- Bundling Postgres. SQLite is the desktop default forever.
- Rewriting the Fastify server as Electron IPC handlers. Keeping a real HTTP server means the same codebase serves Docker, PaaS, and desktop — that's the whole point.
- Storing secrets in Electron's safeStorage. The JWT signing key and API tokens live in SQLite today; that's good enough for a single-user app. Revisit if we add a sync-to-cloud story.
