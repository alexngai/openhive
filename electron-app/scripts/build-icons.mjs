#!/usr/bin/env node
/**
 * Build platform icon assets from src/web/public/logo.png.
 *
 *   src/web/public/logo.png   (source of truth, brand logo)
 *     → electron-app/build/icon.icns  (macOS, multi-resolution)
 *     → electron-app/build/icon.png   (Linux, 512x512)
 *
 * Re-run whenever the source logo changes:
 *   node electron-app/scripts/build-icons.mjs
 *
 * Wired into `npm run dist` so packaged builds always have fresh icons.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const source = join(repoRoot, 'src', 'web', 'public', 'logo.png');
const buildDir = join(__dirname, '..', 'build');
const iconsetDir = join(buildDir, 'icon.iconset');
const icnsOut = join(buildDir, 'icon.icns');
const linuxOut = join(buildDir, 'icon.png');

if (!existsSync(source)) {
  console.error(`[icons] source missing: ${source}`);
  process.exit(1);
}

await mkdir(buildDir, { recursive: true });
await rm(iconsetDir, { recursive: true, force: true });
await mkdir(iconsetDir, { recursive: true });

// Apple's iconset spec: each logical size has a 1x and a @2x variant.
// Names are exact — `iconutil` rejects anything else.
const variants = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
  { name: 'icon_512x512@2x.png', size: 1024 },
];

const master = await sharp(source)
  .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

await Promise.all(
  variants.map(async ({ name, size }) => {
    const buf = await sharp(master).resize(size, size).png().toBuffer();
    await writeFile(join(iconsetDir, name), buf);
  }),
);

execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsOut], {
  stdio: 'inherit',
});

await sharp(master).resize(512, 512).png().toFile(linuxOut);

await rm(iconsetDir, { recursive: true, force: true });

console.log(`[icons] wrote ${icnsOut}`);
console.log(`[icons] wrote ${linuxOut}`);
