/**
 * check-update-flow — MANUAL one-off verification. NOT wired into
 * `npm run verify` or CI; run it by hand when you want to confirm the
 * macOS auto-update detect+download path actually works end to end.
 *
 *   node scripts/check-update-flow.mjs
 *
 * What it does: serves a local generic-provider update feed whose
 * `latest-mac.yml` announces version 99.0.0 (far newer than the installed
 * app), injects a matching `app-update.yml` into the packaged app's
 * Resources, launches the app, and watches the local HTTP server.
 * main.ts's own `checkForUpdatesAndNotify()` — which runs on startup for a
 * packaged app — drives electron-updater against the feed.
 *
 * Observable signals (server-side, so no electron-updater introspection
 * needed — which `app.evaluate` can't do anyway):
 *   GET /latest-mac.yml   → electron-updater fetched the feed
 *   GET /<the .zip>       → it parsed the feed, compared versions, found
 *                           99.0.0 newer, and STARTED the download.
 * Both ⟹ detection + download confirmed.
 *
 * NOT covered: the Squirrel.Mac install + app relaunch — that step is code-
 * signature-gated and needs a real signed build (the release pipeline's
 * job). This verifies everything up to and including the download starting.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const releaseDir = path.resolve(__dirname, '..', '..', 'release');
const OVERALL_TIMEOUT_MS = 180_000;

function fail(msg) {
  console.error(`[check-update-flow] FAIL: ${msg}`);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  console.log('[check-update-flow] SKIP: macOS-only check');
  process.exit(0);
}

// Locate the packaged .app (bundle dir + executable + Resources dir).
let appBundle = null;
const stack = [releaseDir];
while (stack.length && !appBundle) {
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
      appBundle = full;
      break;
    }
    if (e.isDirectory()) stack.push(full);
  }
}
if (!appBundle) fail(`no .app bundle under ${releaseDir} — run electron-builder first`);

const macOSDir = path.join(appBundle, 'Contents', 'MacOS');
const exe = path.join(macOSDir, fs.readdirSync(macOSDir)[0]);
const resourcesDir = path.join(appBundle, 'Contents', 'Resources');
const appUpdateYml = path.join(resourcesDir, 'app-update.yml');
console.log(`[check-update-flow] app: ${appBundle}`);

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const port = await freePort();
const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-feed-'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-updchk-'));
const zipName = 'OpenHive-mac-arm64.zip';

// A real (tiny) zip standing in for the update artifact. electron-updater
// downloads it and checks its sha512 against the feed; the bytes only need
// to be a file with a matching hash for the *download* to be observed.
spawnSync('sh', ['-c',
  `cd "${feedDir}" && printf 'update-flow-check' > payload.txt && zip -q "${zipName}" payload.txt && rm payload.txt`]);
const zipPath = path.join(feedDir, zipName);
if (!fs.existsSync(zipPath)) fail('could not create test zip');
const zipBytes = fs.readFileSync(zipPath);
const sha512 = crypto.createHash('sha512').update(zipBytes).digest('base64');

// Feed announcing a version far newer than anything installed.
fs.writeFileSync(path.join(feedDir, 'latest-mac.yml'),
  `version: 99.0.0\n` +
  `files:\n` +
  `  - url: ${zipName}\n` +
  `    sha512: ${sha512}\n` +
  `    size: ${zipBytes.length}\n` +
  `path: ${zipName}\n` +
  `sha512: ${sha512}\n` +
  `releaseDate: '${new Date().toISOString()}'\n`);

// Generic-provider config the app reads from its Resources. A pack/--dir
// build has no app-update.yml, so there's nothing to back up — but guard
// anyway and always restore in the finally block.
const hadExistingYml = fs.existsSync(appUpdateYml);
const backup = hadExistingYml ? fs.readFileSync(appUpdateYml) : null;
fs.writeFileSync(appUpdateYml,
  `provider: generic\n` +
  `url: http://127.0.0.1:${port}\n` +
  `updaterCacheDirName: openhive-update-flow-check\n`);

const seen = new Set();
const server = http.createServer((req, res) => {
  const name = path.basename(req.url.split('?')[0]);
  seen.add(name);
  console.log(`[check-update-flow]   server ← GET ${req.url}`);
  const file = path.join(feedDir, name);
  if (fs.existsSync(file)) {
    res.writeHead(200);
    fs.createReadStream(file).pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));
console.log(`[check-update-flow] feed server on http://127.0.0.1:${port}`);

let child;
function cleanup() {
  try { child?.kill('SIGKILL'); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  // Restore the app bundle to its original state.
  try {
    if (hadExistingYml) fs.writeFileSync(appUpdateYml, backup);
    else fs.rmSync(appUpdateYml, { force: true });
  } catch { /* ignore */ }
  fs.rmSync(feedDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

try {
  console.log('[check-update-flow] launching app (boots a hive, then auto-checks)…');
  child = spawn(exe, [`--user-data-dir=${path.join(workDir, 'ud')}`], {
    env: { ...process.env, OPENHIVE_HOME: path.join(workDir, 'hive') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [app] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`  [app] ${d}`));

  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (seen.has('latest-mac.yml') && seen.has(zipName)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const gotFeed = seen.has('latest-mac.yml');
  const gotZip = seen.has(zipName);
  console.log('');
  console.log(`[check-update-flow] ${gotFeed ? '✓' : '✗'} feed fetched (GET latest-mac.yml) — electron-updater reached the feed`);
  console.log(`[check-update-flow] ${gotZip ? '✓' : '✗'} update artifact requested (GET ${zipName}) — newer version detected, download started`);

  if (gotFeed && gotZip) {
    console.log('[check-update-flow] PASS: detect + download path works (Squirrel install step needs a signed build — not covered here)');
  } else {
    cleanup();
    fail('feed and/or artifact were never requested — the detect/download path did not run');
  }
} finally {
  cleanup();
}
process.exit(0);
