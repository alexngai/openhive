/**
 * OpenHive ↔ openteams resolver.
 *
 * Two public entry points:
 *
 *   resolveTeam(templateId)              → ResolvedTemplate
 *   materializeRoleLoadout(id, role)     → MaterializedLoadout
 *
 * Used by the dispatch prompt builder (hub-side consumption) and by the
 * UI's preview endpoints. Agents (claude-code-swarm) materialize locally
 * via their own openteams + skill-tree clients — see docs/LOADOUTS_DESIGN.md.
 *
 * Implementation notes:
 *   - openteams' TemplateLoader.loadAsync expects a filesystem template
 *     directory. We stage the in-memory team_template content to a tmp dir
 *     before each cache miss; cache hits are served without disk I/O.
 *   - The resolveExternalLoadout hook is wired to OpenHive's loadout DAL,
 *     scoped to the template owner's namespace.
 *   - For Milestone A we keep openteams' default behavior on missing extends
 *     (it throws). Surfacing unresolvedExtends without throwing lands in a
 *     follow-up alongside the openteams 0.4 schema/loader update.
 */

import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { TemplateLoader } from 'openteams';
import { getTeamTemplate, getTeamTemplateContent } from '../db/dal/team-templates.js';
import { getLoadout, getLoadoutByName, getLoadoutContent } from '../db/dal/loadouts.js';
import { canAccessResource } from '../db/dal/syncable-resources.js';
import { hashContent, resolveCachedOrCompute } from './cache.js';
import { compileSkillsForLoadout } from './skill-bridge.js';
import { resolveMcpRefs } from './mcp-bridge.js';
import type { ResolvedLoadout } from 'openteams';
import {
  emptyMaterialization,
  type MaterializedLoadout,
  type ResolvedTemplate,
} from './types.js';
import type { TeamTemplateContent } from '../api/schemas/teams.js';

export class TemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`team_template ${templateId} not found`);
    this.name = 'TemplateNotFoundError';
  }
}

export class RoleNotFoundError extends Error {
  constructor(templateId: string, roleName: string) {
    super(`role '${roleName}' not found in team_template ${templateId}`);
    this.name = 'RoleNotFoundError';
  }
}

export class LoadoutNotFoundError extends Error {
  constructor(loadoutId: string) {
    super(`loadout ${loadoutId} not found`);
    this.name = 'LoadoutNotFoundError';
  }
}

export class MaterializationForbiddenError extends Error {
  constructor(resourceId: string, viewerAgentId: string) {
    super(`unauthorized: viewer ${viewerAgentId} cannot access resource ${resourceId}`);
    this.name = 'MaterializationForbiddenError';
  }
}

/**
 * Read the OpenHive skill-bank binding from a ResolvedLoadout.
 *
 * Lives outside openteams' core abstraction by design — openteams stays
 * neutral about runtime/storage concerns. Convention:
 *
 *   loadout.openhive.skillBankRef          (from authored YAML)
 *
 * Falls back to team_template.metadata.defaultSkillBankRef when unset
 * (the team-level default, owned by OpenHive's resource model).
 */
function readSkillBankRef(
  loadout: ResolvedLoadout,
  defaultRef?: string,
): string | null {
  const ext = (loadout.raw as { openhive?: { skillBankRef?: unknown } } | undefined)
    ?.openhive;
  const fromExt = typeof ext?.skillBankRef === 'string' ? ext.skillBankRef : null;
  return fromExt ?? defaultRef ?? null;
}

/**
 * Resolve a team_template into a ResolvedTemplate (manifest + roles +
 * loadouts + prompts), with hub-backed external loadout resolution.
 *
 * Cached by (templateId, contentHash). Edits to the team_template's content
 * produce a new contentHash and naturally bypass the cache.
 */
export async function resolveTeam(templateId: string): Promise<ResolvedTemplate> {
  const tmpl = getTeamTemplate(templateId);
  if (!tmpl) throw new TemplateNotFoundError(templateId);

  const content = getTeamTemplateContent(tmpl);
  if (!content) {
    throw new Error(`team_template ${templateId} has no content`);
  }

  const ownerId = tmpl.owner_agent_id;
  const contentHash = hashContent(content);

  return resolveCachedOrCompute(templateId, contentHash, async () => {
    const stagingDir = await stageTemplate(content);
    try {
      return await TemplateLoader.loadAsync(stagingDir, {
        resolveExternalLoadout: async (name) => {
          const ldt = getLoadoutByName(name, ownerId);
          if (!ldt) return null;
          const ldtContent = getLoadoutContent(ldt);
          if (!ldtContent) return null;
          // openteams expects a ResolvedLoadout shape; we only have the
          // authored LoadoutDefinition. Stage it through openteams'
          // standalone resolver via a tiny in-memory dir cycle.
          return resolveStandaloneAuthoredLoadout(ldtContent);
        },
      });
    } finally {
      // Best-effort tmp dir cleanup. Cache miss is rare and stagingDir is
      // small; leaving an orphan in /tmp is non-fatal.
      rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/**
 * Materialize a standalone loadout resource (resource_type='loadout') into
 * the same MaterializedLoadout shape produced by team_template + role
 * resolution. Bypasses team-level resolution; useful when a spec carries
 * loadout_ref directly or when the UI is previewing a saved loadout in
 * isolation.
 *
 * `extends` chains are resolved through the same hub-stored loadouts
 * namespace as team_template resolution (scoped to the loadout's owner).
 */
export async function materializeLoadoutById(
  loadoutId: string,
  viewerAgentId?: string,
): Promise<MaterializedLoadout> {
  const ldt = getLoadout(loadoutId);
  if (!ldt) throw new LoadoutNotFoundError(loadoutId);
  if (viewerAgentId !== undefined && !canAccessResource(viewerAgentId, ldt)) {
    throw new MaterializationForbiddenError(loadoutId, viewerAgentId);
  }
  const content = getLoadoutContent(ldt);
  if (!content) {
    throw new Error(`loadout ${loadoutId} has no content`);
  }

  const ownerId = ldt.owner_agent_id;
  // Stage as a single-loadout team and pull the resolved loadout out — same
  // approach resolveStandaloneAuthoredLoadout uses for `extends:` resolution.
  // We don't reuse the resolveTeam cache because the staging shape is
  // synthetic; the cost is small and isolated to UI/dispatch use.
  const stagingDir = await mkdtemp(path.join(tmpdir(), 'openhive-ldt-'));
  let resolvedLdt: import('openteams').ResolvedLoadout | null = null;
  try {
    const ldtName = content.name ?? '__hub_loadout__';
    const manifest = {
      name: '__hub_resolve__',
      version: 1,
      roles: ['stub'],
      topology: { root: { role: 'stub' } },
    };
    await writeFile(
      path.join(stagingDir, 'team.yaml'),
      yaml.dump(manifest),
      'utf-8',
    );
    await mkdir(path.join(stagingDir, 'loadouts'), { recursive: true });
    await writeFile(
      path.join(stagingDir, 'loadouts', `${ldtName}.yaml`),
      yaml.dump(content),
      'utf-8',
    );

    const resolved = await TemplateLoader.loadAsync(stagingDir, {
      resolveExternalLoadout: async (name) => {
        const found = getLoadoutByName(name, ownerId);
        if (!found) return null;
        const fc = getLoadoutContent(found);
        if (!fc) return null;
        return resolveStandaloneAuthoredLoadout(fc);
      },
    });
    resolvedLdt = resolved.loadouts.get(ldtName) ?? null;
  } finally {
    rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!resolvedLdt) return emptyMaterialization();

  const skillBankRef = readSkillBankRef(resolvedLdt);
  const [skills, mcp] = await Promise.all([
    compileSkillsForLoadout(resolvedLdt.skills, {
      ownerContextId: loadoutId,
      skillBankRef,
    }),
    Promise.resolve(
      resolveMcpRefs(resolvedLdt.mcpScope ?? [], resolvedLdt.mcpServers ?? []),
    ),
  ]);

  return {
    capabilities: [...(resolvedLdt.capabilities ?? [])],
    mcpScope: mcp.scope,
    mcpProviders: mcp.providers,
    permissions: {
      allow: [...(resolvedLdt.permissions?.allow ?? [])],
      deny: [...(resolvedLdt.permissions?.deny ?? [])],
      ask: [...(resolvedLdt.permissions?.ask ?? [])],
    },
    promptAddendum: resolvedLdt.promptAddendum ?? '',
    skills,
    unresolvedRefs: mcp.unresolvedRefs,
    materializedAt: new Date().toISOString(),
  };
}

/**
 * Materialize a single role's loadout into the consumer-ready shape.
 * Combines openteams resolution with skill-tree compilation + MCP ref
 * resolution.
 */
export async function materializeRoleLoadout(
  templateId: string,
  roleName: string,
  viewerAgentId?: string,
): Promise<MaterializedLoadout> {
  if (viewerAgentId !== undefined) {
    const tmpl = getTeamTemplate(templateId);
    if (!tmpl) throw new TemplateNotFoundError(templateId);
    if (!canAccessResource(viewerAgentId, tmpl)) {
      throw new MaterializationForbiddenError(templateId, viewerAgentId);
    }
  }
  const resolved = await resolveTeam(templateId);
  const role = resolved.roles.get(roleName);
  if (!role) throw new RoleNotFoundError(templateId, roleName);
  if (!role.loadout) return emptyMaterialization();

  const tmpl = getTeamTemplate(templateId);
  const defaultSkillBankRef =
    (tmpl?.metadata as { defaultSkillBankRef?: string } | null)?.defaultSkillBankRef;
  const skillBankRef = readSkillBankRef(role.loadout, defaultSkillBankRef);

  const [skills, mcp] = await Promise.all([
    compileSkillsForLoadout(role.loadout.skills, {
      ownerContextId: templateId,
      skillBankRef,
    }),
    Promise.resolve(
      resolveMcpRefs(role.loadout.mcpScope ?? [], role.loadout.mcpServers ?? []),
    ),
  ]);

  return {
    capabilities: [...(role.loadout.capabilities ?? [])],
    mcpScope: mcp.scope,
    mcpProviders: mcp.providers,
    permissions: {
      allow: [...(role.loadout.permissions?.allow ?? [])],
      deny: [...(role.loadout.permissions?.deny ?? [])],
      ask: [...(role.loadout.permissions?.ask ?? [])],
    },
    promptAddendum: role.loadout.promptAddendum ?? '',
    skills,
    unresolvedRefs: mcp.unresolvedRefs,
    materializedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Internals — staging in-memory content into a directory openteams can read
// ============================================================================

export async function stageTemplate(content: TeamTemplateContent): Promise<string> {
  const stagingDir = await mkdtemp(path.join(tmpdir(), 'openhive-team-'));

  // team.yaml
  await writeFile(
    path.join(stagingDir, 'team.yaml'),
    yaml.dump(content.manifest),
    'utf-8',
  );

  // roles/<name>.yaml
  if (content.roles && Object.keys(content.roles).length > 0) {
    const rolesDir = path.join(stagingDir, 'roles');
    await mkdir(rolesDir, { recursive: true });
    for (const [name, def] of Object.entries(content.roles)) {
      await writeFile(path.join(rolesDir, `${name}.yaml`), yaml.dump(def), 'utf-8');
    }
  }

  // loadouts/<name>.yaml
  if (content.loadouts && Object.keys(content.loadouts).length > 0) {
    const loadoutsDir = path.join(stagingDir, 'loadouts');
    await mkdir(loadoutsDir, { recursive: true });
    for (const [name, def] of Object.entries(content.loadouts)) {
      await writeFile(path.join(loadoutsDir, `${name}.yaml`), yaml.dump(def), 'utf-8');
    }
  }

  // prompts/<role>.md
  if (content.prompts && Object.keys(content.prompts).length > 0) {
    const promptsDir = path.join(stagingDir, 'prompts');
    await mkdir(promptsDir, { recursive: true });
    for (const [roleName, body] of Object.entries(content.prompts)) {
      await writeFile(path.join(promptsDir, `${roleName}.md`), body, 'utf-8');
    }
  }

  return stagingDir;
}

/**
 * Resolve a single authored LoadoutDefinition from a hub-stored loadout
 * resource into a ResolvedLoadout.
 *
 * openteams doesn't expose `resolveStandaloneLoadout` for our type either —
 * we stage a single-loadout template-shaped tmp dir. This is rare (only
 * triggered for `extends:` chains pointing at hub-side loadouts) so the
 * disk I/O is acceptable for v1.
 */
async function resolveStandaloneAuthoredLoadout(
  authored: unknown,
): Promise<import('openteams').ResolvedLoadout | null> {
  const stagingDir = await mkdtemp(path.join(tmpdir(), 'openhive-ldt-'));
  try {
    // Minimal viable team — single role with this loadout inline so openteams
    // walks the merge path and produces a ResolvedLoadout.
    const ldtName = (authored as { name?: string })?.name ?? '__hub_loadout__';
    const manifest = {
      name: '__hub_resolve__',
      version: 1,
      roles: ['stub'],
      topology: { root: { role: 'stub' } },
    };
    await writeFile(
      path.join(stagingDir, 'team.yaml'),
      yaml.dump(manifest),
      'utf-8',
    );
    await mkdir(path.join(stagingDir, 'loadouts'), { recursive: true });
    await writeFile(
      path.join(stagingDir, 'loadouts', `${ldtName}.yaml`),
      yaml.dump(authored),
      'utf-8',
    );

    const resolved = await TemplateLoader.loadAsync(stagingDir);
    return resolved.loadouts.get(ldtName) ?? null;
  } catch {
    return null;
  } finally {
    rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
