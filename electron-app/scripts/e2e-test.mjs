/**
 * e2e-test — drives the *packaged* Electron app through Playwright's
 * `_electron` API and asserts the things a boot smoke-test structurally
 * cannot see: that the BrowserWindow actually renders the SPA, that the
 * preload bridge (`window.openhive`) reaches the renderer, and that the
 * API answers from inside the real Electron window.
 *
 * smoke-test.mjs proves the *server* boots. This proves the *app* works:
 * window opens → SPA mounts → preload bridge present → API reachable.
 *
 * Regression guard, specifically, for the sandboxed-ESM-preload bug:
 * the renderer is sandboxed, so the preload must be CommonJS. If
 * `preload.cts` ever regresses to an ESM emit, Electron throws
 * `Cannot use import statement outside a module`, `window.openhive`
 * silently never appears, and every Electron-only feature (deep links,
 * notifications, dock badge) dies with no crash. The preload-bridge
 * assertion below fails loudly when that happens.
 *
 * Run after electron-builder, from the electron-app directory:
 *   node scripts/e2e-test.mjs
 * On headless Linux it self-wraps in xvfb-run (Playwright's Electron
 * launch needs a display).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const releaseDir = path.resolve(__dirname, '..', '..', 'release');
const WINDOW_TIMEOUT_MS = 90_000;

function fail(msg) {
  console.error(`[e2e-test] FAIL: ${msg}`);
  process.exit(1);
}

// Headless Linux runners have no X server; Playwright's Electron launch
// needs a display. Re-exec the whole script under xvfb-run. Mirrors the
// same self-wrap in smoke-test.mjs.
if (process.platform === 'linux' && !process.env.DISPLAY) {
  const r = spawnSync(
    'xvfb-run',
    [
      '-a',
      '--server-args=-screen 0 1280x1024x24',
      process.execPath,
      fileURLToPath(import.meta.url),
    ],
    { stdio: 'inherit' },
  );
  process.exit(r.status ?? 1);
}

// Locate the packaged executable for the current platform (same logic as
// smoke-test.mjs — the packaged app, not a dev build).
function findExecutable() {
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
  if (process.platform === 'linux') {
    const bin = path.join(releaseDir, 'linux-unpacked', 'openhive');
    return fs.existsSync(bin) ? bin : null;
  }
  fail(`unsupported platform: ${process.platform}`);
}

const exe = findExecutable();
if (!exe) {
  fail(`no packaged executable found under ${releaseDir} — run electron-builder first`);
}
console.log(`[e2e-test] launching: ${exe}`);

// Isolation: unique --user-data-dir keeps `app.requestSingleInstanceLock()`
// from colliding with any other running OpenHive instance, and OPENHIVE_HOME
// keeps the hive's data out of the user's real ~/.openhive/.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-e2e-'));
console.log(`[e2e-test] work dir: ${workDir}`);

const args = [`--user-data-dir=${path.join(workDir, 'userdata')}`];
if (process.platform === 'linux') args.push('--no-sandbox');

let app;
let failed = false;
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`[e2e-test]   ✓ ${label}`);
  } else {
    console.error(`[e2e-test]   ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed = true;
  }
};

try {
  app = await electron.launch({
    executablePath: exe,
    args,
    env: { ...process.env, OPENHIVE_HOME: path.join(workDir, 'hive') },
    timeout: 60_000,
  });

  // The supervisor shows a splash window (a data: URL) first, then loads
  // the hive into a window pointed at http://127.0.0.1:<port>/. Wait for
  // that one specifically — firstWindow() may hand back the splash.
  const deadline = Date.now() + WINDOW_TIMEOUT_MS;
  let win = null;
  while (Date.now() < deadline && !win) {
    for (const w of app.windows()) {
      if (w.url().startsWith('http://127.0.0.1')) {
        win = w;
        break;
      }
    }
    if (!win) await new Promise((r) => setTimeout(r, 250));
  }
  if (!win) fail(`hive window never appeared within ${WINDOW_TIMEOUT_MS / 1000}s`);

  await win.waitForLoadState('domcontentloaded');

  // 1. SPA actually mounted (not a white screen / JS error).
  const title = await win.title();
  check('window title is "OpenHive"', title === 'OpenHive', `got "${title}"`);
  const rootChildren = await win.evaluate(
    () => document.getElementById('root')?.children.length ?? 0,
  );
  check('SPA mounted (#root has children)', rootChildren > 0, `${rootChildren} children`);

  // 2. Preload bridge reached the renderer. This is THE regression guard
  //    for the sandboxed-ESM-preload bug — if the preload failed to load,
  //    window.openhive is undefined and this whole block fails.
  const bridge = await win.evaluate(() => {
    const o = /** @type {any} */ (window).openhive;
    if (!o || typeof o !== 'object') return null;
    return {
      platform: o.platform,
      notify: typeof o.notify,
      setBadge: typeof o.setBadge,
      onDeepLink: typeof o.onDeepLink,
      onFocusRoute: typeof o.onFocusRoute,
      ready: typeof o.ready,
    };
  });
  check('window.openhive bridge present', bridge !== null,
    'preload failed to load — likely an ESM/CJS regression in preload.cts');
  if (bridge) {
    check('  .platform is a string', typeof bridge.platform === 'string', bridge.platform);
    for (const fn of ['notify', 'setBadge', 'onDeepLink', 'onFocusRoute', 'ready']) {
      check(`  .${fn}() is a function`, bridge[fn] === 'function', bridge[fn]);
    }
  }

  // 3. The API answers from inside the real renderer (same-origin fetch).
  const api = await win.evaluate(async () => {
    try {
      const r = await fetch('/api/v1/auth/mode');
      return { ok: r.ok, status: r.status };
    } catch (e) {
      return { ok: false, status: 0, error: String(e) };
    }
  });
  check('API reachable from renderer (/api/v1/auth/mode)', api.ok,
    `status ${api.status}${api.error ? ` ${api.error}` : ''}`);
} catch (err) {
  fail(`unexpected error — ${err.message}`);
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(workDir, { recursive: true, force: true });
}

if (failed) {
  console.error('[e2e-test] FAIL: one or more checks failed (see ✗ above)');
  process.exit(1);
}
console.log('[e2e-test] PASS: window rendered, preload bridge live, API reachable');
