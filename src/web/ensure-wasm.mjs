/**
 * Ensures `src/web/public/wasm` points at a valid source of the
 * tree-sitter/ghostty WASM grammars before vite build runs.
 *
 * Dev: the `references/swarmcraft/` submodule is populated, so we link
 *      there and pick up any live edits.
 * CI / production / docker: the submodule isn't checked out (references/
 *      is git-submodule + not cloned on ubuntu-latest), so we fall back to
 *      the installed `node_modules/swarmcraft/public/wasm` which ships the
 *      same files.
 *
 * Symlinked rather than copied so we don't double up disk usage, and so
 * dev edits propagate without a rebuild.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const link = path.join(__dirname, 'public', 'wasm');

const candidates = [
  path.resolve(__dirname, '../../references/swarmcraft/public/wasm'),
  path.resolve(__dirname, '../../node_modules/swarmcraft/public/wasm'),
];

const target = candidates.find((c) => fs.existsSync(c));
if (!target) {
  console.error('[ensure-wasm] No wasm source found. Checked:');
  for (const c of candidates) console.error('  -', c);
  process.exit(1);
}

// Remove whatever's at the target path (broken symlink, stale copy, stale
// dir, etc.) so we can create a fresh link. rmSync on a symlink removes
// only the link, not the target.
fs.rmSync(link, { recursive: true, force: true });
fs.symlinkSync(target, link, 'dir');
console.log(`[ensure-wasm] ${link} -> ${target}`);
