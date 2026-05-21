/**
 * verify-update-feed — asserts the auto-update feed a full build produces is
 * actually consumable by electron-updater.
 *
 * The failure mode this guards: macOS auto-update runs through Squirrel.Mac,
 * which can *only* update from a `.zip` — never a `.dmg`. If the mac build
 * target is `dmg`-only, new users can still install, but no installed app
 * can ever auto-update, and nothing crashes — `latest-mac.yml` just doesn't
 * reference a zip and electron-updater silently no-ops. verify-asar and
 * smoke-test can't see this; it's about the *release artifacts*, not the app.
 *
 * Self-detecting, so it's safe to run from `npm run verify` in any context:
 *   - After `electron-builder --dir` (the `pack` flow): no installers exist,
 *     no `latest-*.yml` — nothing to verify, the script skips and exits 0.
 *   - After a full `electron-builder` (the `dist` flow / release.yml): the
 *     `.dmg` / `.AppImage` exist, so the matching update feed is *required*
 *     — its absence or a missing updater artifact fails the build.
 *
 * Run after a full electron-builder, from the electron-app directory:
 *   node scripts/verify-update-feed.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Defaults to ../../release; an explicit path can be passed (used by tests).
const releaseDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', '..', 'release');

if (!fs.existsSync(releaseDir)) {
  console.log('[verify-update-feed] SKIP: no release/ directory — run electron-builder first');
  process.exit(0);
}

// Top-level files only — electron-builder writes installers + latest-*.yml to
// release/ root; the unpacked .app lives in a subdir we don't care about here.
const entries = fs
  .readdirSync(releaseDir, { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name);

const has = (ext) => entries.some((f) => f.toLowerCase().endsWith(ext));
const find = (ext) => entries.filter((f) => f.toLowerCase().endsWith(ext));

const hasMac = has('.dmg') || has('.zip');
const hasLinux = has('.appimage') || has('.deb');

if (!hasMac && !hasLinux) {
  console.log(
    '[verify-update-feed] SKIP: no installers in release/ — this was an ' +
      '`electron-builder --dir` build (no update feed is produced for --dir)',
  );
  process.exit(0);
}

let failed = false;
const check = (ok, okMsg, failMsg) => {
  if (ok) {
    console.log(`[verify-update-feed]   ✓ ${okMsg}`);
  } else {
    console.error(`[verify-update-feed]   ✗ ${failMsg}`);
    failed = true;
  }
};

// A feed (latest-*.yml) is consumable if it textually references the updater
// artifact and that artifact is on disk. electron-builder's YAML is small and
// stable; a filename scan avoids pulling in a YAML parser as a dependency.
function feedReferences(feedFile, ext) {
  const text = fs.readFileSync(path.join(releaseDir, feedFile), 'utf8');
  const re = new RegExp(`[A-Za-z0-9._-]+\\${ext}`, 'gi');
  return [...new Set(text.match(re) ?? [])];
}

if (hasMac) {
  console.log('[verify-update-feed] macOS build detected');
  // .dmg — what a first-time user downloads and drags to Applications.
  check(has('.dmg'), `installer present: ${find('.dmg').join(', ')}`,
    'no .dmg — first-time users have no installer');
  // .zip — the ONLY artifact Squirrel.Mac can auto-update from.
  check(has('.zip'),
    `updater artifact present: ${find('.zip').join(', ')}`,
    'no .zip — macOS auto-update is impossible (Squirrel.Mac is zip-only). ' +
      'Add "zip" to mac.target in electron-app/package.json.');

  const feedExists = entries.includes('latest-mac.yml');
  check(feedExists, 'latest-mac.yml present',
    'latest-mac.yml missing — electron-updater has no feed to poll');

  if (feedExists) {
    const zipsInFeed = feedReferences('latest-mac.yml', '.zip').filter((z) =>
      entries.includes(z),
    );
    check(zipsInFeed.length > 0,
      `latest-mac.yml references an on-disk .zip: ${zipsInFeed.join(', ')}`,
      'latest-mac.yml does not reference a present .zip — electron-updater ' +
        'will find nothing to download. The feed must point at the zip.');
  }
}

if (hasLinux) {
  console.log('[verify-update-feed] Linux build detected');
  // .AppImage — the only Linux target electron-updater auto-updates (deb is
  // package-manager territory; the updater never touches it).
  check(has('.appimage'),
    `updater artifact present: ${find('.AppImage').join(', ')}`,
    'no .AppImage — Linux auto-update has no artifact');

  const feedExists = entries.includes('latest-linux.yml');
  check(feedExists, 'latest-linux.yml present',
    'latest-linux.yml missing — electron-updater has no feed to poll');

  if (feedExists) {
    const imagesInFeed = feedReferences('latest-linux.yml', '.AppImage').filter(
      (a) => entries.includes(a),
    );
    check(imagesInFeed.length > 0,
      `latest-linux.yml references an on-disk .AppImage: ${imagesInFeed.join(', ')}`,
      'latest-linux.yml does not reference a present .AppImage');
  }
}

if (failed) {
  console.error('[verify-update-feed] FAIL: update feed is not auto-update-capable (see ✗ above)');
  process.exit(1);
}
console.log('[verify-update-feed] PASS: update feed references a present updater artifact');
