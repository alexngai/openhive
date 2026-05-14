/**
 * syncpack — flags when the same dependency is pinned to different versions
 * across our package.json files.
 *
 * `source` here is the strict scope: this repo's own workspaces (root +
 * electron-app + packages/*). These MUST always agree — a mismatch is a real
 * bug — so `npm run deps:check` and CI both gate on it.
 *
 * The vendored sibling repos under references/ are separate git repos with
 * their own (legitimately different) dependency sets. Auditing drift across
 * them is `npm run deps:check:all` — useful to run by hand, but not a CI
 * gate, since openhive's PRs shouldn't go red over another repo's
 * package.json. Keeping first-party packages bumped across repos is
 * Renovate's job (see renovate.json5).
 */
module.exports = {
  source: [
    'package.json',
    'electron-app/package.json',
    'packages/*/package.json',
  ],
  versionGroups: [
    {
      // Locally-developed packages that also appear as dependencies of
      // sibling workspaces (electron-app depends on openhive via file:..,
      // etc.). They're referenced by file:/range on purpose — they are not
      // registry-managed here — so syncpack should not try to reconcile
      // their specifiers against the on-disk version.
      label: 'Local workspace packages (not registry-managed here)',
      dependencies: ['openhive', 'openhive-headless', 'openhive-electron', 'openhive-types'],
      isIgnored: true,
    },
  ],
};
