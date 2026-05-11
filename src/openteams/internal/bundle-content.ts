/**
 * Shared bundling helpers for `team_template` + `loadout` authored content.
 *
 * The seed pass (`seed.ts`) and the auto-bundle write hooks (`sync-bridge.ts`)
 * both need to turn authored `metadata.content` blobs into content-addressed
 * MAP resources. Previously each call site reimplemented a temp-dir YAML
 * round-trip; this module centralizes both paths via `TemplateLoader.fromObject`
 * (the openteams in-memory hydrate API) so neither caller touches the
 * filesystem.
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
import type { LoadoutContent } from '../../api/schemas/loadouts.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';

/** Bundle a standalone loadout. Returns a content-addressed LoadoutResource. */
export function bundleLoadoutContent(
  name: string,
  content: LoadoutContent,
): LoadoutResource {
  const resolved = resolveStandaloneLoadout(content as LoadoutDefinition);
  return bundleLoadout(resolved, { version: '0.0.0', name });
}

/** Bundle a team template. Hydrates in-memory via `TemplateLoader.fromObject`. */
export function bundleTeamTemplateContent(
  name: string,
  content: TeamTemplateContent,
): TeamResource {
  const template = TemplateLoader.fromObject({
    // openhive's Zod schema is permissive over `topology` / `communication`
    // (passthrough so extension namespaces survive); openteams's loader runs
    // its own strict validation inside `fromObject`. Cast bridges the gap.
    manifest: content.manifest as unknown as TeamManifest,
    roles: content.roles as Record<string, RoleDefinition> | undefined,
    loadouts: content.loadouts as Record<string, LoadoutDefinition> | undefined,
    prompts: content.prompts as Record<string, ResolvedPrompts> | undefined,
  });
  return bundleTeam(template, { version: '0.0.0', name });
}
