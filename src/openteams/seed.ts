/**
 * Boot-time hydration of the openteams bundle store.
 *
 * The in-memory `InMemoryBundleStore` is volatile — restarts wipe it. To
 * keep `map/resources/get` and `list` honoring existing authored content,
 * we walk all `team_template` and `loadout` rows in `syncable_resources`
 * once at startup and re-bundle them into the store.
 *
 * Standalone loadouts go through `resolveStandaloneLoadout` + `bundleLoadout`
 * directly. Teams round-trip through a temporary YAML directory because
 * `TemplateLoader` is the canonical resolver and there's no public
 * "hydrate from object" API yet — the cost is paid once per row at boot,
 * which is fine for the in-memory iteration. When we promote the store to
 * a persistent table this seed pass becomes redundant.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  TemplateLoader,
  bundleLoadout,
  bundleTeam,
  resolveStandaloneLoadout,
} from 'openteams';
import type { LoadoutDefinition, MAPResource } from 'openteams';
import { getDatabase } from '../db/index.js';
import { findResourceById } from '../db/dal/syncable-resources.js';
import type { SyncableResource } from '../types.js';
import type { TeamTemplateContent } from '../api/schemas/teams.js';
import type { LoadoutContent } from '../api/schemas/loadouts.js';
import { getOpenteamsBundleStore } from './map-handlers.js';

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
  // need each row through `findResourceById` (or `rowToResource`) so the
  // metadata JSON is parsed before we look up `metadata.content`.
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
        const content = (row.metadata as { content?: LoadoutContent } | null)?.content;
        if (!content) continue;
        const resolved = resolveStandaloneLoadout(content as LoadoutDefinition);
        // `bundleLoadout` returns `LoadoutResource`, a subtype of `MAPResource`.
        // BundleStore.put types its arg as the open generic — the cast bridges
        // TS invariance over `metadata`.
        const bundle = bundleLoadout(resolved, { version: '0.0.0', name: row.name });
        await store.put(bundle as unknown as MAPResource);
        result.loadouts++;
      } else if (row.resource_type === 'team_template') {
        const content = (row.metadata as { content?: TeamTemplateContent } | null)?.content;
        if (!content) continue;
        const bundle = await bundleTeamTemplateContent(row.name, content);
        await store.put(bundle as unknown as MAPResource);
        result.teams++;
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

/**
 * Round-trip a `team_template` `metadata.content` blob through a temp YAML
 * directory and back through `TemplateLoader.load`, then bundle.
 *
 * The temp dir is cleaned up regardless of success. Templates are tiny
 * (typically <100KB serialized), so the disk hop is cheap.
 */
async function bundleTeamTemplateContent(
  templateName: string,
  content: TeamTemplateContent,
) {
  const dir = mkdtempSync(join(tmpdir(), `openteams-seed-${templateName}-`));
  try {
    // team.yaml
    writeFileSync(join(dir, 'team.yaml'), yaml.dump(content.manifest));

    // roles/<name>.yaml
    if (content.roles) {
      const rolesDir = join(dir, 'roles');
      mkdirSync(rolesDir, { recursive: true });
      for (const [name, def] of Object.entries(content.roles)) {
        writeFileSync(join(rolesDir, `${name}.yaml`), yaml.dump(def));
      }
    }

    // loadouts/<name>.yaml — team-embedded loadouts
    if (content.loadouts) {
      const loadoutsDir = join(dir, 'loadouts');
      mkdirSync(loadoutsDir, { recursive: true });
      for (const [name, def] of Object.entries(content.loadouts)) {
        writeFileSync(join(loadoutsDir, `${name}.yaml`), yaml.dump(def));
      }
    }

    // prompts/<role>.md (single-file) — multi-file form not stored verbatim
    // yet (waiting on openteams hydrate-from-object API). For now ROLE.md
    // captures the primary body; SOUL.md/RULES.md surfaces are deferred.
    if (content.prompts) {
      const promptsDir = join(dir, 'prompts');
      mkdirSync(promptsDir, { recursive: true });
      for (const [role, prompts] of Object.entries(content.prompts)) {
        const body = (prompts as { primary?: string } | null)?.primary;
        if (typeof body === 'string') {
          writeFileSync(join(promptsDir, `${role}.md`), body);
        }
      }
    }

    const template = TemplateLoader.load(dir);
    return bundleTeam(template, { version: '0.0.0', name: templateName });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
