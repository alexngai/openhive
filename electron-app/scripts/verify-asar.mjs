/**
 * verify-asar — asserts that the packaged app.asar actually contains the
 * runtime modules the app needs.
 *
 * electron-builder collects node_modules by walking the production
 * dependency tree; a version conflict, a bad publish, an over-broad `files`
 * exclude, or a bug in our own stage/prune scripts can silently drop files.
 * This script is the cheap, deterministic backstop. It does NOT need a
 * display or to launch anything. Two checks:
 *
 *   1. A hand-curated list of known-critical structural paths is present
 *      (dist/main.js, the built frontend, etc.).
 *   2. Every bare specifier the openhive entry bundles import actually
 *      resolves inside the asar. The bundle is the one checklist that
 *      can't lie — unlike a package.json, which is exactly what the
 *      stage script (mis)edits. This is the generic catch for "openhive
 *      imports X but X didn't get bundled".
 *
 * Run after electron-builder, from the electron-app directory:
 *   node scripts/verify-asar.mjs
 * Optionally pass an explicit asar path; otherwise it is discovered under
 * ../release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, builtinModules } from 'node:module';

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
let extractFile;
try {
  ({ listPackage, extractFile } = require('@electron/asar'));
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

// Import-resolution check. The REQUIRED list above is a hand-curated
// allowlist — it can't catch a dep nobody remembered to add. And checking
// against the staged package.json is no good either: the stage script is
// exactly what drops deps (that's the `@aws-sdk/client-s3` bug), so a
// checklist derived from its output inherits its blind spots.
//
// The only checklist that can't lie is the bundle itself. tsup emits a
// single-file ESM bundle; every package it couldn't inline stays as a bare
// `import … from "pkg"` / `require("pkg")` / `import("pkg")`. Scan the
// entry bundles for those specifiers and assert each one resolves inside
// the asar. This catches "openhive imports X but X didn't get bundled"
// generically — regardless of which package, or which script dropped it.
const BUNDLES = [
  'node_modules/openhive/dist/index.js',
  'node_modules/openhive/dist/cli.js',
  'node_modules/openhive/dist/map.js',
];

const builtinSet = new Set(builtinModules);

// "@scope/name/deep/path" → "@scope/name"; "name/deep" → "name".
function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// A package resolves if it ships nested under openhive OR at the asar top
// level — Node's resolver walks up from node_modules/openhive/ and finds
// either. Native modules live in app.asar.unpacked; electron-builder leaves
// a stub dir in the asar for them, so the prefix check still passes.
function packagePresent(pkg) {
  const nested = `node_modules/openhive/node_modules/${pkg}`;
  const top = `node_modules/${pkg}`;
  return entries.some(
    (p) =>
      p === nested ||
      p.startsWith(nested + '/') ||
      p === top ||
      p.startsWith(top + '/'),
  );
}

// Match `from "x"`, `import "x"`, `import("x")`, `require("x")`. The keyword
// must be at a word boundary (so `transformFrom`, `fooRequire` etc. don't
// trip it) and the specifier can't span a newline — a real bare specifier
// never does, and forbidding it stops a stray keyword inside a string
// literal from capturing half the file up to the next quote.
const SPEC_RE =
  /(?:^|[^\w.$])(?:from|import|require)\s*\(?\s*["']([^"'\n]+)["']/g;

// Bare package specifier: optional @scope/, a name, optional /subpath.
// Rejects the regex false-positives that slip past SPEC_RE (code fragments,
// sentences, URLs with spaces, etc.).
const PKG_SPEC_RE =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[^\s"']+)*$/i;

const importedPackages = new Set();
let scannedBundles = 0;

for (const bundle of BUNDLES) {
  let src;
  try {
    src = extractFile(asarPath, bundle).toString('utf8');
  } catch {
    continue; // map.js may not exist on every build; index/cli always do
  }
  scannedBundles += 1;
  let m;
  while ((m = SPEC_RE.exec(src)) !== null) {
    const spec = m[1];
    // Relative / absolute paths are bundled or local — not node_modules deps.
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (spec.startsWith('node:')) continue;
    if (!PKG_SPEC_RE.test(spec)) continue;
    const pkg = packageNameOf(spec);
    if (builtinSet.has(pkg)) continue;
    importedPackages.add(pkg);
  }
}

if (scannedBundles === 0) {
  console.error(
    '[verify-asar] FAIL: could not read any openhive entry bundle ' +
      `(${BUNDLES.join(', ')}) from the asar`,
  );
  process.exit(1);
}

const unresolved = [...importedPackages].filter((pkg) => !packagePresent(pkg));

if (unresolved.length) {
  console.error(
    '[verify-asar] FAIL: openhive bundles import these packages but they ' +
      'are not in the asar:',
  );
  for (const p of unresolved.sort()) console.error(`  ✗ ${p}`);
  console.error(
    '[verify-asar] a staging/prune script dropped them — check ' +
      'stage-openhive.mjs (RUNTIME_DEPS / OPTIONAL_RUNTIME_DEPS) and ' +
      'prune-node-modules.mjs (DELETE_PACKAGES).',
  );
  process.exit(1);
}

console.log(
  `[verify-asar] PASS: ${REQUIRED.length} required paths + ` +
    `${importedPackages.size} imported packages (from ${scannedBundles} ` +
    `bundles) all present`,
);
