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
  'graphology',
  'graphology-layout',
  'graphology-layout-forceatlas2',
  'graphology-shortest-path',
  'graphology-traversal',
  'graphology-indices',
  'graphology-utils',
  'graphology-types',
  'graphology-metrics',
  'graphology-communities-louvain',
  'graphology-operators',
  'sigma',
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
  'sessionlog',

  // ---- Electron-builder infra (not needed in packaged app) ----
  'electron',
  '@electron',
  'electron-builder',
  'electron-builder-squirrel-windows',
  'electron-winstaller',
  'app-builder-bin',
  'app-builder-lib',
  'dmg-builder',
  'dmg-license',
  'builder-util',
  'builder-util-runtime',
  '7zip-bin',
  'postject',
  '@malept',
  'flatpak-bundler',

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
];

// Subpaths inside packages to delete (for packages whose package.json
// `files` field is over-inclusive or that ship source/frontend alongside
// server code).
const DELETE_SUBPATHS = [
  ['swarmcraft', 'public'],
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

function removeDir(dir, label) {
  if (!fs.existsSync(dir)) return;
  const size = dirSize(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  bytesFreed += size;
  deletedCount += 1;
  const rel = path.relative(repoRoot, dir);
  console.log(`  rm ${rel} (${(size / 1024 / 1024).toFixed(1)}M) [${label}]`);
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

    // Recurse into any nested node_modules.
    const inner = path.join(pkgPath, 'node_modules');
    if (fs.existsSync(inner)) walkNodeModules(inner, depth + 1);
  }
}

// Delete subpaths (swarmcraft/public, macro-agent/src, etc.) wherever the
// parent package appears (top-level or nested).
function pruneSubpaths(nodeModulesDir, depth = 0) {
  if (depth > 6) return;
  if (!fs.existsSync(nodeModulesDir)) return;

  for (const [pkgName, ...sub] of DELETE_SUBPATHS) {
    const target = path.join(nodeModulesDir, pkgName, ...sub);
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
        const inner = path.join(pkgPath, sub, 'node_modules');
        if (fs.existsSync(inner)) pruneSubpaths(inner, depth + 1);
      }
    } else {
      const inner = path.join(pkgPath, 'node_modules');
      if (fs.existsSync(inner)) pruneSubpaths(inner, depth + 1);
    }
  }
}

// Platform-prune ripgrep binaries from @anthropic-ai/claude-agent-sdk and
// its nested copy under @sudocode-ai/claude-code-acp.
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

console.log(`[prune-node-modules] Target: ${targetPlatform}-${targetArch}`);
console.log(`[prune-node-modules] ripgrep keep: ${ripgrepKeep || '(none — keep all)'}`);

const rootNM = path.join(repoRoot, 'node_modules');
console.log(`[prune-node-modules] Deleting frontend/TUI/dev packages…`);
walkNodeModules(rootNM);
console.log(`[prune-node-modules] Pruning package subpaths (swarmcraft, macro-agent)…`);
pruneSubpaths(rootNM);
console.log(`[prune-node-modules] Platform-pruning ripgrep binaries…`);
pruneRipgrep(rootNM);

console.log(
  `[prune-node-modules] Done — removed ${deletedCount} dirs, freed ${(bytesFreed / 1024 / 1024).toFixed(1)}M`,
);
console.log(`[prune-node-modules] Run \`npm install\` at repo root to restore everything.`);
