/**
 * Replaces the workspace symlink at `node_modules/openhive` with a pruned
 * copy containing only what openhive actually ships (dist/, bin/,
 * package.json). Run immediately before `electron-builder`.
 *
 * Why: openhive is installed as a `file:..` workspace dep, which means
 * `electron-app/node_modules/openhive` is a symlink to the repo root.
 * electron-builder follows that symlink and bundles the ENTIRE repo —
 * `references/` (2GB of submodules), `.git`, `data/` (runtime hive data),
 * `release/` (prior builds), etc. — because its `files` filter patterns
 * are evaluated against the resolved symlink target, not the logical
 * `node_modules/openhive/*` path.
 *
 * We also rewrite the staged `package.json` to list only *runtime* deps.
 * The full list includes frontend packages (react, mermaid, lucide-react,
 * three, etc.) that Vite already bundles into `dist/web/assets/*.js` — but
 * electron-builder resolves deps by walking `package.json`.dependencies,
 * independent of the `files` filter. So frontend packages show up in the
 * asar unless we strip them from the staged package.json. Stripping them
 * from the *staged* copy doesn't affect the real openhive package — the
 * real deps are already in `/Users/alexngai/GitHub/openhive/package.json`
 * and get restored when `npm install` runs.
 *
 * The `file:..` symlink is a dev-time convenience for editing openhive
 * source and having the electron-app pick up changes. For packaging,
 * we want an honest npm-pack-style install. This script does that swap.
 *
 * After electron-builder finishes, `npm install` (at the repo root)
 * restores the workspace symlink.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronApp = path.resolve(__dirname, '..');
const repoRoot = path.resolve(electronApp, '..');

const SHIP = ['dist', 'bin'];

// Runtime deps the bundled server actually imports (static + dynamic).
// Keep this aligned with imports found in `dist/index.js` / `dist/cli.js`.
// Everything else (frontend libs, build tools, test infra) is pruned.
const RUNTIME_DEPS = new Set([
  '@anthropic-ai/sandbox-runtime',
  '@fastify/cors',
  '@fastify/multipart',
  '@fastify/rate-limit',
  '@fastify/static',
  '@fastify/websocket',
  '@lydell/node-pty',
  '@multi-agent-protocol/sdk',
  'agent-iam',
  'agent-inbox',
  'agent-workspace',
  'bcrypt',
  'better-sqlite3',
  'cognitive-core',
  'commander',
  'fastify',
  'git-cascade',
  'jose',
  'js-yaml',
  'macro-agent',
  'marked',
  'mime-types',
  'minimem',
  'nanoid',
  'nodemailer',
  'openhive-types',
  'openswarm',
  'opentasks',
  'pg',
  'sharp',
  'skill-tree',
  'skill-tree-indexer',
  'swarm-dispatch',
  'swarmcraft',
  'swarmkit',
  'turndown',
  'unique-names-generator',
  'ws',
  'zod',
]);

// Optional runtime deps — keep in optionalDependencies so npm doesn't fail
// if they can't install (e.g. @google-cloud/storage on ARM edge cases).
const OPTIONAL_RUNTIME_DEPS = new Set([
  '@aws-sdk/client-s3',
  '@google-cloud/storage',
  '@slack/socket-mode',
  '@slack/web-api',
]);

function pickDeps(source, allowList) {
  if (!source) return undefined;
  const out = {};
  for (const [name, version] of Object.entries(source)) {
    if (allowList.has(name)) out[name] = version;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stagedPackageJson(original) {
  const pkg = { ...original };
  pkg.dependencies = pickDeps(original.dependencies, RUNTIME_DEPS);
  pkg.optionalDependencies = pickDeps(
    original.optionalDependencies,
    OPTIONAL_RUNTIME_DEPS,
  );
  // Dev deps are never copied by electron-builder, but clear them defensively
  // so the staged package.json reads cleanly.
  delete pkg.devDependencies;
  delete pkg.scripts;
  return pkg;
}

// electron-builder copies the entire package.json directory (electron-app/)
// into the asar root. Local dev artifacts live here too. Wipe them before
// building so they don't ship — especially iam-secret.key + openhive.db,
// which would leak dev credentials + state into every user's download.
const DEV_ARTIFACTS_TO_WIPE = [
  path.join(electronApp, 'data'),
  path.join(electronApp, 'logs'),
  path.join(electronApp, 'uploads'),
  path.join(electronApp, '.openhive'),
  path.join(electronApp, '.swarm'),
];

for (const p of DEV_ARTIFACTS_TO_WIPE) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`[stage-openhive] Wiped dev artifact ${path.relative(repoRoot, p)}`);
  }
}

const targets = [
  path.join(electronApp, 'node_modules', 'openhive'),
  path.join(repoRoot, 'node_modules', 'openhive'),
];

const originalPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const prunedPkg = stagedPackageJson(originalPkg);

const droppedDeps = Object.keys(originalPkg.dependencies ?? {}).filter(
  (name) => !RUNTIME_DEPS.has(name),
);

console.log(`[stage-openhive] Repo root: ${repoRoot}`);
console.log(
  `[stage-openhive] Keeping ${Object.keys(prunedPkg.dependencies ?? {}).length} runtime deps, dropping ${droppedDeps.length} frontend/build deps`,
);

for (const target of targets) {
  console.log(`[stage-openhive] Replacing ${target} with pruned copy`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  for (const entry of SHIP) {
    const src = path.join(repoRoot, entry);
    if (!fs.existsSync(src)) {
      console.log(`[stage-openhive]   skip ${entry} (not present)`);
      continue;
    }
    fs.cpSync(src, path.join(target, entry), { recursive: true, dereference: true });
    console.log(`[stage-openhive]   copied ${entry}`);
  }

  fs.writeFileSync(
    path.join(target, 'package.json'),
    JSON.stringify(prunedPkg, null, 2),
  );
  console.log(`[stage-openhive]   wrote trimmed package.json`);
}

console.log(`[stage-openhive] Done — run \`npm install\` at repo root to restore the workspace symlink when finished.`);
