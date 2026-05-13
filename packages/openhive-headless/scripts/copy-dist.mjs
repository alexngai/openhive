#!/usr/bin/env node
// Copies the server-only artifacts from ../../dist into ./dist, skipping
// dist/web/. Run via `npm run build` (and prepublishOnly) so the published
// tarball ships without the SPA bundle.

import { cp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const srcDist = join(repoRoot, 'dist');
const dstDist = join(pkgRoot, 'dist');

async function ensureSourceBuilt() {
  try {
    const s = await stat(join(srcDist, 'cli.js'));
    if (!s.isFile()) throw new Error('not a file');
  } catch {
    console.error(
      `[openhive-headless] missing ${join(srcDist, 'cli.js')}. ` +
        `Run \`npm run build:server\` at the repo root first.`,
    );
    process.exit(1);
  }
}

async function main() {
  await ensureSourceBuilt();
  await rm(dstDist, { recursive: true, force: true });
  await cp(srcDist, dstDist, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(srcDist.length).replace(/^[\\/]+/, '');
      if (rel === 'web' || rel.startsWith('web/') || rel.startsWith('web\\')) {
        return false;
      }
      return true;
    },
  });
  console.log(`[openhive-headless] copied ${srcDist} → ${dstDist} (excluded web/)`);
}

main().catch((err) => {
  console.error('[openhive-headless] copy-dist failed:', err);
  process.exit(1);
});
