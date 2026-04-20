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

## Build + run

```bash
# First time setup — installs deps for all workspaces (openhive + electron-app)
# and fetches the Electron-specific better-sqlite3 prebuild via postinstall.
npm install

# Dev launch — builds openhive server + web, compiles electron-app, runs it
cd electron-app && npm run dev
# or from root:
npm -w openhive-electron run dev

# Just rerun without rebuilding
cd electron-app && npm run start

# Package a distributable (DMG / AppImage / deb, unsigned until signing is set up)
cd electron-app && npm run dist
```

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
- Launch Electron, grab the URL from `~/Library/Application Support/OpenHive/logs/hive.log`
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

| What | Where |
|---|---|
| hive-child stdout/stderr (openhive's pino + `console.log`) | `<userData>/logs/hive.log` |
| Supervisor stdout | Terminal where Electron was launched (invisible in packaged builds) |
| macOS `<userData>` | `~/Library/Application Support/OpenHive/` |
| SQLite DB | `<userData>/data/openhive.db` |
| Session trajectory cache | `<userData>/data/sessions/` |
| Uploads | `<userData>/uploads/` |

Every line the hive-child writes is piped to **both** the per-hive log file and
the supervisor's stderr (see `child.stdout.on('data', ...)` in `spawnHive`).
Tail one place, see everything.

## Environment variables

| Name | Set by | Effect |
|---|---|---|
| `ELECTRON_RUN_AS_NODE=1` | Supervisor → child fork | Makes the Electron binary act as plain Node in the child |
| `OPENHIVE_HOME` | Supervisor → child fork | Overrides openhive's data-dir auto-detect to the BrowserWindow's dataDir |
| `OPENHIVE_REMOTE_DEBUG` | User → Electron main | If set, exposes Chromium's CDP at that port (e.g. `OPENHIVE_REMOTE_DEBUG=9223`) |
| `OPENHIVE_DEBUG_HIVE` | User → Electron main | (Optional hook) pass `--inspect` to forked hive-children |

## Known gotchas (debug anchors for future sessions)

**`config.port=0` poisons bootstrap tokens.** `SwarmManager` reads `config.port` at construction — before `fastify.listen()` has assigned the ephemeral port. If passed 0, coordinators get `http://host:0` and can't phone home. We `pickFreePort()` before calling `createHive()` (belt); openhive's `start()` calls `swarmManager.setInstanceUrl()` after listen (suspenders).

**better-sqlite3 requires the Electron-specific prebuild, not a source rebuild.** `electron-builder install-app-deps` rebuilds from source against Electron's V8 headers, but the resulting binary silently aborts at `new Database(...)` — likely a SQLite-symbol conflict with the copy Chromium bundles for cookies/IDB. `electron-app/scripts/fix-better-sqlite3.mjs` (runs via postinstall) deletes any source-built `build/` dir and pulls the Electron prebuild via `prebuild-install --runtime=electron --target=<electronVersion> --arch=<process.arch>`. If you ever see a silent `code=null` exit from hive-child with no JS stack, check this first.

**Nested `better-sqlite3` copies.** Several transitive deps (`git-cascade`, `skill-tree-indexer`, `swarmcraft`, `cognitive-core`) pin older `better-sqlite3` versions that don't compile under modern Xcode AND don't ship Electron prebuilds. `fix-better-sqlite3.mjs` walks `node_modules/` + `references/` and deletes every nested copy so everyone dedups to the top-level `@12.8.0`. Runs on every `npm install`.

**Electron 37's Node ABI is `v136`, not `v127`.** Node 22's standard ABI is v127. Electron's embedded Node uses a V8 build with a different ABI — hence the Electron-specific prebuild is a separate artifact from the Node one. `prebuild-install --runtime=electron` handles this correctly; the default doesn't.

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
│   └── preload.ts                    # Renderer preload (empty placeholder)
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
