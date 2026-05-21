# OpenHive Electron App

Thin Electron supervisor that hosts one openhive server per window, forked
via `node:child_process` + `ELECTRON_RUN_AS_NODE=1`.

## Architecture

Supervisor (main process) + one Node child per hive:

```
electron-app/src/main.ts  (Electron main process)
  └─ child_process.fork(
       execPath: process.execPath,      ← the Electron binary
       env:      ELECTRON_RUN_AS_NODE=1, ← makes it act as plain Node 22
     )
     → electron-app/src/hive-child.ts    (plain Node process)
       └─ await import('openhive')
         → createHive({ dataDir, host: '127.0.0.1', port })
            → Fastify listens on the preallocated port
            → main posts { type: 'start', config }
            ← child posts { type: 'ready', url } when hive is listening
       → BrowserWindow.loadURL(url)
```

**Why not `utilityProcess`:** Electron's `utilityProcess` runs a restricted
Node runtime that refuses to load several native modules openhive needs
(notably `better-sqlite3`). Standard `child_process.fork` with the Electron
binary as `execPath` + `ELECTRON_RUN_AS_NODE=1` gives us Electron's embedded
Node with no such restrictions — full native-module compatibility, proper
stdio, normal IPC.

**Why preallocate the port** (see `pickFreePort()` in `main.ts`): openhive's
`SwarmManager` reads `config.port` at `createHive()` construction time,
before `fastify.listen()` has assigned the actual ephemeral port. If we
pass `port: 0`, bootstrap tokens for hosted swarms bake in `http://host:0`
and coordinators can't call back. openhive's `start()` now also updates the
instance URL after `listen()` (server-side fix), but we keep the probe as
belt-and-suspenders.

## Renderer ↔ main bridge (`window.openhive`)

`electron-app/src/preload.cts` exposes a tightly-scoped API via
`contextBridge`. Always guard for `window.openhive` being undefined — the
SPA also runs in plain browsers (`npm run dev:web`) where the bridge isn't
present.

```ts
window.openhive?.platform                    // 'darwin' | 'linux' | 'win32' | …
window.openhive?.notify({title, body, route?})  // OS notification; click → focus + onFocusRoute
window.openhive?.setBadge(count)             // dock badge (macOS) / app badge (Linux)
const dispose = window.openhive?.onDeepLink(url => { … })
const dispose = window.openhive?.onFocusRoute(route => { … })
```

Renderer integration:
- `src/web/hooks/useElectronDeepLinks.ts` wires `onDeepLink` + `onFocusRoute`
  into react-router. URL contract: `openhive://path/to/route` →
  `/path/to/route`. Wired once from `App.tsx`.
- `notify` / `setBadge` are intentionally **not** auto-wired. Trigger
  policy (which WS events fire what, dedup against focused window, what
  counts as "unread") is design-heavy and lives in feature code as it gets
  added. The bridge is just the OS call.

Cold-start deep links (URL clicked while app was closed) are gated on the
first hive's `did-finish-load` so the IPC doesn't fire into a renderer
that hasn't subscribed yet.

## Build + run

```bash
# First time setup — installs deps for all workspaces (openhive + electron-app)
# and stages dual better-sqlite3 prebuilds (Node + Electron) via postinstall.
npm install

# Dev launch — builds openhive server + web, compiles electron-app, runs it
cd electron-app && npm run dev
# or from root:
npm -w openhive-electron run dev

# Just rerun without rebuilding
cd electron-app && npm run start

# Package + verify a distributable (DMG / AppImage / deb, signed + notarized)
cd electron-app && npm run dist

# Fast local verify loop — packaged .app, no signing/notarization/DMG.
# Builds, stages, prunes, `electron-builder --dir`, then runs verify-asar
# + smoke-test (the smoke-test launches with cwd `/`, mimicking a Finder
# launch — so it catches cwd-relative path bugs a dev run would hide).
cd electron-app && npm run pack

# Re-run just the guards against the last build (seconds, no rebuild)
cd electron-app && npm run verify
```

> **Restoring after `dist` / `pack`.** Both run `stage-openhive.mjs` +
> `prune-node-modules.mjs`, which are *destructive* to the shared
> `node_modules` — they swap the `openhive` workspace symlink for a pruned
> copy and strip `.d.ts` / test dirs from inside packages. Restore with
> **`npm ci`** at the repo root, **not `npm install`**: `npm install` sees
> the gutted package directories as still-installed and won't repair them,
> so the next build fails (e.g. `Cannot find type definition file for
> 'node'`). `npm ci` wipes `node_modules` first and always restores cleanly.

## Debugging

### Renderer (the React SPA inside the BrowserWindow)

- `Cmd+Option+I` in the running app → native Chrome DevTools panel
- Since the hive serves plain HTTP on loopback, you can also open the hive's
  URL (`http://127.0.0.1:<port>/`) in regular Chrome and debug without
  Electron — the React + API behavior is identical. Faster iteration loop
  when the bug isn't Electron-specific.

### Main process (the supervisor)

```bash
electron --inspect-brk=5858 dist/main.js
```
Then `chrome://inspect` → "Configure" → add `localhost:5858` → click Inspect.
Breakpoints in `spawnHive`, menu handlers, IPC routing.

### Hive-child (the forked Node process)

The child is a separate process from main — `--inspect` on the parent doesn't
cover it. Pass `execArgv` to `fork()` in `main.ts#spawnHive`:

```ts
execArgv: process.env.OPENHIVE_DEBUG_HIVE
  ? [`--inspect=${9229 + hives.size}`]
  : [],
```

Launch with `OPENHIVE_DEBUG_HIVE=1 npm run start`. Each hive gets a distinct
port so multi-hive debugging doesn't collide.

### Via chrome-devtools-mcp

Two approaches:

**1. Point MCP's Chrome at the hive URL** (easy, ~95% of debugging).
- Launch Electron, grab the URL from `~/.openhive/logs/hive.log` (or wherever `defaultHiveDataDir()` resolved to — see Logs + data)
- `mcp__.../new_page` with `http://127.0.0.1:<port>/`
- Use `take_snapshot`, `click`, `list_network_requests`, `list_console_messages`, `evaluate_script`
- Covers: React state, network, console, API integration. Misses: Electron IPC, preload, native menu interactions.

**2. Attach directly to Electron's renderer via CDP** (for Electron-specific bugs).
- Launch with `OPENHIVE_REMOTE_DEBUG=9223` (wired in `main.ts`)
- Fetch `http://127.0.0.1:9223/json/list` to find the renderer target's `webSocketDebuggerUrl`
- Use a raw CDP WebSocket client to run `Page.captureScreenshot`, `Runtime.evaluate`, etc.
- This is the actual Electron window, not a separate Chrome.

**Differentiating what each approach tests**: if a bug appears when chrome-devtools-mcp's Chrome loads the same URL, it's a SPA/API bug. If it only appears in the real Electron renderer (option 2), it's Electron-specific (preload, IPC, context isolation, etc.).

## Logs + data

Two distinct trees, deliberately separated:

**Hive data** lives at `~/.openhive/` by default — same path the `openhive` CLI uses. Means a user with existing CLI data sees it in the app and vice versa. Overridable via `OPENHIVE_HOME` env var (e.g. `OPENHIVE_HOME=/tmp/hive open /Applications/OpenHive.app`). "New Hive…" / "Open Hive…" in the menu let you point individual hives at any path; only the *default* hive on launch resolves through `defaultHiveDataDir()` in `main.ts`.

**App state** stays at the platform-standard `app.getPath('userData')` so Electron behaves conventionally for crash dumps, GPU cache, etc.

| What | Where |
|---|---|
| hive-child stdout/stderr (openhive's pino + `console.log`) | `<hive-dataDir>/logs/hive.log` |
| Supervisor stdout | Terminal where Electron was launched (invisible in packaged builds) |
| Default `<hive-dataDir>` | `~/.openhive/` (or `$OPENHIVE_HOME`) |
| SQLite DB | `<hive-dataDir>/data/openhive.db` |
| IAM signing secret | `<hive-dataDir>/data/iam-secret.key` |
| Session trajectory cache | `<hive-dataDir>/data/sessions/` |
| Uploads | `<hive-dataDir>/uploads/` |
| Per-hive window bounds | `<hive-dataDir>/window-state.json` |
| openhive-root marker | `<hive-dataDir>/.openhive-root` |
| macOS `<userData>` (app-level) | `~/Library/Application Support/OpenHive/` |
| Crash dumps | `<userData>/Crashpad/` |
| Recent-hives MRU | `<userData>/recent-hives.json` |
| App settings (tray-mode toggles) | `<userData>/settings.json` |

Every line the hive-child writes is piped to **both** the per-hive log file and
the supervisor's stderr (see `child.stdout.on('data', ...)` in `spawnHive`).
Tail one place, see everything.

## Environment variables

| Name | Set by | Effect |
|---|---|---|
| `ELECTRON_RUN_AS_NODE=1` | Supervisor → child fork | Makes the Electron binary act as plain Node in the child |
| `OPENHIVE_HOME` | User → Electron main (and Supervisor → child fork) | Default hive's dataDir. Read by `defaultHiveDataDir()` at launch; if unset, falls back to `~/.openhive/`. Also forwarded into the hive-child so anything that calls `resolveDataDir()` inside the openhive runtime agrees. |
| `OPENHIVE_REMOTE_DEBUG` | User → Electron main | If set, exposes Chromium's CDP at that port (e.g. `OPENHIVE_REMOTE_DEBUG=9223`) |
| `OPENHIVE_DEBUG_HIVE` | User → Electron main | (Optional hook) pass `--inspect` to forked hive-children |
| `OPENHIVE_HEADLESS` | User → Electron main | `1` forces headless/tray-only launch, `0` forces headed — overrides the persisted `headless` setting for that launch. See "Headless / tray-only mode". |

## Headless / tray-only mode

The supervisor can boot a hive **without a window** — the Fastify server runs,
the app sits in the system tray / menu bar, and the UI window is built on
demand. The hive-child (the server process) was always independent of the
window; headless mode just makes window creation optional.

**Triggers** (precedence high → low):

1. `--no-tray` / `OPENHIVE_HEADLESS=0` — force headed for this launch
2. `--tray` / `OPENHIVE_HEADLESS=1` — force headless for this launch
3. the persisted `headless` flag in `<userData>/settings.json`

> The CLI flag is `--tray`, **not** `--headless` — `--headless` is a reserved
> Chromium switch Electron would intercept before `main.ts` could read it.

**Tray menu** carries two persisted toggles (written to `settings.json`):
- *Open in Background on Launch* → `settings.headless`
- *Open at Login* → `settings.startAtLogin`, which drives
  `app.setLoginItemSettings({ openAtLogin, args: ['--tray'] })` so a sign-in
  auto-start lands in the tray. No-op on Linux (no `setLoginItemSettings`
  support — the toggle is disabled there).

**Window lifecycle decoupling.** `spawnHive` splits into `spawnHiveChild`
(fork + boot the server) and `createHiveWindow` (build the BrowserWindow).
`HiveEntry.window` is `BrowserWindow | null`. Key behavioural difference:
in headless mode, **closing a hive window does not stop the hive** — it just
disposes the window; the server keeps running, reachable again from the tray.
In headed mode, closing the window still closes the hive (unchanged).

**macOS dock.** Headless launch calls `app.dock.hide()` for a true menu-bar
app. The icon returns via `app.dock.show()` when a window opens from the tray
and hides again when the last window closes.

**Verify locally** (server boots, no window):
```bash
OPENHIVE_HOME=/tmp/h OPENHIVE_REMOTE_DEBUG=9223 \
  electron dist/main.js --tray --user-data-dir=/tmp/ud
# curl http://127.0.0.1:9223/json/list        → zero "type":"page" targets
# curl http://127.0.0.1:<hive-port>/.well-known/openhive.json → 200
```

## Known gotchas (debug anchors for future sessions)

**`config.port=0` poisons bootstrap tokens.** `SwarmManager` reads `config.port` at construction — before `fastify.listen()` has assigned the ephemeral port. If passed 0, coordinators get `http://host:0` and can't phone home. We `pickFreePort()` before calling `createHive()` (belt); openhive's `start()` calls `swarmManager.setInstanceUrl()` after listen (suspenders).

**better-sqlite3 ships two prebuilds side-by-side (Electron + Node).** `electron-builder install-app-deps` rebuilds from source against Electron's V8 headers, but the resulting binary silently aborts at `new Database(...)` — likely a SQLite-symbol conflict with the copy Chromium bundles for cookies/IDB. Meanwhile, plain `npm run dev` runs under Node 22 (ABI 127) and can't load an Electron binary. `electron-app/scripts/fix-better-sqlite3.mjs` (runs via postinstall) stages **both** prebuilds:

- `node_modules/better-sqlite3/build/Release-electron/better_sqlite3.node` — fetched via `prebuild-install --runtime=electron --target=<electronVersion>`
- `node_modules/better-sqlite3/build/Release-node/better_sqlite3.node` — fetched via `prebuild-install --runtime=node --target=<process.versions.node>`

The script then idempotently patches `lib/database.js` (guarded by a `// openhive-dual-runtime-patch` marker) to replace the default `require('bindings')('better_sqlite3.node')` with a runtime selector: `Release-electron/` under Electron, `Release-node/` under plain Node. Both dev loops work from the same install — no re-toggling. If you ever see a silent `code=null` exit from hive-child with no JS stack, or `NODE_MODULE_VERSION` mismatch errors from the hive server, check that both directories exist and the patch marker is present in `lib/database.js`.

**Nested `better-sqlite3` copies.** Several transitive deps (`git-cascade`, `skill-tree-indexer`, etc.) pin older `better-sqlite3` versions that don't compile under modern Xcode AND don't ship Electron prebuilds. `fix-better-sqlite3.mjs` walks `node_modules/` + `references/` and deletes every nested copy so everyone dedups to the top-level `@12.8.0`. Runs on every `npm install`. All first-party dependencies currently resolve from the npm registry — no `file:` / symlinked packages into `references/` — but the walk is kept defensively for future workspace links.

**Electron 37's Node ABI is `v136`, not `v127`.** Node 22's standard ABI is v127. Electron's embedded Node uses a V8 build with a different ABI — hence the Electron-specific prebuild is a separate artifact from the Node one. A single `build/Release/` slot can only satisfy one runtime at a time, which is why the postinstall stages both under `Release-electron/` + `Release-node/` and patches `lib/database.js` to select at load time via `process.versions.electron`.

**`swarmcraft@0.1.10` on npm was a stale publish.** Missing the `mapClientManager` plugin-option wiring openhive's ownership-contract guard requires. `0.1.11` fixes it — pin `^0.1.11` or later.

**ESM/CJS module resolution for the electron-app bundle.** `tsconfig.json` emits NodeNext ESM. `electron-app/package.json` has `"type": "module"` via the generated `dist-electron/package.json`... actually no, we build to `electron-app/dist/` now and the parent `electron-app/package.json` already has `"type": "module"`. When the hive-child does `await import('openhive')`, it uses the variable-specifier trick (`const specifier = 'openhive'; await import(specifier)`) to bypass TS's static type resolution — so tsc doesn't complain even when openhive's dist lacks a `.d.ts`.

**Multi-hive architecture.** `app.requestSingleInstanceLock()` prevents multiple Electron app processes. Multi-hive lives inside a single Electron instance — "New Hive…" in the menu forks an additional `child_process.fork` with its own `dataDir`, own SQLite file, own Fastify listener, own BrowserWindow. Each is fully isolated; a hive crash shows a per-window restart dialog without taking down siblings.

**`dist/` vs `dist/web/` cleanup.** `npm run build:server` runs `tsup` with `clean: true` — wipes the whole `dist/` directory, including `dist/web/`. If you rebuild just the server, the SPA is gone until you also run `npm run build:web`. `npm run build` (no suffix) runs both.

**Package names collide on npm.** `openhive` as a name on npm registry points at a different project (not ours). Don't rely on the registry to resolve our package — use file: refs in workspaces, or pin to a scoped name. The `/api/v1/version/check` route checks GitHub Releases specifically for this reason.

## Directory structure

```
electron-app/
├── package.json                      # workspace deps, electron-builder config, publish target
├── tsconfig.json                     # NodeNext ESM → dist/
├── CLAUDE.md                         # this file
├── build/
│   └── entitlements.mac.plist        # Hardened Runtime entitlements (for signed builds)
├── src/
│   ├── main.ts                       # Supervisor: windows, menu, fork hive-child, auto-update
│   ├── hive-child.ts                 # In-process openhive server via child_process.fork
│   └── preload.cts                   # Renderer preload — window.openhive bridge.
│                                     # .cts (→ .cjs): sandboxed preloads must be CJS.
├── scripts/
│   └── fix-better-sqlite3.mjs        # postinstall: dedup nested copies, fetch Electron prebuild
└── dist/                             # tsc output (gitignored)
```

## Publishing + auto-update

`checkForUpdatesAndNotify()` fires on `app.whenReady()`, gated on `app.isPackaged`
so dev runs are no-ops. Fetches `latest-mac.yml` / `latest-linux.yml` from
GitHub Releases (configured in `package.json`'s `build.publish`), delta-downloads
any newer installer via `.blockmap`, and prompts the user to restart.

Release trigger: push a `v*` tag → `.github/workflows/release.yml` runs
electron-builder on both macOS (arm64) and Linux (x64), publishes artifacts.

**Manual check path**: `App menu → Check for Updates…` calls `autoUpdater.checkForUpdates()`
with a friendly dialog on "latest" / "only-in-packaged" / "error" outcomes.

**In-UI banner**: the React SPA polls `/api/v1/version/check` hourly. Endpoint
reads openhive's own `package.json` version (walks up from `import.meta.url`
to find the one whose `name === 'openhive'`), compares against latest from
GitHub Releases, returns `{ current, latest, updateAvailable, deployment, instructions }`.
Banner branches on `deployment`:
- `electron` → "The app will prompt to restart when the download finishes"
- `web`      → "Download from GitHub" link

See `src/web/components/common/UpdateBanner.tsx`.

## Related docs

- `docs/ELECTRON_PACKAGING.md` — end-to-end architecture + rollout plan
- Root `CLAUDE.md` — openhive itself (Fastify, MAP hub, SwarmCraft integration, etc.)
