#!/usr/bin/env node
/**
 * Reconcile better-sqlite3 after `npm install` so the binary works inside
 * Electron (see docs/ELECTRON_PACKAGING.md for context).
 *
 * Why this script exists
 * ----------------------
 * Two separate failure modes collide in OpenHive's dependency tree:
 *
 * 1. Several transitive deps (git-cascade, skill-tree-indexer, cognitive-core
 *    and swarmcraft — the latter two now file:-linked from references/) pin
 *    older better-sqlite3 versions that (a) don't compile under modern Xcode
 *    and (b) don't ship Electron prebuilds for current versions. Left alone,
 *    those nested copies shadow the top-level one and fail at load time.
 *
 * 2. `electron-builder install-app-deps` rebuilds better-sqlite3 from source
 *    against Electron's V8 headers. The resulting binary silently aborts the
 *    process at `new Database(...)` — most likely a SQLite-symbol conflict
 *    with Electron's own bundled SQLite (Chromium uses it for cookies/IDB).
 *    The same better-sqlite3 source tree *does* ship an Electron-specific
 *    prebuild via prebuild-install, and that prebuild works.
 *
 * What this script does
 * ---------------------
 *   (1) Delete nested `better-sqlite3` copies in node_modules + references/
 *       so the top-level one serves every consumer via Node dedup.
 *   (2) Run `electron-builder install-app-deps` to rebuild bcrypt, sharp,
 *       and @lydell/node-pty for Electron's ABI. (Those rebuild cleanly.)
 *   (3) Replace the top-level better-sqlite3 native binary with the
 *       Electron-specific prebuild from prebuild-install, discarding the
 *       broken source build electron-builder just produced.
 *
 * Best-effort: exits 0 on any recoverable failure so it's safe as a
 * postinstall hook that runs on every `npm install`. If Electron isn't
 * installed (CLI-only installs), it's a no-op.
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
// hoisted root node_modules/ for the actual rebuild targets.
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

// ── (3) Replace top-level better-sqlite3 with Electron prebuild ──────
if (!fs.existsSync(TOP_LEVEL)) {
  log('top-level better-sqlite3 missing — nothing to swap');
  process.exit(0);
}

const prebuildInstallBin = path.join(ROOT, 'node_modules/.bin/prebuild-install');
if (!fs.existsSync(prebuildInstallBin)) {
  log('prebuild-install missing — cannot fetch Electron prebuild');
  process.exit(0);
}

fs.rmSync(path.join(TOP_LEVEL, 'build'), { recursive: true, force: true });
log(`fetching better-sqlite3 Electron prebuild (target=${electronVersion}, arch=${process.arch})`);
try {
  execFileSync(
    prebuildInstallBin,
    [
      '--runtime=electron',
      `--target=${electronVersion}`,
      `--arch=${process.arch}`,
    ],
    { cwd: TOP_LEVEL, stdio: 'inherit' },
  );
  log('Electron prebuild installed');
} catch (err) {
  log(`prebuild-install failed: ${err.message}`);
  log('the Electron app will crash at startup until this is resolved');
  // Still exit 0 — we don't want to break `npm install` for CLI-only users.
  // The next `npm run electron:dev` will surface the problem.
}
