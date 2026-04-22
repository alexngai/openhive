/**
 * Deletes packages from node_modules that are never loaded at runtime by
 * the packaged Electron app. Run between `stage-openhive.mjs` and
 * `electron-builder`.
 *
 * Why on disk, not via `files` filter: electron-builder resolves
 * `dependencies` from each package.json and copies the resolved directories
 * into the asar regardless of the `files` filter. The filter only affects
 * *extra* files added on top. So the reliable way to keep a package out of
 * the asar is to remove it from node_modules before packaging.
 *
 * Categories:
 *   - Frontend-only — Vite already bundles these into dist/web/assets/*.js,
 *     they're never imported by the Node-side server bundle.
 *   - TUI-only — openswarm declares @opentui/core etc. but the actual
 *     rendering runs inside the platform-specific `@openswarm/cli-*` Bun
 *     binary. The Node `openswarm/dist/server.mjs` is a bundled server
 *     that imports none of these.
 *   - Optional telemetry — @opentelemetry is a no-op unless the user opts
 *     in via OTEL_EXPORTER_OTLP_ENDPOINT.
 *   - Build tooling — tsup, vite, rollup, esbuild, tsc, tailwindcss, etc.
 *   - Electron-builder tooling — shouldn't be in a packaged app at all.
 *
 * After electron-builder finishes, `npm install` (at the repo root)
 * restores everything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Packages to delete wherever they appear (top-level or nested under any
// `*/node_modules/`). Names with slashes are matched literally as scoped
// package paths.
const DELETE_PACKAGES = [
  // ---- Frontend-only ----
  //
  // Vite bundles these into dist/web/assets/*.js. They're never imported
  // by Node-side code. `graphology` and `graphology-communities-louvain`
  // are EXCEPTIONS — swarmcraft's server bundle imports them for
  // server-side graph work — so they are NOT in this list.
  'mermaid',
  'lucide-react',
  'react',
  'react-dom',
  'react-router',
  'react-router-dom',
  'react-markdown',
  'react-syntax-highlighter',
  'react18-json-view',
  '@tiptap',
  'lowlight',
  'highlight.js',
  '@tanstack',
  'rehype-highlight',
  'remark-gfm',
  'boring-avatars',
  '@dnd-kit',
  'zustand',
  'clsx',
  'graphology-layout',
  'graphology-layout-forceatlas2',
  'graphology-layout-noverlap',
  // NOTE: graphology, graphology-communities-louvain, graphology-utils,
  // graphology-indices, graphology-shortest-path, graphology-traversal
  // are ALL imported by swarmcraft's server bundle or transitively —
  // DO NOT prune. The layout packages above are frontend-only.
  'graphology-metrics',
  'graphology-operators',
  'sigma',
  '@sigma',
  'dagre',
  'dagre-d3-es',
  '@dagrejs',
  'cytoscape',
  'cytoscape-cose-bilkent',
  'cytoscape-fcose',
  'date-fns',
  'three',
  'ghostty-web',
  '@jimp',
  'jimp',
  'planck',
  'katex',
  'prismjs',
  'isomorphic-git',
  '@isomorphic-git',

  // ---- mermaid orphans (mermaid is pruned, its transitive deps are now
  // unreachable but still on disk until we remove them) ----
  'langium',
  'lodash-es',
  '@mermaid-js',
  '@braintree',

  // ---- @libsql / drizzle-orm libsql adapter (nothing at runtime uses
  // libsql; skill-tree-indexer uses drizzle-orm/better-sqlite3) ----
  // NOTE: `web-streams-polyfill` is NOT pruned — it's also a dep of
  // @anthropic-ai/sdk (via formdata-node), which IS runtime.
  '@libsql',
  'libsql',

  // ---- @grpc stack (pulled in transitively via @opentelemetry/sdk-node,
  // which we already prune) ----
  '@grpc',
  'protobufjs',

  // ---- TUI-only (openswarm rendering is bundled in platform CLI binary) ----
  '@opentui',
  '@solid-primitives',
  'solid-js',
  'babel-preset-solid',
  'babel-plugin-jsx-dom-expressions',
  'bun-webgpu',
  'bun-webgpu-darwin-arm64',
  'bun-webgpu-darwin-x64',
  'bun-webgpu-linux-x64',
  'bun-webgpu-linux-arm64',
  'opentui-spinner',
  'clipboardy',

  // ---- Optional telemetry (disabled by default) ----
  '@opentelemetry',

  // ---- Optional local embedding runtime (user can add back if needed) ----
  'node-llama-cpp',

  // ---- Build tooling (never needed at runtime) ----
  'typescript',
  'tsup',
  'tsx',
  'vite',
  '@vitejs',
  'vitest',
  '@vitest',
  'jsdom',
  '@testing-library',
  'tailwindcss',
  '@tailwindcss',
  'postcss',
  'postcss-import',
  'postcss-nested',
  'postcss-preset-env',
  'autoprefixer',
  'esbuild',
  '@esbuild',
  'rollup',
  '@rollup',
  '@swc',
  '@babel',
  '@reflink',
  'lightningcss',
  'lightningcss-darwin-arm64',
  'lightningcss-darwin-x64',
  'lightningcss-linux-x64-gnu',
  'lightningcss-linux-arm64-gnu',
  'claude-code-swarm',
  // NOTE: `sessionlog` is a devDependency of openhive BUT a runtime
  // dependency of swarmcraft (swarmcraft/dist/server/sessionlog imports
  // it). Don't prune.

  // ---- Electron-builder infra ----
  // Electron-builder and its direct deps are NOT deleted here because
  // electron-builder (+ dmg-builder, app-builder-lib, @electron/osx-sign,
  // @electron/notarize, etc.) run AFTER this script in the dist chain:
  //   `… && node scripts/prune-node-modules.mjs && electron-builder`
  // Deleting `node_modules/electron-builder/` leaves a dangling
  // `.bin/electron-builder` symlink → the subsequent shell step fails
  // with "command not found". Same for its subprocess spawns
  // (dmg-builder, osx-sign) which need the files on disk.
  //
  // These packages are kept OUT of the asar via the `files` filter in
  // electron-app/package.json (see `!**/electron/**`, `!**/@electron/**`,
  // `!**/electron-builder*/**`, `!**/dmg-builder/**`, etc.). No runtime
  // package declares any of these as a dep, so electron-builder's
  // dep-tree walk doesn't pull them into the asar either. Files filter
  // is sufficient here.
  //
  // If you want the disk-space saving for dev environments, restore via
  // `npm install` after the build — which is already the documented
  // cleanup step. Deleting them pre-build only breaks the build.

  // ---- Extraneous / dev leftovers (not reachable from package.json) ----
  'happy-dom',
  'browserslist',
  'caniuse-lite',
  'eslint',
  '@eslint',
  '@eslint-community',
  '@humanwhocodes',
  '@node-llama-cpp',
  '@dimforge',
  // jsdom itself is a dev/test dep; we drop it but KEEP its transitive
  // deps (whatwg-url, css-tree, etc.) because some of them are shared
  // with runtime deps (e.g. node-fetch → whatwg-url via tr46).
  'jsdom',
  '@storybook',

  // ---- Lodash from electron-builder's dep chain (both variants) ----
  // `lodash` is deduped from electron-builder → @malept/flatpak-bundler.
  // `lodash-es` orphans from mermaid (above). Both are safe to drop since
  // no runtime code in our server bundle imports them.
  'lodash',
];

// Subpaths inside packages to delete (for packages whose package.json
// `files` field is over-inclusive or that ship source/frontend alongside
// server code).
const DELETE_SUBPATHS = [
  // NOTE: `swarmcraft/public/wasm/` IS loaded at runtime by
  // swarmcraft/dist/server/pipeline/parser-loader.js — don't prune.
  // Only public/* subdirs that aren't wasm are safe to drop, but the
  // rest of public/ is small so we just leave it all.
  ['swarmcraft', 'src'],
  ['swarmcraft', 'docs'],
  ['swarmcraft', 'dist', 'ui'],
  ['macro-agent', 'src'],
  ['macro-agent', 'docs'],
  ['macro-agent', 'mvp_docs'],
  ['macro-agent', 'test_fixtures'],
  ['macro-agent', 'scripts'],
  ['openswarm', 'src'],
  ['openswarm', 'docs'],
  ['openswarm', 'scripts'],
  // cognitive-core source + playbooks: runtime uses dist/ only
  ['cognitive-core', 'src'],
  ['cognitive-core', 'docs'],
  ['cognitive-core', 'playbooks'],
  ['cognitive-core', 'scripts'],
  ['cognitive-core', 'package-lock.json'],
  // drizzle-orm ships dialect adapters for every DB; skill-tree-indexer
  // only uses the better-sqlite3 one. But `relations.js` cross-imports
  // from pg-core etc. at module-load time, so we can't prune dialects
  // without breaking drizzle's core. Keep them.
  // better-sqlite3 compile-time inputs: deps/sqlite3 is the upstream
  // SQLite C source (9.6M), src/ is the C++ addon source (160K), and
  // binding.gyp is the gyp build descriptor. None are loaded at runtime —
  // runtime uses the prebuilt `build/Release/better_sqlite3.node` binary
  // we pulled via `fix-better-sqlite3.mjs`. Safe to drop.
  ['better-sqlite3', 'deps'],
  ['better-sqlite3', 'src'],
];

// Platform-specific binary pruning. For a mac-arm64 build we keep
// arm64-darwin and drop the rest. $npm_config_target_platform /
// $npm_config_target_arch are set by electron-builder when it invokes
// scripts; otherwise we fall back to the host.
const targetPlatform = process.env.npm_config_target_platform || process.platform;
const targetArch = process.env.npm_config_target_arch || process.arch;

// Map Node's platform/arch to the naming ripgrep uses.
const RIPGREP_DIR = {
  'darwin-arm64': 'arm64-darwin',
  'darwin-x64': 'x64-darwin',
  'linux-x64': 'x64-linux',
  'linux-arm64': 'arm64-linux',
  'win32-x64': 'x64-win32',
  'win32-arm64': 'arm64-win32',
};
const ripgrepKeep = RIPGREP_DIR[`${targetPlatform}-${targetArch}`];
const ripgrepDirs = Object.values(RIPGREP_DIR);

// @openswarm/cli-* package-name suffixes that should be dropped — anything
// not matching the target.
const openswarmKeep = `${targetPlatform}-${targetArch}`;

let bytesFreed = 0;
let deletedCount = 0;

const referencesDir = path.join(repoRoot, 'references');
const nodeModulesRootReal = fs.realpathSync(path.join(repoRoot, 'node_modules'));

function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(cur);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(path.join(cur, e));
    } else {
      total += stat.size;
    }
  }
  return total;
}

/**
 * Delete a path safely — NEVER follow symlinks into `references/`.
 *
 * The `node_modules/<pkg>` entry for workspace-linked packages (like
 * `cognitive-core`) is a symlink pointing at `references/<pkg>`. A naive
 * `fs.rmSync(path, { recursive: true })` with a mid-path symlink will
 * resolve through the link and delete the REAL submodule source. That
 * happened once and cost a git-reset to recover. Now we:
 *
 *   1. If the leaf itself is a symlink → `fs.unlinkSync` (removes the
 *      link only, leaves the target alone).
 *   2. Resolve the realpath of the target. If it escapes
 *      `<repo>/node_modules/`, refuse the delete — this catches the
 *      `node_modules/cognitive-core/src` case where `cognitive-core` is
 *      a symlink into `references/`.
 */
function removeDir(dir, label) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }

  if (stat.isSymbolicLink()) {
    fs.unlinkSync(dir);
    deletedCount += 1;
    console.log(
      `  unlink ${path.relative(repoRoot, dir)} (symlink only) [${label}]`,
    );
    return;
  }

  // Real dir. Before deleting recursively, confirm the realpath doesn't
  // escape node_modules (guards against any ancestor symlink crossing
  // into references/).
  let realTarget;
  try {
    realTarget = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (!realTarget.startsWith(nodeModulesRootReal + path.sep) &&
      realTarget !== nodeModulesRootReal) {
    console.warn(
      `  REFUSED ${path.relative(repoRoot, dir)} → real path ${realTarget} escapes node_modules [${label}]`,
    );
    return;
  }

  const size = dirSize(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  bytesFreed += size;
  deletedCount += 1;
  console.log(
    `  rm ${path.relative(repoRoot, dir)} (${(size / 1024 / 1024).toFixed(1)}M) [${label}]`,
  );
}

/**
 * Is this path a symlink (so descending into it might escape into
 * `references/` or anywhere outside node_modules)?
 */
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function walkNodeModules(nodeModulesDir, depth = 0) {
  if (depth > 6) return; // safety cap on recursion
  if (!fs.existsSync(nodeModulesDir)) return;

  let entries = [];
  try {
    entries = fs.readdirSync(nodeModulesDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const pkgPath = path.join(nodeModulesDir, entry);

    // Scoped packages: recurse one level to get real package dirs.
    if (entry.startsWith('@')) {
      // Whole-scope deletion (e.g. @opentelemetry, @opentui).
      if (DELETE_PACKAGES.includes(entry)) {
        removeDir(pkgPath, 'frontend/tui/dev scope');
        continue;
      }
      // Otherwise recurse into sub-scope packages.
      let subEntries = [];
      try {
        subEntries = fs.readdirSync(pkgPath);
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        const scopedName = `${entry}/${sub}`;
        const subPath = path.join(pkgPath, sub);
        if (DELETE_PACKAGES.includes(scopedName)) {
          removeDir(subPath, 'frontend/tui/dev pkg');
          continue;
        }
        // Platform-prune @openswarm/cli-* — drop non-target CLIs.
        if (entry === '@openswarm' && sub.startsWith('cli-') && sub !== `cli-${openswarmKeep}`) {
          removeDir(subPath, 'cross-platform CLI');
          continue;
        }
        // Don't recurse through a symlink (e.g. `cognitive-core` → `references/cognitive-core`).
        if (isSymlink(subPath)) continue;
        // Recurse into nested node_modules.
        const inner = path.join(subPath, 'node_modules');
        if (fs.existsSync(inner)) walkNodeModules(inner, depth + 1);
      }
      continue;
    }

    if (DELETE_PACKAGES.includes(entry)) {
      removeDir(pkgPath, 'frontend/tui/dev pkg');
      continue;
    }

    // Don't recurse through a symlink into references/.
    if (isSymlink(pkgPath)) continue;

    // Recurse into any nested node_modules.
    const inner = path.join(pkgPath, 'node_modules');
    if (fs.existsSync(inner)) walkNodeModules(inner, depth + 1);
  }
}

// Delete subpaths (macro-agent/src, swarmcraft/dist/ui, etc.) wherever
// the parent package appears. Skips packages that are symlinks — their
// real location is usually `references/<pkg>/` and we must not touch
// that source tree.
function pruneSubpaths(nodeModulesDir, depth = 0) {
  if (depth > 6) return;
  if (!fs.existsSync(nodeModulesDir)) return;

  for (const [pkgName, ...sub] of DELETE_SUBPATHS) {
    const pkgDir = path.join(nodeModulesDir, pkgName);
    if (isSymlink(pkgDir)) continue; // don't reach into references/
    const target = path.join(pkgDir, ...sub);
    if (fs.existsSync(target)) removeDir(target, `${pkgName}/${sub.join('/')}`);
  }

  // Recurse into nested node_modules under every package.
  let entries = [];
  try {
    entries = fs.readdirSync(nodeModulesDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const pkgPath = path.join(nodeModulesDir, entry);
    if (entry.startsWith('@')) {
      let subEntries = [];
      try {
        subEntries = fs.readdirSync(pkgPath);
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        const subPkg = path.join(pkgPath, sub);
        if (isSymlink(subPkg)) continue;
        const inner = path.join(subPkg, 'node_modules');
        if (fs.existsSync(inner)) pruneSubpaths(inner, depth + 1);
      }
    } else {
      if (isSymlink(pkgPath)) continue;
      const inner = path.join(pkgPath, 'node_modules');
      if (fs.existsSync(inner)) pruneSubpaths(inner, depth + 1);
    }
  }
}

// Platform-prune ripgrep binaries from @anthropic-ai/claude-agent-sdk and
// its nested copy under @sudocode-ai/claude-code-acp. Skips symlinked
// packages (references/ source).
function pruneRipgrep(nodeModulesDir, depth = 0) {
  if (depth > 6) return;
  if (!fs.existsSync(nodeModulesDir)) return;

  for (const entry of fs.readdirSync(nodeModulesDir)) {
    if (entry.startsWith('.')) continue;
    const pkgPath = path.join(nodeModulesDir, entry);

    if (entry.startsWith('@')) {
      let subEntries = [];
      try {
        subEntries = fs.readdirSync(pkgPath);
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        const subPath = path.join(pkgPath, sub);
        if (isSymlink(subPath)) continue;
        const rg = path.join(subPath, 'vendor', 'ripgrep');
        if (fs.existsSync(rg)) {
          for (const dir of ripgrepDirs) {
            if (dir === ripgrepKeep) continue;
            const toDrop = path.join(rg, dir);
            if (fs.existsSync(toDrop)) removeDir(toDrop, `ripgrep cross-platform`);
          }
        }
        const inner = path.join(subPath, 'node_modules');
        if (fs.existsSync(inner)) pruneRipgrep(inner, depth + 1);
      }
    } else {
      if (isSymlink(pkgPath)) continue;
      const rg = path.join(pkgPath, 'vendor', 'ripgrep');
      if (fs.existsSync(rg)) {
        for (const dir of ripgrepDirs) {
          if (dir === ripgrepKeep) continue;
          const toDrop = path.join(rg, dir);
          if (fs.existsSync(toDrop)) removeDir(toDrop, `ripgrep cross-platform`);
        }
      }
      const inner = path.join(pkgPath, 'node_modules');
      if (fs.existsSync(inner)) pruneRipgrep(inner, depth + 1);
    }
  }
}

/**
 * Final sweep: delete file types that are never loaded at runtime.
 * Source maps (~50 MB across production deps), duplicate `.d.ts` files
 * (~6 MB), test dirs shipped by npm packages (~9 MB), non-LICENSE
 * markdown, ESLint configs, etc. Files are matched by extension/name so
 * no package-specific knowledge is needed.
 */
let sweptBytes = 0;
let sweptCount = 0;

function isInsideTarget(filename) {
  return (
    filename === 'test' ||
    filename === 'tests' ||
    filename === '__tests__' ||
    filename === '__mocks__' ||
    filename === 'powered-test' ||
    filename === 'benchmarks' ||
    filename === 'benchmark' ||
    filename === 'fixtures' ||
    filename === 'test_fixtures'
  );
}

function sweepFiles(dir, depth = 0) {
  if (depth > 12) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      // Prune entire dirs when their name matches a test/fixture convention.
      if (isInsideTarget(e.name)) {
        const size = dirSize(fullPath);
        fs.rmSync(fullPath, { recursive: true, force: true });
        sweptBytes += size;
        sweptCount += 1;
        continue;
      }
      sweepFiles(fullPath, depth + 1);
      continue;
    }

    const lower = e.name.toLowerCase();
    let shouldDelete = false;

    if (lower.endsWith('.map')) shouldDelete = true;
    else if (lower.endsWith('.d.ts')) shouldDelete = true;
    else if (lower.endsWith('.d.cts')) shouldDelete = true;
    else if (lower.endsWith('.d.mts')) shouldDelete = true;
    else if (lower === 'changelog.md' || lower === 'changelog') shouldDelete = true;
    else if (lower === 'changes.md' || lower === 'changes') shouldDelete = true;
    else if (lower === 'history.md' || lower === 'history') shouldDelete = true;
    else if (lower === 'migration.md' || lower === 'migrating.md') shouldDelete = true;
    else if (lower === 'readme.md' || lower === 'readme.markdown') shouldDelete = true;
    else if (lower === 'claude.md' || lower === 'claude.md') shouldDelete = true;
    else if (lower === 'contributing.md' || lower === 'code_of_conduct.md') shouldDelete = true;
    else if (lower === 'security.md' || lower === 'governance.md') shouldDelete = true;
    else if (lower === '.eslintrc' || lower.startsWith('.eslintrc.')) shouldDelete = true;
    else if (lower.startsWith('.prettierrc')) shouldDelete = true;
    else if (lower === '.editorconfig' || lower === '.npmignore') shouldDelete = true;
    else if (lower === '.travis.yml' || lower === '.circleci') shouldDelete = true;
    else if (lower === 'tsconfig.json' || lower.startsWith('tsconfig.')) shouldDelete = true;
    else if (lower === 'bun.lockb' || lower === 'bun.lock') shouldDelete = true;
    else if (lower === 'pnpm-lock.yaml' || lower === 'yarn.lock') shouldDelete = true;

    if (shouldDelete) {
      try {
        const size = fs.statSync(fullPath).size;
        fs.rmSync(fullPath, { force: true });
        sweptBytes += size;
        sweptCount += 1;
      } catch {
        // ignore
      }
    }
  }
}

console.log(`[prune-node-modules] Target: ${targetPlatform}-${targetArch}`);
console.log(`[prune-node-modules] ripgrep keep: ${ripgrepKeep || '(none — keep all)'}`);

const rootNM = path.join(repoRoot, 'node_modules');
console.log(`[prune-node-modules] Deleting frontend/TUI/dev packages…`);
walkNodeModules(rootNM);
console.log(`[prune-node-modules] Pruning package subpaths (swarmcraft, macro-agent, drizzle-orm dialects)…`);
pruneSubpaths(rootNM);
console.log(`[prune-node-modules] Platform-pruning ripgrep binaries…`);
pruneRipgrep(rootNM);
console.log(`[prune-node-modules] Sweeping .map / .d.ts / test dirs / docs…`);
sweepFiles(rootNM);

console.log(
  `[prune-node-modules] Removed ${deletedCount} dirs (${(bytesFreed / 1024 / 1024).toFixed(1)}M), swept ${sweptCount} files/dirs (${(sweptBytes / 1024 / 1024).toFixed(1)}M)`,
);
console.log(`[prune-node-modules] Run \`npm install\` at repo root to restore everything.`);
