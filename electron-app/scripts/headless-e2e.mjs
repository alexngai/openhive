/**
 * headless-e2e — drives the headless / tray-only flows that the other
 * verify scripts don't reach. smoke-test.mjs proves the server boots;
 * e2e-test.mjs proves the *headed* app renders. This proves the headless
 * surface:
 *
 *   1. headless boot          — server runs, zero BrowserWindows
 *   2. multi-hive restore     — settings.lastRunningHives all boot
 *   3. 2b skip-but-keep       — a missing hive is skipped, NOT pruned
 *   4. 2e remove              — tray "Remove from Auto-Start" prunes it
 *   5. 2e retry               — tray "Try Again" boots a reappeared folder
 *   6. deep-link routing      — openhive://h/<id>/route hits the right hive
 *
 * A native tray menu can't be clicked from Playwright, so the supervisor
 * exposes an OPENHIVE_E2E-gated `globalThis.__openhiveTest` (see main.ts):
 * state readers + the 2e action handlers, reached via app.evaluate().
 *
 * Runs against the packaged app when release/ has one (the `verify` chain
 * after electron-builder); otherwise falls back to the dev build
 * (dist/main.js) for a fast local loop:
 *
 *   node scripts/headless-e2e.mjs
 *
 * Self-wraps in xvfb-run on headless Linux (Electron needs a display even
 * when the app opens no window).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
// Note: the `electron` npm package is imported lazily (dev mode only) —
// see the mode-detection block. A static import would crash the script in
// packaged mode if `prune-node-modules.mjs` (run before `verify`) touched
// that package.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const releaseDir = path.resolve(appRoot, '..', 'release');
const isLinux = process.platform === 'linux';

// Headless Linux runners have no X server; Playwright's Electron launch
// needs a display. Re-exec the whole script under xvfb-run — mirrors the
// same self-wrap in e2e-test.mjs / smoke-test.mjs.
if (isLinux && !process.env.DISPLAY) {
  const r = spawnSync(
    'xvfb-run',
    ['-a', '--server-args=-screen 0 1280x1024x24',
      process.execPath, fileURLToPath(import.meta.url)],
    { stdio: 'inherit' },
  );
  process.exit(r.status ?? 1);
}

// ── result tracking ───────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}
function section(name) {
  console.log(`\n[headless-e2e] ${name}`);
}

// ── locate the app: packaged build (preferred) or dev build ───────────
function findPackaged() {
  if (process.platform === 'darwin') {
    const stack = [releaseDir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory() && e.name.endsWith('.app')) {
          const macOSDir = path.join(full, 'Contents', 'MacOS');
          const bin = fs.existsSync(macOSDir) && fs.readdirSync(macOSDir)[0];
          if (bin) return path.join(macOSDir, bin);
        }
        if (e.isDirectory()) stack.push(full);
      }
    }
    return null;
  }
  if (isLinux) {
    const bin = path.join(releaseDir, 'linux-unpacked', 'openhive');
    return fs.existsSync(bin) ? bin : null;
  }
  return null;
}

const packaged = findPackaged();
const mainJs = path.join(appRoot, 'dist', 'main.js');
const hasDev = fs.existsSync(mainJs);
const forceDev = process.argv.includes('--dev');
const mtime = (p) => fs.statSync(p).mtimeMs;

// Pick the build to exercise. Prefer whichever is *newer*, not just
// "packaged if present": in CI, `pack`/`dist` build dist/ then package, so
// the packaged binary is newer → packaged. After a local edit + `tsc`,
// dist/main.js is newer → dev, and a stale release/ from an old build is
// correctly ignored. `--dev` forces the dev build explicitly.
let exePath;
let baseArgs;
let mode;
if (forceDev || (hasDev && (!packaged || mtime(mainJs) > mtime(packaged)))) {
  if (!hasDev) {
    console.error('[headless-e2e] FAIL: dev build requested but dist/main.js '
      + 'is missing — run `npm run build`');
    process.exit(1);
  }
  mode = 'dev';
  // The `electron` npm package's default export is the path to its binary.
  exePath = (await import('electron')).default;
  baseArgs = [mainJs];
  if (packaged && !forceDev) {
    console.log('[headless-e2e] note: release/ build is older than '
      + 'dist/main.js — using the dev build (run `npm run pack` to test '
      + 'the packaged app)');
  }
} else if (packaged) {
  mode = 'packaged';
  exePath = packaged;
  baseArgs = [];
} else {
  console.error('[headless-e2e] FAIL: no packaged app under release/ and no '
    + 'dist/main.js — run `npm run build` (dev) or `npm run pack` (packaged)');
  process.exit(1);
}
console.log(`[headless-e2e] mode=${mode}  exe=${exePath}`);

// ── per-test isolated workspace ───────────────────────────────────────
function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-he2e-'));
  const ud = path.join(dir, 'userdata');
  fs.mkdirSync(ud, { recursive: true });
  return {
    dir,
    ud,
    /** Pre-create a hive folder + its `.openhive-root` marker. */
    seedHive(name) {
      const d = path.join(dir, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, '.openhive-root'), '');
      return d;
    },
    /** A path that looks like a hive but is never created (missing folder). */
    missingHive(name) {
      return path.join(dir, name);
    },
    seedSettings(obj) {
      fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify(obj, null, 2));
    },
    readSettings() {
      return JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf-8'));
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function launch(ws, extraArgs = [], extraEnv = {}) {
  const args = [...baseArgs, ...extraArgs, `--user-data-dir=${ws.ud}`];
  if (isLinux) args.push('--no-sandbox');
  return electron.launch({
    executablePath: exePath,
    args,
    env: {
      ...process.env,
      OPENHIVE_E2E: '1',
      // Isolate the default hive away from the real ~/.openhive.
      OPENHIVE_HOME: path.join(ws.dir, 'home'),
      ...extraEnv,
    },
    timeout: 60_000,
  });
}

/** Poll the supervisor's __openhiveTest hook until `predicate(state)` holds. */
async function waitFor(app, predicate, { timeout = 90_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    let state = null;
    try {
      state = await app.evaluate(() => {
        const t = globalThis.__openhiveTest;
        return t
          ? { headless: t.headless(), hives: t.hives(), unavailable: t.unavailable() }
          : null;
      });
    } catch {
      /* main process not ready for evaluate yet — keep polling */
    }
    if (state) {
      last = state;
      if (predicate(state)) return state;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label}`
    + (last ? ` (last: ${JSON.stringify(last)})` : ''));
}

async function httpStatus(url) {
  try {
    const r = await fetch(`${url}/.well-known/openhive.json`);
    return r.status;
  } catch {
    return 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── tests ─────────────────────────────────────────────────────────────

async function testHeadlessBoot() {
  section('Test 1 — headless boot: server runs, no window');
  const ws = makeWorkspace();
  const app = await launch(ws, ['--tray']);
  try {
    const state = await waitFor(app, (s) => s.headless && s.hives.length >= 1,
      { label: 'headless hive boot' });
    check('launched headless (headless=true)', state.headless === true);
    check('exactly one hive booted', state.hives.length === 1, `got ${state.hives.length}`);
    check('NO BrowserWindow open', app.windows().length === 0,
      `${app.windows().length} window(s)`);
    check('hive flagged keepAlive', state.hives[0].keepAlive === true);
    const status = await httpStatus(state.hives[0].url);
    check('hive server responding', status === 200, `HTTP ${status}`);
  } finally {
    await app.close().catch(() => {});
    ws.cleanup();
  }
}

async function testMultiHiveRestore() {
  section('Test 2 — multi-hive restore from settings.lastRunningHives');
  const ws = makeWorkspace();
  const a = ws.seedHive('hivea');
  const b = ws.seedHive('hiveb');
  ws.seedSettings({ headless: true, startAtLogin: false, lastRunningHives: [a, b], hiveIds: {} });
  const app = await launch(ws, ['--tray']);
  try {
    const state = await waitFor(app, (s) => s.hives.length >= 2,
      { timeout: 120_000, label: 'both hives restored' });
    check('both hives restored', state.hives.length === 2, `got ${state.hives.length}`);
    check('both are keepAlive', state.hives.every((h) => h.keepAlive));
    check('no windows', app.windows().length === 0, `${app.windows().length} window(s)`);
    const codes = await Promise.all(state.hives.map((h) => httpStatus(h.url)));
    check('both hive servers responding', codes.every((c) => c === 200), `HTTP ${codes}`);
  } finally {
    await app.close().catch(() => {});
    ws.cleanup();
  }
}

async function testSkipButKeep() {
  section('Test 3 — 2b: missing hive skipped but kept in lastRunningHives');
  const ws = makeWorkspace();
  const real = ws.seedHive('realhive');
  const gone = ws.missingHive('gone-hive');   // never created
  ws.seedSettings({ headless: true, startAtLogin: false, lastRunningHives: [real, gone], hiveIds: {} });
  const app = await launch(ws, ['--tray']);
  try {
    const state = await waitFor(app, (s) => s.hives.length >= 1,
      { label: 'real hive boot' });
    check('only the real hive booted', state.hives.length === 1
      && state.hives[0].dataDir === real, JSON.stringify(state.hives.map((h) => h.dataDir)));
    check('missing hive listed as unavailable', state.unavailable.includes(gone));
    check('missing folder NOT recreated', !fs.existsSync(gone));
    await sleep(1500);   // let onHivesChanged flush settings.json
    const lrh = ws.readSettings().lastRunningHives;
    check('2b: missing hive KEPT in lastRunningHives (not pruned)',
      lrh.includes(gone), JSON.stringify(lrh));
  } finally {
    await app.close().catch(() => {});
    ws.cleanup();
  }
}

async function testUnavailableRemove() {
  section('Test 4 — 2e: Remove from Auto-Start prunes an unavailable hive');
  const ws = makeWorkspace();
  const real = ws.seedHive('realhive');
  const gone = ws.missingHive('gone-hive');
  ws.seedSettings({ headless: true, startAtLogin: false, lastRunningHives: [real, gone], hiveIds: {} });
  const app = await launch(ws, ['--tray']);
  try {
    await waitFor(app, (s) => s.unavailable.includes(gone), { label: 'unavailable hive' });
    // electronApplication.evaluate calls fn(electronModule, arg) — the
    // Electron module is the FIRST param, our arg is the second.
    await app.evaluate(
      (_electron, { d }) => globalThis.__openhiveTest.removeUnavailableHive(d),
      { d: gone },
    );
    const state = await waitFor(app, (s) => !s.unavailable.includes(gone),
      { timeout: 10_000, label: 'removal' });
    check('cleared from the unavailable list', !state.unavailable.includes(gone));
    check('real hive untouched', state.hives.some((h) => h.dataDir === real));
    await sleep(1000);
    const lrh = ws.readSettings().lastRunningHives;
    check('2e: pruned from lastRunningHives', !lrh.includes(gone), JSON.stringify(lrh));
  } finally {
    await app.close().catch(() => {});
    ws.cleanup();
  }
}

async function testUnavailableRetry() {
  section('Test 5 — 2e: Try Again boots a hive whose folder reappeared');
  const ws = makeWorkspace();
  const real = ws.seedHive('realhive');
  const gone = ws.missingHive('gone-hive');
  ws.seedSettings({ headless: true, startAtLogin: false, lastRunningHives: [real, gone], hiveIds: {} });
  const app = await launch(ws, ['--tray']);
  try {
    await waitFor(app, (s) => s.unavailable.includes(gone), { label: 'unavailable hive' });
    // Simulate the drive remounting — folder + marker reappear.
    fs.mkdirSync(gone, { recursive: true });
    fs.writeFileSync(path.join(gone, '.openhive-root'), '');
    await app.evaluate(
      (_electron, { d }) => globalThis.__openhiveTest.retryUnavailableHive(d),
      { d: gone },
    );
    const state = await waitFor(app,
      (s) => s.hives.some((h) => h.dataDir === gone) && !s.unavailable.includes(gone),
      { label: 'retry boot' });
    check('retried hive is now running', state.hives.some((h) => h.dataDir === gone));
    check('cleared from the unavailable list', !state.unavailable.includes(gone));
  } finally {
    await app.close().catch(() => {});
    ws.cleanup();
  }
}

async function testDeepLinkRouting() {
  section('Test 6 — deep link openhive://h/<id>/route hits the right hive');
  const ws = makeWorkspace();
  const a = ws.seedHive('hivea');
  const b = ws.seedHive('hiveb');
  ws.seedSettings({ headless: true, startAtLogin: false, lastRunningHives: [a, b], hiveIds: {} });
  const app = await launch(ws, ['--tray']);
  try {
    const state = await waitFor(app, (s) => s.hives.length >= 2,
      { timeout: 120_000, label: 'both hives' });
    check('no windows before the deep link', app.windows().length === 0);
    const hiveB = state.hives.find((h) => h.dataDir === b);
    if (!hiveB) throw new Error('hive B not in state');
    const portB = new URL(hiveB.url).port;

    // A second instance carrying the deep link: the single-instance lock
    // bounces it into the running app's `second-instance` handler →
    // processDeepLink. Same --user-data-dir so it shares the lock.
    const link = `openhive://h/${hiveB.id}/settings`;
    console.log(`  → sending ${link}`);
    const child = spawn(
      exePath,
      [...baseArgs, link, `--user-data-dir=${ws.ud}`, ...(isLinux ? ['--no-sandbox'] : [])],
      { stdio: 'ignore', detached: true },
    );
    child.unref();

    // Wait for the routed window to appear on hive B's port.
    const deadline = Date.now() + 40_000;
    let win = null;
    while (Date.now() < deadline && !win) {
      for (const w of app.windows()) {
        if (w.url().includes(`:${portB}/`)) { win = w; break; }
      }
      if (!win) await sleep(300);
    }
    check('a window opened for the targeted hive (B)', !!win);
    if (win) {
      await sleep(2000);   // let react-router apply the forwarded route
      const url = win.url();
      check('routed to hive B and navigated to /settings',
        url.includes(`:${portB}/settings`), url);
      check('exactly one window — hive A left untouched',
        app.windows().length === 1, `${app.windows().length} window(s)`);
    }
  } finally {
    await app.close().catch(() => {});
    ws.cleanup();
  }
}

// ── runner ────────────────────────────────────────────────────────────
const tests = [
  testHeadlessBoot,
  testMultiHiveRestore,
  testSkipButKeep,
  testUnavailableRemove,
  testUnavailableRetry,
  testDeepLinkRouting,
];

for (const t of tests) {
  try {
    await t();
  } catch (err) {
    console.error(`  ✗ ${t.name} threw — ${err.message}`);
    failed++;
  }
}

console.log(`\n[headless-e2e] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[headless-e2e] FAIL');
  process.exit(1);
}
console.log('[headless-e2e] PASS');
