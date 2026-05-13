/**
 * Boot-time hydration of the openteams bundle store.
 *
 * The in-memory `InMemoryBundleStore` is volatile — restarts wipe it. To
 * keep `map/resources/get` and `list` honoring existing authored content,
 * we walk all `team_template` and `loadout` rows in `syncable_resources`
 * once at startup and re-bundle them into the store.
 *
 * Bundling goes through `src/openteams/internal/bundle-content.ts` which
 * uses `TemplateLoader.fromObject` — no temp-dir round-trip, no disk IO
 * beyond reading the row metadata. When we promote the store to a
 * persistent table this seed pass becomes redundant.
 */

import type { MAPResource } from 'openteams';
import { getDatabase } from '../db/index.js';
import { findResourceById } from '../db/dal/syncable-resources.js';
import type { SyncableResource } from '../types.js';
import { getOpenteamsBundleStore } from './map-handlers.js';
import {
  bundleLoadoutFromRow,
  bundleTeamTemplateFromRow,
} from './internal/bundle-content.js';

export interface SeedResult {
  loadouts: number;
  teams: number;
  errors: Array<{ resource_id: string; resource_type: string; message: string }>;
}

/**
 * Walk every `loadout` and `team_template` row and bundle each one into the
 * openteams bundle store. Idempotent — re-running overwrites existing
 * entries with the same hash (a no-op for unchanged content).
 *
 * Errors on individual rows are collected and returned; one bad row should
 * never block the boot path.
 */
export async function seedOpenteamsBundleStore(): Promise<SeedResult> {
  const result: SeedResult = { loadouts: 0, teams: 0, errors: [] };
  const store = getOpenteamsBundleStore();

  // Raw `SELECT *` returns `metadata` as the stringified column value —
  // need each row through `findResourceById` so the metadata JSON is
  // parsed before we look up `metadata.content`.
  const ids = (
    getDatabase()
      .prepare(
        `SELECT id FROM syncable_resources WHERE resource_type IN ('loadout', 'team_template')`,
      )
      .all() as Array<{ id: string }>
  ).map((r) => r.id);

  const rows = ids
    .map((id) => findResourceById(id))
    .filter((r): r is SyncableResource => r !== null);

  for (const row of rows) {
    try {
      if (row.resource_type === 'loadout') {
        // Row-aware helper handles both git-backed (ls-remote, reads from
        // local checkout) and inline (metadata.content) rows. Skips
        // silently when neither source has content yet.
        const bundle = await bundleLoadoutFromRow(row);
        if (bundle) {
          await store.put(bundle as unknown as MAPResource);
          result.loadouts++;
        }
      } else if (row.resource_type === 'team_template') {
        const bundle = await bundleTeamTemplateFromRow(row);
        if (bundle) {
          await store.put(bundle as unknown as MAPResource);
          result.teams++;
        }
      }
    } catch (err) {
      result.errors.push({
        resource_id: row.id,
        resource_type: row.resource_type,
        message: (err as Error).message,
      });
    }
  }

  return result;
}
