/**
 * smoke-test — launches the *packaged* app and asserts it boots.
 *
 * Runs the built binary with OPENHIVE_SMOKE_TEST=1. main.ts honours that
 * env var: it spawns the hive-child (which does `await import('openhive')`
 * and starts the Fastify server), and on success exits 0 — on any boot
 * failure (missing module, native module ABI mismatch, etc.) exits 1.
 *
 * This is the runtime counterpart to verify-asar.mjs: that one checks files
 * are *present*, this one checks the app actually *loads* them — including
 * the asar.unpacked native modules a static listing can't validate.
 *
 * Run after electron-builder, from the electron-app directory:
 *   node scripts/smoke-test.mjs
 * On Linux with no DISPLAY it self-wraps in xvfb-run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const releaseDir = path.resolve(__dirname, '..', '..', 'release');
const TIMEOUT_MS = 120_000;

function fail(msg) {
  console.error(`[smoke-test] FAIL: ${msg}`);
  process.exit(1);
}

// Locate the packaged executable for the current platform.
function findExecutable() {
  if (process.platform === 'darwin') {
    // release/<mac-dir>/OpenHive.app/Contents/MacOS/OpenHive
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
    // executableName "openhive" is set in package.json's build.linux config.
    const bin = path.join(releaseDir, 'linux-unpacked', 'openhive');
    return fs.existsSync(bin) ? bin : null;
  }
  fail(`unsupported platform: ${process.platform}`);
}

const exe = findExecutable();
if (!exe) {
  fail(`no packaged executable found under ${releaseDir} — run electron-builder first`);
}
console.log(`[smoke-test] launching: ${exe}`);

// Headless Linux runners have no X server; wrap in xvfb-run.
let cmd = exe;
let args = [];
if (process.platform === 'linux' && !process.env.DISPLAY) {
  cmd = 'xvfb-run';
  args = ['-a', '--server-args=-screen 0 1280x1024x24', exe];
}

// Run in an isolated temp dir: openhive resolves a relative `./data` dir
// from cwd, so the smoke test must not depend on where it was invoked from
// (and must not pollute the repo).
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-smoke-'));
console.log(`[smoke-test] working dir: ${workDir}`);

const child = spawn(cmd, args, {
  cwd: workDir,
  env: { ...process.env, OPENHIVE_SMOKE_TEST: '1' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const timer = setTimeout(() => {
  console.error(`[smoke-test] FAIL: app did not exit within ${TIMEOUT_MS / 1000}s`);
  child.kill('SIGKILL');
  process.exit(1);
}, TIMEOUT_MS);

child.on('error', (err) => {
  clearTimeout(timer);
  fail(`could not spawn the app — ${err.message}`);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (signal) fail(`app terminated by signal ${signal}`);
  if (code === 0) {
    console.log('[smoke-test] PASS: packaged app booted and exited cleanly');
    process.exit(0);
  }
  fail(`app exited with code ${code}`);
});
