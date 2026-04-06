/**
 * Registry adapter — bridges SwarmKit's InlineOption/Integration
 * definitions into OpenHive's FieldMeta pattern for the config UI.
 *
 * Imports package and integration definitions directly from swarmkit
 * to stay in sync automatically.
 */

import {
  PACKAGES,
  INTEGRATIONS,
  getActiveIntegrations as swarmkitGetActiveIntegrations,
  getAllPackageNames,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
} from 'swarmkit';
import type {
  PackageDefinition,
  InlineOption,
  Integration,
} from 'swarmkit';
import type {
  PackageCategory,
  PackageFieldMeta,
  PackageMeta,
  SerializedInlineOption,
  IntegrationResponse,
} from './types.js';
import { readConfig, resolveDescriptors, findDescriptor } from './config-io.js';
import { getNestedValue } from './utils.js';

// Re-export for use in frontend category grouping
export { CATEGORY_ORDER, CATEGORY_LABELS };

// ─── Public API ─────────────────────────────────────────────

/**
 * Build metadata for a single package, evaluating conditional options.
 */
export function buildPackageMeta(
  packageName: string,
  installedPackages: string[],
): PackageMeta | null {
  const def = PACKAGES[packageName];
  if (!def) return null;

  const installed = new Set(installedPackages);
  const fields: Record<string, PackageFieldMeta> = {};
  const options: SerializedInlineOption[] = [];

  const inlineOptions = def.setup?.inlineOptions ?? [];

  for (const opt of inlineOptions) {
    // Evaluate `when` conditions — the callback receives the installed package list
    if (opt.when && !opt.when(installedPackages)) {
      continue;
    }

    fields[opt.key] = {
      label: opt.label,
      secret: opt.type === 'password',
    };

    options.push({
      key: opt.key,
      label: opt.label,
      type: opt.type,
      default: opt.default,
      choices: opt.choices,
    });
  }

  // Determine scopes from known patterns
  const scopes = getPackageScopes(packageName);

  return {
    name: def.name,
    description: def.description,
    category: def.category as PackageCategory,
    fields,
    inlineOptions: options,
    scopes,
  };
}

/**
 * Build metadata for all known packages.
 */
export function buildAllPackageMeta(
  installedPackages: string[],
): Record<string, PackageMeta> {
  const result: Record<string, PackageMeta> = {};
  for (const name of getAllPackageNames()) {
    const meta = buildPackageMeta(name, installedPackages);
    if (meta) result[name] = meta;
  }
  return result;
}

/**
 * Get all known package names from the SwarmKit registry.
 */
export function getRegisteredPackageNames(): string[] {
  return getAllPackageNames();
}

/**
 * Build integration metadata with current values read from disk.
 */
export function buildIntegrationsMeta(
  installedPackages: string[],
  projectRoot: string | null,
  usePrefix: boolean,
): IntegrationResponse[] {
  const installed = new Set(installedPackages);
  const results: IntegrationResponse[] = [];

  for (const def of INTEGRATIONS) {
    const [a, b] = def.packages;
    const active = installed.has(a) && installed.has(b);

    const configOptions = (def.configOptions ?? []).map((opt) => {
      let currentValue: unknown;
      if (active) {
        const descriptors = resolveDescriptors(opt.targetPackage, projectRoot, usePrefix);
        const desc = findDescriptor(descriptors, 'project') ?? findDescriptor(descriptors, 'global');
        if (desc && desc.configFile) {
          const config = readConfig(desc);
          currentValue = getNestedValue(config, opt.configPath);
        }
      }
      return {
        key: opt.key,
        label: opt.label,
        type: opt.type,
        default: opt.default,
        choices: opt.choices,
        targetPackage: opt.targetPackage,
        configPath: opt.configPath,
        currentValue,
      };
    });

    results.push({
      id: `${a}--${b}`,
      packages: [a, b],
      description: def.description,
      requiresWiring: def.requiresWiring ?? false,
      active,
      configOptions,
    });
  }

  return results;
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Determine which scopes a package supports.
 * Packages with entries in GLOBAL_CONFIG_DIRS have global scope.
 * Packages with entries in PROJECT_CONFIG_DIRS have project scope.
 */
function getPackageScopes(packageName: string): Array<'global' | 'project'> {
  // These packages have both global and project configs
  const DUAL_SCOPE = new Set(['claude-code-swarm']);
  // These packages are global-only
  const GLOBAL_ONLY = new Set(['skill-tree']);

  if (DUAL_SCOPE.has(packageName)) return ['global', 'project'];
  if (GLOBAL_ONLY.has(packageName)) return ['global'];
  return ['project'];
}
