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
 *   onTeamTemplateRemoved(id)   // DELETE
 *   onLoadoutRemoved(id)        // DELETE
 *
 * These are fire-and-forget — failures are logged but never bubble to the
 * caller. Auto-bundle errors should not break a successful REST mutation.
 *
 * Lifecycle events (`resource.added` / `updated` / `removed`) flow
 * automatically via the kind handlers' `emit` hook, which is wired to the
 * MAPServer event bus in `src/map/map-server-setup.ts`.
 */

import {
  bundleLoadout,
  bundleTeam,
  resolveStandaloneLoadout,
  TemplateLoader,
  LOADOUT_RESOURCE_TYPE,
  TEAM_RESOURCE_TYPE,
} from 'openteams';
import type { LoadoutDefinition, MAPResource } from 'openteams';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { getOpenteamsBundleStore } from './map-handlers.js';
import type { SyncableResource } from '../types.js';
import type { LoadoutContent } from '../api/schemas/loadouts.js';
import type { TeamTemplateContent } from '../api/schemas/teams.js';

// ── Auto-bundle on write ────────────────────────────────────────────────────

/**
 * Bundle a `loadout` row's authored content into the openteams store.
 * Returns the bundle id on success, or null when the row has no content
 * or bundling failed.
 */
export async function onLoadoutBundle(row: SyncableResource): Promise<string | null> {
  try {
    const content = (row.metadata as { content?: LoadoutContent } | null)?.content;
    if (!content) return null;
    const resolved = resolveStandaloneLoadout(content as LoadoutDefinition);
    const bundle = bundleLoadout(resolved, { version: '0.0.0', name: row.name });
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);
    return bundle.id;
  } catch (err) {
    console.warn(
      `[openteams] auto-bundle loadout ${row.id} failed: ${(err as Error).message}`,
    );
    return null;
  }
}

export async function onTeamTemplateBundle(row: SyncableResource): Promise<string | null> {
  try {
    const content = (row.metadata as { content?: TeamTemplateContent } | null)?.content;
    if (!content) return null;
    const bundle = await bundleTeamTemplateContent(row.name, content);
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);
    return bundle.id;
  } catch (err) {
    console.warn(
      `[openteams] auto-bundle team_template ${row.id} failed: ${(err as Error).message}`,
    );
    return null;
  }
}

// ── Auto-remove on unpublish ────────────────────────────────────────────────
// The route handler hands us the row as it existed just before deletion. We
// recompute the bundle hash from that content (deterministic via the
// canonical hash) and remove by id from the store. This avoids the need
// for a row→hash side-map and survives restart (bundle ids are stable).

export async function onLoadoutRemoved(row: SyncableResource): Promise<void> {
  try {
    const content = (row.metadata as { content?: LoadoutContent } | null)?.content;
    if (!content) return;
    const resolved = resolveStandaloneLoadout(content as LoadoutDefinition);
    const bundle = bundleLoadout(resolved, { version: '0.0.0', name: row.name });
    await getOpenteamsBundleStore().delete(LOADOUT_RESOURCE_TYPE, bundle.id);
  } catch (err) {
    console.warn(
      `[openteams] auto-remove loadout ${row.id} failed: ${(err as Error).message}`,
    );
  }
}

export async function onTeamTemplateRemoved(row: SyncableResource): Promise<void> {
  try {
    const content = (row.metadata as { content?: TeamTemplateContent } | null)?.content;
    if (!content) return;
    const bundle = await bundleTeamTemplateContent(row.name, content);
    await getOpenteamsBundleStore().delete(TEAM_RESOURCE_TYPE, bundle.id);
  } catch (err) {
    console.warn(
      `[openteams] auto-remove team_template ${row.id} failed: ${(err as Error).message}`,
    );
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Same temp-dir round-trip the seed function uses. Duplicated here because
 * the seed path imports this module's store accessor too, and pulling the
 * helper into a shared internal would create a cycle worth avoiding for
 * such a small chunk of code.
 */
async function bundleTeamTemplateContent(
  templateName: string,
  content: TeamTemplateContent,
) {
  const dir = mkdtempSync(join(tmpdir(), `openteams-bundle-${templateName}-`));
  try {
    writeFileSync(join(dir, 'team.yaml'), yaml.dump(content.manifest));

    if (content.roles) {
      const rolesDir = join(dir, 'roles');
      mkdirSync(rolesDir, { recursive: true });
      for (const [name, def] of Object.entries(content.roles)) {
        writeFileSync(join(rolesDir, `${name}.yaml`), yaml.dump(def));
      }
    }

    if (content.loadouts) {
      const loadoutsDir = join(dir, 'loadouts');
      mkdirSync(loadoutsDir, { recursive: true });
      for (const [name, def] of Object.entries(content.loadouts)) {
        writeFileSync(join(loadoutsDir, `${name}.yaml`), yaml.dump(def));
      }
    }

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
