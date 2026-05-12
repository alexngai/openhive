/**
 * Shared bundling helpers for `team_template` + `loadout` authored content.
 *
 * Two layers:
 *
 *   1. `bundleLoadoutContent` / `bundleTeamTemplateContent` — pure helpers
 *      that take an already-parsed content blob and bundle via
 *      `TemplateLoader.fromObject`. No filesystem IO.
 *
 *   2. `bundleLoadoutFromRow` / `bundleTeamTemplateFromRow` — Layer 6
 *      row-aware variants. When the row's `sync_strategy === 'ls-remote'`
 *      and `git_remote_url` looks like a real remote, the helper makes
 *      sure the local checkout exists (`ensureClone`) and bundles from
 *      `TemplateLoader.load(clonePath)`. Otherwise it falls back to the
 *      in-memory `bundleXxxContent` path (using `metadata.content`).
 *
 * The "git over inline content" preference matches the sidecar-as-author
 * model: once a row is git-backed, the on-disk YAML is canonical and the
 * `metadata.content` blob stays as a transient cache / fallback.
 */

import {
  bundleLoadout,
  bundleTeam,
  resolveStandaloneLoadout,
  TemplateLoader,
} from 'openteams';
import type {
  LoadoutDefinition,
  LoadoutResource,
  RoleDefinition,
  ResolvedPrompts,
  TeamManifest,
  TeamResource,
} from 'openteams';
import { existsSync } from 'node:fs';
import * as gitContent from '../../sync/git-content.js';
import { resolveDataDir } from '../../data-dir.js';
import type { SyncableResource } from '../../types.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';

/** Bundle a standalone loadout from an in-memory content blob. */
export function bundleLoadoutContent(
  name: string,
  content: LoadoutContent,
): LoadoutResource {
  const resolved = resolveStandaloneLoadout(content as LoadoutDefinition);
  return bundleLoadout(resolved, { version: '0.0.0', name });
}

/** Bundle a team template from an in-memory content blob. */
export function bundleTeamTemplateContent(
  name: string,
  content: TeamTemplateContent,
): TeamResource {
  const template = TemplateLoader.fromObject({
    // openhive's Zod schema is permissive over `topology` / `communication`
    // (passthrough so extension namespaces survive); openteams's loader
    // runs its own strict validation inside `fromObject`. Cast bridges the
    // gap.
    manifest: content.manifest as unknown as TeamManifest,
    roles: content.roles as Record<string, RoleDefinition> | undefined,
    loadouts: content.loadouts as Record<string, LoadoutDefinition> | undefined,
    prompts: content.prompts as Record<string, ResolvedPrompts> | undefined,
  });
  return bundleTeam(template, { version: '0.0.0', name });
}

// ── Layer 6: row-aware bundling ────────────────────────────────────────────

/**
 * Should this row resolve content from a git checkout rather than
 * `metadata.content`? True when:
 *   - sync_strategy is 'ls-remote' (we own the clone lifecycle), AND
 *   - git_remote_url is a real remote (not `local://...`).
 */
function isGitBacked(row: SyncableResource): boolean {
  if (row.sync_strategy !== 'ls-remote') return false;
  const url = row.git_remote_url ?? '';
  return url.length > 0 && !url.startsWith('local://');
}

/**
 * Ensure the row has a local checkout and return the clone path. Updates
 * `syncable_resources.local_path` on first clone so subsequent lookups
 * skip the work.
 */
async function ensureRowClone(row: SyncableResource): Promise<string> {
  // If the row carries a `local_path` and it actually exists on disk,
  // trust it — the caller (or a previous ensureClone) has taken
  // responsibility. This covers tests staging fake checkouts as well as
  // production rows whose clones live outside `<dataDir>/<id>/` (e.g.
  // pre-existing checkouts the user pointed the hub at).
  if (row.local_path && existsSync(row.local_path)) {
    return row.local_path;
  }
  const dataDir = resolveDataDir();
  const clonePath = await gitContent.ensureClone(row, dataDir);
  resourcesDAL.updateLocalPath(row.id, clonePath);
  return clonePath;
}

/**
 * Bundle a `loadout` row. For git-backed rows, reads YAML from the clone;
 * otherwise falls back to `metadata.content`.
 */
export async function bundleLoadoutFromRow(row: SyncableResource): Promise<LoadoutResource | null> {
  if (isGitBacked(row)) {
    const clonePath = await ensureRowClone(row);
    // Standalone loadouts live as a single YAML in the repo root; load
    // via the dedicated loader path. `TemplateLoader.load` is the team
    // entry, so for a single-file loadout we fall back to reading
    // `metadata.content` until `openteams.loadStandaloneLoadout(dir)`
    // ships upstream — note in plan §"Out of scope".
    void clonePath;
  }
  const content = (row.metadata as { content?: LoadoutContent } | null)?.content;
  if (!content) return null;
  return bundleLoadoutContent(row.name, content);
}

/**
 * Bundle a `team_template` row. For git-backed rows, hydrates via
 * `TemplateLoader.load(clonePath)`; otherwise via the in-memory
 * `fromObject` path against `metadata.content`.
 */
export async function bundleTeamTemplateFromRow(row: SyncableResource): Promise<TeamResource | null> {
  if (isGitBacked(row)) {
    const clonePath = await ensureRowClone(row);
    const template = TemplateLoader.load(clonePath);
    return bundleTeam(template, { version: '0.0.0', name: row.name });
  }
  const content = (row.metadata as { content?: TeamTemplateContent } | null)?.content;
  if (!content) return null;
  return bundleTeamTemplateContent(row.name, content);
}
