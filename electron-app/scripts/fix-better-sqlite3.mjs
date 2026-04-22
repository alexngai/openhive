#!/usr/bin/env node
/**
 * Reconcile better-sqlite3 after `npm install` so the same install serves
 * both the Electron app and the plain-Node server dev loop without
 * re-toggling. See docs/ELECTRON_PACKAGING.md for packaging context.
 *
 * Why this script exists
 * ----------------------
 * Three failure modes collide in OpenHive's dependency tree:
 *
 * 1. Several transitive deps (git-cascade, skill-tree-indexer, etc.) pin
 *    older better-sqlite3 versions that (a) don't compile under modern Xcode
 *    and (b) don't ship Electron prebuilds for current versions. If any of
 *    these end up with a nested copy in node_modules/ or (historically) a
 *    file:-linked package under references/, that copy shadows the top-level
 *    one and fails at load time. All first-party refs currently resolve from
 *    the npm registry, but the walk is kept defensively for future workspace
 *    links.
 *
 * 2. `electron-builder install-app-deps` rebuilds better-sqlite3 from source
 *    against Electron's V8 headers. The resulting binary silently aborts the
 *    process at `new Database(...)` — most likely a SQLite-symbol conflict
 *    with Electron's own bundled SQLite (Chromium uses it for cookies/IDB).
 *    The same better-sqlite3 source tree *does* ship an Electron-specific
 *    prebuild via prebuild-install, and that prebuild works.
 *
 * 3. Electron's embedded Node ABI (v136 for Electron 37) differs from plain
 *    Node 22's ABI (v127). A single binary at `build/Release/` can only
 *    satisfy one runtime at a time, so `npm run dev` (plain Node) and
 *    `electron-app/npm run dev` used to require manual re-toggling.
 *
 * What this script does
 * ---------------------
 *   (1) Delete nested `better-sqlite3` copies in node_modules + references/
 *       so the top-level one serves every consumer via Node dedup.
 *   (2) Run `electron-builder install-app-deps` to rebuild bcrypt, sharp,
 *       and @lydell/node-pty for Electron's ABI. (Those rebuild cleanly.)
 *   (3) Fetch the better-sqlite3 Electron prebuild → `build/Release-electron/`.
 *   (4) Fetch the better-sqlite3 Node prebuild     → `build/Release-node/`.
 *   (5) Patch `lib/database.js` to pick between them at load time based on
 *       `process.versions.electron`. Idempotent via a marker comment so
 *       repeated postinstalls don't stack patches.
 *
 * Best-effort: exits 0 on any recoverable failure so it's safe as a
 * postinstall hook that runs on every `npm install`. If Electron isn't
 * installed (CLI-only installs), the default install already produced a
 * Node-ABI binary at `build/Release/`, so we no-op.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// This script sits at electron-app/scripts/. The workspace root (openhive/)
// is two levels up — npm workspaces hoist shared deps (including
// better-sqlite3, electron, electron-builder) into its node_modules/.
const ELECTRON_APP = path.resolve(SCRIPT_DIR, '..');
const ROOT = path.resolve(ELECTRON_APP, '..');
const TOP_LEVEL = path.join(ROOT, 'node_modules/better-sqlite3');
const BUILD_DIR = path.join(TOP_LEVEL, 'build');
const RELEASE_DIR = path.join(BUILD_DIR, 'Release');
const RELEASE_NODE = path.join(BUILD_DIR, 'Release-node');
const RELEASE_ELECTRON = path.join(BUILD_DIR, 'Release-electron');
const DATABASE_JS = path.join(TOP_LEVEL, 'lib/database.js');
const PATCH_MARKER = '// openhive-dual-runtime-patch';
const log = (msg) => console.log('[fix-better-sqlite3]', msg);

// Short-circuit: no Electron means this is a CLI-only install path.
const electronPkgJson = path.join(ROOT, 'node_modules/electron/package.json');
if (!fs.existsSync(electronPkgJson)) {
  log('electron not installed — skipping (CLI-only install)');
  process.exit(0);
}
const electronVersion = JSON.parse(fs.readFileSync(electronPkgJson, 'utf8')).version;

// ── (1) Delete nested better-sqlite3 copies ──────────────────────────
function findNestedBetterSqlite3() {
  const hits = [];
  const roots = [
    path.join(ROOT, 'node_modules'),
    path.join(ROOT, 'references'),
  ];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'better-sqlite3' && path.basename(dir) === 'node_modules') {
        if (path.resolve(full) !== path.resolve(TOP_LEVEL)) {
          hits.push(full);
        }
      } else {
        walk(full);
      }
    }
  };
  for (const r of roots) {
    if (fs.existsSync(r)) walk(r);
  }
  return hits;
}

const nested = findNestedBetterSqlite3();
for (const p of nested) {
  log(`removing nested copy: ${path.relative(ROOT, p)}`);
  fs.rmSync(p, { recursive: true, force: true });
}
if (nested.length === 0) log('no nested better-sqlite3 copies found');

// ── (2) Rebuild other natives for Electron's ABI ─────────────────────
//
// Run electron-builder with cwd=electron-app/ so it finds this package's
// `build` config (appId, asarUnpack, etc.). It still reaches into the
// hoisted root node_modules/ for the actual rebuild targets. Its
// better-sqlite3 output is the broken source build — we discard it in
// step (3) by wiping build/Release before fetching the prebuild.
const electronBuilderBin = path.join(ROOT, 'node_modules/.bin/electron-builder');
if (fs.existsSync(electronBuilderBin)) {
  log(`running electron-builder install-app-deps (electron=${electronVersion})`);
  const r = spawnSync(electronBuilderBin, ['install-app-deps'], {
    cwd: ELECTRON_APP,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    log('electron-builder install-app-deps exited non-zero; continuing');
  }
} else {
  log('electron-builder not installed — skipping native rebuild');
}

// ── (3) & (4) Collect both prebuilds ─────────────────────────────────
if (!fs.existsSync(TOP_LEVEL)) {
  log('top-level better-sqlite3 missing — nothing to set up');
  process.exit(0);
}

const prebuildInstallBin = path.join(ROOT, 'node_modules/.bin/prebuild-install');
if (!fs.existsSync(prebuildInstallBin)) {
  log('prebuild-install missing — cannot fetch prebuilds');
  process.exit(0);
}

function fetchPrebuild(args, label) {
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
  log(`fetching better-sqlite3 ${label} prebuild (arch=${process.arch})`);
  try {
    execFileSync(prebuildInstallBin, args, { cwd: TOP_LEVEL, stdio: 'inherit' });
  } catch (err) {
    log(`prebuild-install (${label}) failed: ${err.message}`);
    return false;
  }
  return fs.existsSync(RELEASE_DIR);
}

function moveReleaseTo(destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(RELEASE_DIR, destination);
}

const electronOk = fetchPrebuild(
  [
    '--runtime=electron',
    `--target=${electronVersion}`,
    `--arch=${process.arch}`,
  ],
  `Electron ${electronVersion}`,
);
if (electronOk) {
  moveReleaseTo(RELEASE_ELECTRON);
  log(`Electron prebuild staged at build/Release-electron/`);
} else {
  log('WARNING: Electron prebuild missing — electron-app startup will fail');
}

const nodeOk = fetchPrebuild(
  [
    '--runtime=node',
    `--target=${process.versions.node}`,
    `--arch=${process.arch}`,
  ],
  `Node ${process.versions.node}`,
);
if (nodeOk) {
  moveReleaseTo(RELEASE_NODE);
  log(`Node prebuild staged at build/Release-node/`);
} else {
  log('WARNING: Node prebuild missing — `npm run dev` will fail');
}

// ── (5) Patch lib/database.js for runtime selection ──────────────────
//
// better-sqlite3's `database.js` loads the addon via
// `require('bindings')('better_sqlite3.node')`, which resolves against
// `build/Release/`. Replace that single line with a runtime selector that
// picks `build/Release-electron/` under Electron and `build/Release-node/`
// under plain Node. Idempotent — guarded by PATCH_MARKER.
if (!fs.existsSync(DATABASE_JS)) {
  log('lib/database.js missing — cannot patch');
  process.exit(0);
}

let source = fs.readFileSync(DATABASE_JS, 'utf8');
if (source.includes(PATCH_MARKER)) {
  log('lib/database.js already patched');
} else {
  const original = `require('bindings')('better_sqlite3.node')`;
  const replacement = `(() => {
\t\t\t${PATCH_MARKER}
\t\t\t// Dual-runtime selector: Electron (ABI v136) vs plain Node (ABI v127).
\t\t\t// Staged by electron-app/scripts/fix-better-sqlite3.mjs on npm install.
\t\t\tconst variant = process.versions.electron ? 'electron' : 'node';
\t\t\tconst p = require('path').join(__dirname, '..', 'build', 'Release-' + variant, 'better_sqlite3.node');
\t\t\treturn require(p);
\t\t})()`;
  if (!source.includes(original)) {
    log('lib/database.js does not contain the expected bindings() call — skipping patch');
  } else {
    source = source.replace(original, replacement);
    fs.writeFileSync(DATABASE_JS, source);
    log('lib/database.js patched for dual-runtime loading');
  }
}
