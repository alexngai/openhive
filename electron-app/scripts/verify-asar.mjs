/**
 * verify-asar — asserts that the packaged app.asar actually contains the
 * runtime modules the app needs.
 *
 * electron-builder collects node_modules by walking the production
 * dependency tree; a version conflict, a bad publish, or an over-broad
 * `files` exclude can silently drop files. This script is the cheap,
 * deterministic backstop: list the built asar and fail if any known-critical
 * path is missing. It does NOT need a display or to launch anything.
 *
 * Run after electron-builder, from the electron-app directory:
 *   node scripts/verify-asar.mjs
 * Optionally pass an explicit asar path; otherwise it is discovered under
 * ../release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const releaseDir = path.resolve(__dirname, '..', '..', 'release');

// Paths that must be present inside the asar. Each is a prefix — the asar
// listing is checked for any entry that starts with it. Native modules
// (better-sqlite3, bcrypt, sharp, node-pty) live in app.asar.unpacked, not
// the asar, and are exercised by the launch smoke test instead.
const REQUIRED = [
  'dist/main.js',                                  // supervisor entry
  'dist/hive-child.js',                            // forked hive process
  'node_modules/openhive/dist/index.js',           // staged openhive server
  'node_modules/openhive/dist/cli.js',
  'node_modules/openhive/dist/web/index.html',     // built frontend assets
  'node_modules/opentasks/dist/index.js',
  'node_modules/opentasks/dist/sessionlog/index.js', // regressed once — keep
  'node_modules/sessionlog/dist/index.js',
  'node_modules/swarmcraft/dist/server',
  'node_modules/macro-agent/dist',
  'node_modules/fastify/lib',
  'node_modules/electron-updater',
];

function findAsar(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
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
      if (e.isFile() && e.name === 'app.asar') return full;
      if (e.isDirectory()) stack.push(full);
    }
  }
  return null;
}

const asarPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : findAsar(releaseDir);

if (!asarPath || !fs.existsSync(asarPath)) {
  console.error(
    `[verify-asar] FAIL: no app.asar found (looked under ${releaseDir}). ` +
      'Run electron-builder first.',
  );
  process.exit(1);
}

let listPackage;
try {
  ({ listPackage } = require('@electron/asar'));
} catch {
  console.error(
    '[verify-asar] FAIL: @electron/asar not resolvable — it ships with ' +
      'electron-builder; run from the electron-app workspace after install.',
  );
  process.exit(1);
}

// listPackage returns absolute-style paths like "/node_modules/opentasks/...".
// Strip the leading separator and normalize to forward slashes.
const entries = listPackage(asarPath).map((p) =>
  p.replace(/^[/\\]/, '').split('\\').join('/'),
);

const missing = REQUIRED.filter((req) => {
  // present = an exact entry, or any entry nested under it (directory prefix)
  const present = entries.some((p) => p === req || p.startsWith(req + '/'));
  return !present;
});

console.log(`[verify-asar] ${asarPath}`);
console.log(`[verify-asar] ${entries.length} entries in asar`);

if (missing.length) {
  console.error('[verify-asar] FAIL: missing required paths in asar:');
  for (const m of missing) console.error(`  ✗ ${m}`);
  process.exit(1);
}

console.log(`[verify-asar] PASS: all ${REQUIRED.length} required paths present`);
