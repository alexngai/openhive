/**
 * Bridge authored-content lifecycle to the openteams bundle store.
 *
 * Layer 1 already fans `team_template` / `loadout` writes out to the mesh
 * via `onResourcePublished/Updated/Unpublished`. Layer 2 additionally
 * mirrors those writes into the in-memory bundle store so cross-runtime
 * agents can fetch the content-addressed snapshot through
 * `map/resources/get` without waiting for a seed pass.
 *
 * The route handlers call:
 *
 *   onTeamTemplateBundle(row)   // POST + PATCH
 *   onLoadoutBundle(row)        // POST + PATCH
 *   onTeamTemplateRemoved(row)  // DELETE (pre-delete row supplied so we can rebundle to derive the hash)
 *   onLoadoutRemoved(row)       // DELETE
 *
 * Bundling goes through `internal/bundle-content.ts`, which uses
 * `TemplateLoader.fromObject` — no temp-dir round-trip.
 *
 * Failures are recorded into a small ring buffer surfaced via
 * `getOpenteamsBundleFailures()` so operators can spot silent breakage.
 *
 * Lifecycle events (`resource.added` / `updated` / `removed`) flow
 * automatically via the kind handlers' `emit` hook, which is wired to the
 * MAPServer event bus in `src/map/map-server-setup.ts`.
 */

import {
  LOADOUT_RESOURCE_TYPE,
  TEAM_RESOURCE_TYPE,
} from 'openteams';
import type { MAPResource } from 'openteams';
import { getOpenteamsBundleStore } from './map-handlers.js';
import type { SyncableResource } from '../types.js';
import type { LoadoutContent } from '../api/schemas/loadouts.js';
import type { TeamTemplateContent } from '../api/schemas/teams.js';
import {
  bundleLoadoutContent,
  bundleTeamTemplateContent,
} from './internal/bundle-content.js';

// ── Failure observability ───────────────────────────────────────────────────

export interface OpenteamsBundleFailure {
  resource_id: string;
  resource_type: 'loadout' | 'team_template';
  operation: 'bundle' | 'remove';
  message: string;
  ts: string;
}

const MAX_FAILURES = 200;
const failures: OpenteamsBundleFailure[] = [];

function recordFailure(failure: OpenteamsBundleFailure): void {
  failures.push(failure);
  if (failures.length > MAX_FAILURES) failures.shift();
}

/** Snapshot the recent auto-bundle failures (oldest → newest). */
export function getOpenteamsBundleFailures(): ReadonlyArray<OpenteamsBundleFailure> {
  return failures.slice();
}

/** Test-only: clear the failure log. */
export function _resetOpenteamsBundleFailures(): void {
  failures.length = 0;
}

// ── Auto-bundle on write ────────────────────────────────────────────────────

/**
 * Bundle a `loadout` row's authored content into the openteams store.
 * Returns the bundle id on success, or null when the row has no content
 * or bundling failed (in which case the failure is also captured for
 * operator visibility).
 */
export async function onLoadoutBundle(row: SyncableResource): Promise<string | null> {
  const content = (row.metadata as { content?: LoadoutContent } | null)?.content;
  if (!content) return null;
  try {
    const bundle = bundleLoadoutContent(row.name, content);
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);
    return bundle.id;
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[openteams] auto-bundle loadout ${row.id} failed: ${message}`);
    recordFailure({
      resource_id: row.id,
      resource_type: 'loadout',
      operation: 'bundle',
      message,
      ts: new Date().toISOString(),
    });
    return null;
  }
}

export async function onTeamTemplateBundle(row: SyncableResource): Promise<string | null> {
  const content = (row.metadata as { content?: TeamTemplateContent } | null)?.content;
  if (!content) return null;
  try {
    const bundle = bundleTeamTemplateContent(row.name, content);
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);
    return bundle.id;
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[openteams] auto-bundle team_template ${row.id} failed: ${message}`);
    recordFailure({
      resource_id: row.id,
      resource_type: 'team_template',
      operation: 'bundle',
      message,
      ts: new Date().toISOString(),
    });
    return null;
  }
}

// ── Auto-remove on unpublish ────────────────────────────────────────────────
// The route handler hands us the row as it existed just before deletion. We
// recompute the bundle hash from that content (deterministic via the
// canonical hash) and remove by id from the store. This avoids the need
// for a row→hash side-map and survives restart (bundle ids are stable).

export async function onLoadoutRemoved(row: SyncableResource): Promise<void> {
  const content = (row.metadata as { content?: LoadoutContent } | null)?.content;
  if (!content) return;
  try {
    const bundle = bundleLoadoutContent(row.name, content);
    await getOpenteamsBundleStore().delete(LOADOUT_RESOURCE_TYPE, bundle.id);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[openteams] auto-remove loadout ${row.id} failed: ${message}`);
    recordFailure({
      resource_id: row.id,
      resource_type: 'loadout',
      operation: 'remove',
      message,
      ts: new Date().toISOString(),
    });
  }
}

export async function onTeamTemplateRemoved(row: SyncableResource): Promise<void> {
  const content = (row.metadata as { content?: TeamTemplateContent } | null)?.content;
  if (!content) return;
  try {
    const bundle = bundleTeamTemplateContent(row.name, content);
    await getOpenteamsBundleStore().delete(TEAM_RESOURCE_TYPE, bundle.id);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[openteams] auto-remove team_template ${row.id} failed: ${message}`);
    recordFailure({
      resource_id: row.id,
      resource_type: 'team_template',
      operation: 'remove',
      message,
      ts: new Date().toISOString(),
    });
  }
}
