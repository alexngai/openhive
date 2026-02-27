/**
 * Resource Discovery Service
 *
 * Scans the filesystem for minimem memory banks and skill-tree skills
 * across three scopes: global, project, and agent.
 *
 * Discovery is on-demand (user-triggered), not automatic.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { listMemoryFiles } from 'minimem/internal';
import { discoverSkills, hasSkilltreeDir } from 'skill-tree';
import * as resourcesDAL from '../db/dal/syncable-resources.js';
import type { ResourceScope, SyncableResourceType } from '../types.js';
import type { Config } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface DiscoveryResult {
  /** Resources that were newly created */
  created: Array<{
    id: string;
    resource_type: SyncableResourceType;
    name: string;
    scope: ResourceScope;
    path: string;
  }>;
  /** Resources that already existed and were updated */
  updated: Array<{
    id: string;
    resource_type: SyncableResourceType;
    name: string;
    scope: ResourceScope;
    path: string;
  }>;
  /** Paths that were scanned but had no resources */
  skipped: Array<{
    path: string;
    reason: string;
  }>;
}

export interface DiscoverOptions {
  /** Agent ID that will own discovered resources */
  ownerAgentId: string;
  /** Scopes to scan (default: all enabled) */
  scopes?: ResourceScope[];
  /** Specific agent working directory (for agent-scope discovery) */
  agentWorkDir?: string;
}

// ============================================================================
// Path Resolution
// ============================================================================

/** Default global minimem path */
function getGlobalMemoryPath(config: Config): string {
  return config.resourceDiscovery.globalMemoryPath || join(homedir(), '.minimem');
}

/** Default global skill-tree paths */
function getGlobalSkillPaths(config: Config): string[] {
  if (config.resourceDiscovery.globalSkillPaths?.length) {
    return config.resourceDiscovery.globalSkillPaths;
  }
  return [
    join(homedir(), '.skill-tree'),
    join(homedir(), '.claude', 'skills'),
  ];
}

/** Project root */
function getProjectRoot(config: Config): string {
  return config.resourceDiscovery.projectRoot || process.cwd();
}

// ============================================================================
// Detection Helpers
// ============================================================================

/** Check if a directory contains a minimem memory bank */
async function hasMemoryBank(dir: string): Promise<boolean> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  try {
    const files = await listMemoryFiles(dir);
    return files.length > 0;
  } catch {
    return false;
  }
}

/** Check if a directory contains skill-tree skills */
async function hasSkills(dir: string): Promise<boolean> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  try {
    // Check for .skilltree/ directory first
    if (await hasSkilltreeDir(dir)) {
      const skills = await discoverSkills(dir);
      return skills.length > 0;
    }
    return false;
  } catch {
    return false;
  }
}

/** Check if a directory has a .claude/skills/ subdirectory with .md files */
function hasClaudeSkills(dir: string): boolean {
  const skillsDir = join(dir, '.claude', 'skills');
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return false;
  // Just check if the directory exists — content will be browsed via the content API
  return true;
}

// ============================================================================
// Core Discovery Logic
// ============================================================================

/** Upsert a discovered resource and track in the result */
function registerDiscovered(
  result: DiscoveryResult,
  input: {
    ownerAgentId: string;
    resourceType: SyncableResourceType;
    name: string;
    description: string;
    path: string;
    scope: ResourceScope;
  }
): void {
  const { resource, created } = resourcesDAL.upsertDiscoveredResource({
    resource_type: input.resourceType,
    name: input.name,
    description: input.description,
    git_remote_url: input.path, // local path as git_remote_url
    visibility: 'private',
    owner_agent_id: input.ownerAgentId,
    scope: input.scope,
  });

  const entry = {
    id: resource.id,
    resource_type: input.resourceType,
    name: input.name,
    scope: input.scope,
    path: input.path,
  };

  if (created) {
    result.created.push(entry);
  } else {
    result.updated.push(entry);
  }
}

/** Scan a directory for memory banks and skills at a given scope */
async function scanDirectory(
  result: DiscoveryResult,
  dir: string,
  scope: ResourceScope,
  ownerAgentId: string,
  namePrefix: string
): Promise<void> {
  const resolvedDir = resolve(dir);

  if (!existsSync(resolvedDir)) {
    result.skipped.push({ path: resolvedDir, reason: 'Path does not exist' });
    return;
  }

  // Check for memory bank
  if (await hasMemoryBank(resolvedDir)) {
    registerDiscovered(result, {
      ownerAgentId,
      resourceType: 'memory_bank',
      name: `${namePrefix}/minimem-memory`,
      description: `Minimem memory bank (${scope} scope) at ${resolvedDir}`,
      path: resolvedDir,
      scope,
    });
  }

  // Check for skill-tree skills
  if (await hasSkills(resolvedDir)) {
    registerDiscovered(result, {
      ownerAgentId,
      resourceType: 'skill',
      name: `${namePrefix}/skilltree`,
      description: `Skill-tree skills (${scope} scope) at ${resolvedDir}`,
      path: resolvedDir,
      scope,
    });
  }

  // Check for .claude/skills/
  if (hasClaudeSkills(resolvedDir)) {
    const claudeSkillsPath = join(resolvedDir, '.claude', 'skills');
    registerDiscovered(result, {
      ownerAgentId,
      resourceType: 'skill',
      name: `${namePrefix}/claude-skills`,
      description: `Claude skills (${scope} scope) at ${claudeSkillsPath}`,
      path: claudeSkillsPath,
      scope,
    });
  }
}

/** Scan global paths (each path is a dedicated resource, not a combined directory) */
async function scanGlobalPaths(
  result: DiscoveryResult,
  config: Config,
  ownerAgentId: string
): Promise<void> {
  // Global memory: ~/.minimem
  const globalMemoryDir = getGlobalMemoryPath(config);
  if (await hasMemoryBank(globalMemoryDir)) {
    registerDiscovered(result, {
      ownerAgentId,
      resourceType: 'memory_bank',
      name: 'global/minimem-memory',
      description: `Global minimem memory bank at ${globalMemoryDir}`,
      path: globalMemoryDir,
      scope: 'global',
    });
  } else {
    result.skipped.push({ path: globalMemoryDir, reason: 'No memory files found' });
  }

  // Global skills: ~/.skill-tree, ~/.claude/skills
  const globalSkillPaths = getGlobalSkillPaths(config);
  for (const skillPath of globalSkillPaths) {
    const resolved = resolve(skillPath);
    if (!existsSync(resolved)) {
      result.skipped.push({ path: resolved, reason: 'Path does not exist' });
      continue;
    }

    // Determine the name suffix based on path
    const pathBase = resolved.includes('.skill-tree') ? 'skilltree' : 'claude-skills';

    if (pathBase === 'skilltree' && await hasSkills(resolved)) {
      registerDiscovered(result, {
        ownerAgentId,
        resourceType: 'skill',
        name: `global/${pathBase}`,
        description: `Global skill-tree skills at ${resolved}`,
        path: resolved,
        scope: 'global',
      });
    } else if (pathBase === 'claude-skills' && existsSync(resolved) && statSync(resolved).isDirectory()) {
      registerDiscovered(result, {
        ownerAgentId,
        resourceType: 'skill',
        name: `global/${pathBase}`,
        description: `Global Claude skills at ${resolved}`,
        path: resolved,
        scope: 'global',
      });
    } else {
      result.skipped.push({ path: resolved, reason: 'No skills found' });
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Discover local filesystem resources and register them in the database.
 * Idempotent — safe to call multiple times.
 */
export async function discoverLocalResources(
  config: Config,
  options: DiscoverOptions
): Promise<DiscoveryResult> {
  const { ownerAgentId, agentWorkDir } = options;
  const scopes = options.scopes || ['global', 'project', 'agent'];

  const result: DiscoveryResult = {
    created: [],
    updated: [],
    skipped: [],
  };

  // Global scope
  if (scopes.includes('global') && config.resourceDiscovery.globalEnabled) {
    await scanGlobalPaths(result, config, ownerAgentId);
  } else if (scopes.includes('global') && !config.resourceDiscovery.globalEnabled) {
    result.skipped.push({ path: '~/', reason: 'Global discovery is disabled in config' });
  }

  // Project scope
  if (scopes.includes('project')) {
    const projectRoot = getProjectRoot(config);
    await scanDirectory(result, projectRoot, 'project', ownerAgentId, 'project');
  }

  // Agent scope
  if (scopes.includes('agent') && agentWorkDir) {
    await scanDirectory(result, agentWorkDir, 'agent', ownerAgentId, 'agent');
  }

  return result;
}
