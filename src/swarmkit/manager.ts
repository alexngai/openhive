/**
 * SwarmKit config manager — central orchestrator for reading and
 * writing SwarmKit package configs through OpenHive.
 *
 * Every read goes to the actual file on disk. Every write goes back
 * to the same file. OpenHive never caches config data.
 */

import * as fs from 'fs';
import * as path from 'path';
import { deepMerge } from '../config-persistence.js';
import { expandDotNotation } from './utils.js';
import {
  readConfig,
  readLocalConfig,
  writeConfig,
  resolveDescriptors,
  findDescriptor,
  readSwarmKitGlobalConfig,
  isSwarmKitInstalled,
} from './config-io.js';
import {
  buildPackageMeta,
  buildIntegrationsMeta,
  getRegisteredPackageNames,
} from './registry-adapter.js';
import { ProjectRegistry } from './project-registry.js';
import {
  scaffoldProjectPackage,
  scaffoldGlobalPackage,
  isPackageInitialized,
  type ScaffoldOptions,
  type ScaffoldResult,
} from './scaffolding.js';
import {
  getSharedSettingsStatus,
  propagateSharedSetting,
} from './shared-settings.js';
import type {
  SwarmKitState,
  SwarmKitGlobalConfig,
  PackageConfigResponse,
  PackageScope,
  IntegrationResponse,
  DoctorCheckResult,
  SharedSettingStatus,
  PropagationResult,
} from './types.js';

export class SwarmKitConfigManager {
  private projectRegistry: ProjectRegistry;

  constructor(dataDir: string) {
    this.projectRegistry = new ProjectRegistry(dataDir);
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /** Called on server startup to auto-register CWD if applicable. */
  initialize(): void {
    this.projectRegistry.autoRegisterCwd();
  }

  // ─── State ──────────────────────────────────────────────────

  /** Read global config once. Use within a single request handler to avoid repeated disk reads. */
  private readGlobal(): SwarmKitGlobalConfig {
    return readSwarmKitGlobalConfig() as SwarmKitGlobalConfig;
  }

  getState(): SwarmKitState {
    const gc = this.readGlobal();
    return {
      installed: isSwarmKitInstalled(),
      installedPackages: gc.installedPackages ?? [],
      embeddingProvider: gc.embeddingProvider ?? null,
      usePrefix: gc.usePrefix ?? true,
      projectRoots: this.projectRegistry.list(),
    };
  }

  getInstalledPackages(): string[] {
    return this.readGlobal().installedPackages ?? [];
  }

  getUsePrefix(): boolean {
    return this.readGlobal().usePrefix ?? true;
  }

  // ─── Project roots ──────────────────────────────────────────

  getProjectRoots(): string[] {
    return this.projectRegistry.list();
  }

  addProjectRoot(projectRoot: string): void {
    this.projectRegistry.add(projectRoot);
  }

  removeProjectRoot(projectRoot: string): void {
    this.projectRegistry.remove(projectRoot);
  }

  // ─── Package initialization ─────────────────────────────────

  /**
   * Initialize a package in a project directory, creating all
   * config files and scaffolding from scratch.
   * Safe to call on already-initialized packages (skips existing files).
   */
  initPackage(
    packageName: string,
    projectRoot: string | null,
    scope: PackageScope,
    overrides?: Record<string, unknown>,
  ): ScaffoldResult {
    const gc = this.readGlobal();
    const opts: ScaffoldOptions = {
      embeddingProvider: (gc.embeddingProvider as ScaffoldOptions['embeddingProvider']) ?? null,
      usePrefix: gc.usePrefix ?? true,
      overrides,
    };

    if (scope === 'project') {
      if (!projectRoot) {
        return { packageName, success: false, message: 'projectRoot is required for project scope' };
      }
      return scaffoldProjectPackage(packageName, projectRoot, opts);
    }

    return scaffoldGlobalPackage(packageName, opts);
  }

  /**
   * Initialize all installed packages in a project.
   * Respects init order (opentasks → minimem → cognitive-core → ...).
   */
  initAllPackages(
    projectRoot: string,
    overrides?: Record<string, Record<string, unknown>>,
  ): ScaffoldResult[] {
    const gc = this.readGlobal();
    const installed = gc.installedPackages ?? [];
    const usePrefix = gc.usePrefix ?? true;

    // Init order matters: minimem before cognitive-core, opentasks first
    const INIT_ORDER = [
      'opentasks',
      'minimem',
      'cognitive-core',
      'skill-tree',
      'self-driving-repo',
      'openteams',
      'sessionlog',
      'claude-code-swarm',
    ];

    const results: ScaffoldResult[] = [];
    for (const pkg of INIT_ORDER) {
      if (!installed.includes(pkg)) continue;

      const opts: ScaffoldOptions = {
        embeddingProvider: (gc.embeddingProvider as ScaffoldOptions['embeddingProvider']) ?? null,
        usePrefix,
        overrides: overrides?.[pkg],
      };

      results.push(scaffoldProjectPackage(pkg, projectRoot, opts));
    }

    return results;
  }

  /**
   * Check which packages are initialized in a project.
   */
  getInitStatus(projectRoot: string): Record<string, boolean> {
    const gc = this.readGlobal();
    const usePrefix = gc.usePrefix ?? true;
    const status: Record<string, boolean> = {};

    for (const pkg of getRegisteredPackageNames()) {
      status[pkg] = isPackageInitialized(pkg, projectRoot, usePrefix);
    }

    return status;
  }

  // ─── Per-package config ─────────────────────────────────────

  /**
   * Get the config for a single package.
   * When projectRoot is provided, merges global + project (project wins).
   * When scope is specified, returns only that scope.
   */
  getPackageConfig(
    packageName: string,
    projectRoot: string | null,
    scope?: PackageScope,
    /** Pre-read global config to avoid repeated disk reads in batch operations. */
    _gc?: SwarmKitGlobalConfig,
  ): PackageConfigResponse | null {
    const gc = _gc ?? this.readGlobal();
    const installedPackages = gc.installedPackages ?? [];
    const usePrefix = gc.usePrefix ?? true;
    const meta = buildPackageMeta(packageName, installedPackages);
    if (!meta) return null;

    const descriptors = resolveDescriptors(packageName, projectRoot, usePrefix);
    const installed = installedPackages.includes(packageName);

    // Determine which scope to serve
    if (scope) {
      const desc = findDescriptor(descriptors, scope);
      let config: Record<string, unknown> = desc?.configFile ? readConfig(desc) : {};
      let localConfig: Record<string, unknown> | undefined;
      // Layer machine-specific local overrides on top of project-scope config
      if (desc?.localFile && scope === 'project') {
        const raw = readLocalConfig(desc);
        if (Object.keys(raw).length > 0) {
          localConfig = raw;
          config = deepMerge(config, raw);
        }
      }
      return {
        packageName,
        scope,
        category: meta.category,
        description: meta.description,
        config,
        ...(localConfig ? { localConfig } : {}),
        meta,
        installed,
        configPath: desc ? `${desc.configDir}/${desc.configFile}` : null,
      };
    }

    // Default: merge global + project
    const globalDesc = findDescriptor(descriptors, 'global');
    const projectDesc = findDescriptor(descriptors, 'project');

    let config: Record<string, unknown> = {};
    let configPath: string | null = null;
    let effectiveScope: PackageScope = 'project';
    let localConfig: Record<string, unknown> | undefined;

    if (globalDesc?.configFile) {
      config = readConfig(globalDesc);
      configPath = `${globalDesc.configDir}/${globalDesc.configFile}`;
      effectiveScope = 'global';
    }
    if (projectDesc?.configFile) {
      const projectConfig = readConfig(projectDesc);
      config = deepMerge(config, projectConfig);
      configPath = `${projectDesc.configDir}/${projectDesc.configFile}`;
      effectiveScope = 'project';
    }
    // Machine-specific overrides win over everything
    if (projectDesc?.localFile) {
      const raw = readLocalConfig(projectDesc);
      if (Object.keys(raw).length > 0) {
        localConfig = raw;
        config = deepMerge(config, raw);
      }
    }

    return {
      packageName,
      scope: effectiveScope,
      category: meta.category,
      description: meta.description,
      config,
      ...(localConfig ? { localConfig } : {}),
      meta,
      installed,
      configPath,
    };
  }

  /**
   * Get configs for all known packages.
   */
  getAllPackageConfigs(projectRoot: string | null): PackageConfigResponse[] {
    const gc = this.readGlobal();
    const results: PackageConfigResponse[] = [];
    for (const name of getRegisteredPackageNames()) {
      const config = this.getPackageConfig(name, projectRoot, undefined, gc);
      if (config) results.push(config);
    }
    return results;
  }

  /**
   * Update a package's config. Writes to the specific scope's file.
   *
   * When `localUpdates` is provided and the descriptor has a `localFile`
   * (e.g. sessionlog's settings.local.json), those keys are written to the
   * local file instead of the main config file. The caller decides the
   * routing; the manager just obeys.
   */
  updatePackageConfig(
    packageName: string,
    projectRoot: string | null,
    scope: PackageScope,
    updates: Record<string, unknown>,
    localUpdates?: Record<string, unknown>,
  ): { success: boolean; message?: string } {
    const usePrefix = this.getUsePrefix();
    const descriptors = resolveDescriptors(packageName, projectRoot, usePrefix);
    const desc = findDescriptor(descriptors, scope);

    if (!desc) {
      return { success: false, message: `No ${scope} config found for ${packageName}` };
    }
    if (!desc.configFile) {
      return { success: false, message: `${packageName} has no config file (directory-only package)` };
    }

    // Main-file updates
    if (Object.keys(updates).length > 0) {
      const current = readConfig(desc);
      const merged = deepMerge(current, expandDotNotation(updates));
      writeConfig(desc, merged);
    }

    // Local-file updates (machine-specific overrides)
    if (localUpdates && Object.keys(localUpdates).length > 0) {
      if (!desc.localFile) {
        return {
          success: false,
          message: `${packageName} does not support local-file overrides`,
        };
      }
      const localDesc = { ...desc, configFile: desc.localFile };
      const currentLocal = readConfig(localDesc);
      const mergedLocal = deepMerge(currentLocal, expandDotNotation(localUpdates));
      writeConfig(localDesc, mergedLocal);
    }

    return { success: true };
  }

  // ─── Shared settings ─────────────────────────────────────────

  getSharedSettings(projectRoot: string | null): SharedSettingStatus[] {
    const globalConfig = readSwarmKitGlobalConfig() as SwarmKitGlobalConfig;
    const usePrefix = this.getUsePrefix();
    const sourceValues: Record<string, unknown> = {
      embeddingProvider: globalConfig.embeddingProvider ?? null,
    };
    return getSharedSettingsStatus(sourceValues, projectRoot, usePrefix);
  }

  updateSharedSetting(
    key: string,
    value: unknown,
    projectRoot: string | null,
  ): PropagationResult[] {
    const usePrefix = this.getUsePrefix();
    return propagateSharedSetting(key, value, projectRoot, usePrefix);
  }

  // ─── Integrations ───────────────────────────────────────────

  getIntegrations(projectRoot: string | null): IntegrationResponse[] {
    const installedPackages = this.getInstalledPackages();
    const usePrefix = this.getUsePrefix();
    return buildIntegrationsMeta(installedPackages, projectRoot, usePrefix);
  }

  /**
   * Update an integration's config options.
   * Each option targets a specific package + config path.
   */
  updateIntegration(
    _integrationId: string,
    updates: Record<string, unknown>,
    projectRoot: string | null,
  ): { success: boolean; message?: string; skipped?: string[] } {
    const gc = this.readGlobal();
    const installedPackages = gc.installedPackages ?? [];
    const usePrefix = gc.usePrefix ?? true;
    const integrations = buildIntegrationsMeta(installedPackages, projectRoot, usePrefix);
    const integration = integrations.find((i) => i.id === _integrationId);

    if (!integration) {
      return { success: false, message: `Integration not found: ${_integrationId}` };
    }

    const skipped: string[] = [];

    for (const opt of integration.configOptions) {
      if (!(opt.key in updates)) continue;

      const descriptors = resolveDescriptors(opt.targetPackage, projectRoot, usePrefix);
      const desc = findDescriptor(descriptors, 'project') ?? findDescriptor(descriptors, 'global');
      if (!desc?.configFile) {
        skipped.push(`${opt.targetPackage}: no config file found`);
        continue;
      }

      const current = readConfig(desc);
      const expanded = expandDotNotation({ [opt.configPath]: updates[opt.key] });
      const merged = deepMerge(current, expanded);
      writeConfig(desc, merged);
    }

    return {
      success: true,
      ...(skipped.length > 0 && { message: `Some writes skipped`, skipped }),
    };
  }

  // ─── Doctor ─────────────────────────────────────────────────

  runDoctor(projectRoot: string | null): DoctorCheckResult[] {
    const results: DoctorCheckResult[] = [];
    const state = this.getState();

    // Check SwarmKit installation
    if (!state.installed) {
      results.push({
        name: 'swarmkit-installed',
        status: 'fail',
        message: 'SwarmKit global config not found at ~/.swarmkit/config.json',
        fix: 'npm install -g swarmkit && swarmkit init',
      });
      return results;
    }

    results.push({
      name: 'swarmkit-installed',
      status: 'pass',
      message: `SwarmKit installed with ${state.installedPackages.length} package(s)`,
    });

    // Check each installed package
    const usePrefix = this.getUsePrefix();
    for (const pkg of state.installedPackages) {
      const descriptors = resolveDescriptors(pkg, projectRoot, usePrefix);

      if (descriptors.length === 0) {
        results.push({
          name: `${pkg}-config`,
          status: 'warn',
          message: `${pkg} is installed but has no known config location`,
        });
        continue;
      }

      const hasConfig = descriptors.some((d) => d.exists);
      if (!hasConfig) {
        results.push({
          name: `${pkg}-config`,
          status: 'warn',
          message: `${pkg} config not found (expected at ${descriptors.map((d) => `${d.configDir}/${d.configFile}`).join(' or ')})`,
          fix: projectRoot
            ? `cd "${projectRoot}" && swarmkit configure ${pkg}`
            : `swarmkit configure ${pkg}`,
        });
      } else {
        results.push({
          name: `${pkg}-config`,
          status: 'pass',
          message: `${pkg} config found`,
        });
      }
    }

    // Check embedding provider
    if (!state.embeddingProvider) {
      results.push({
        name: 'embedding-provider',
        status: 'warn',
        message: 'No embedding provider configured — vector search will be unavailable',
        fix: 'swarmkit configure',
      });
    } else {
      results.push({
        name: 'embedding-provider',
        status: 'pass',
        message: `Embedding provider: ${state.embeddingProvider}`,
      });
    }

    // Check project root
    if (projectRoot) {
      const hasSwarmDir = fs.existsSync(
        path.join(projectRoot, '.swarm'),
      );
      results.push({
        name: 'project-root',
        status: hasSwarmDir ? 'pass' : 'warn',
        message: hasSwarmDir
          ? `Project root has .swarm/ directory`
          : `No .swarm/ directory found in ${projectRoot}`,
        fix: hasSwarmDir ? undefined : `cd "${projectRoot}" && swarmkit init`,
      });
    }

    return results;
  }
}
