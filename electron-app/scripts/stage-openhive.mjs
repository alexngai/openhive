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

// Files openhive publishes (matches its package.json `files` field).
const SHIP = ['dist', 'bin'];

// Both locations can hold an openhive self-reference:
//   - electron-app/node_modules/openhive    (file:.. dep in electron-app)
//   - node_modules/openhive                 (npm workspace root-level symlink)
// Both resolve to the repo root via symlink and must be replaced with the
// pruned copy, or our `from: ../node_modules` electron-builder filter pulls
// the whole repo through the second one.
const targets = [
  path.join(electronApp, 'node_modules', 'openhive'),
  path.join(repoRoot, 'node_modules', 'openhive'),
];

console.log(`[stage-openhive] Repo root: ${repoRoot}`);

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

  fs.copyFileSync(
    path.join(repoRoot, 'package.json'),
    path.join(target, 'package.json'),
  );
  console.log(`[stage-openhive]   copied package.json`);
}

console.log(`[stage-openhive] Done — run \`npm install\` at repo root to restore the workspace symlink when finished.`);
