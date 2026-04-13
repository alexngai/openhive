/**
 * Format-agnostic config file I/O for SwarmKit packages.
 *
 * Reads and writes JSON and YAML config files at the locations
 * defined by SwarmKit's package layout conventions. Directory
 * tables are imported directly from swarmkit to stay in sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import * as yaml from 'js-yaml';
import {
  PROJECT_CONFIG_DIRS,
  FLAT_PROJECT_CONFIG_DIRS,
  GLOBAL_CONFIG_DIRS,
} from 'swarmkit';
import type { PackageConfigDescriptor, ConfigFormat, PackageScope } from './types.js';

// ─── Package config file mapping ────────────────────────────

interface PackageFileSpec {
  configFile: string;
  format: ConfigFormat;
  /** Sibling file for machine-specific overrides (gitignored). Same format. */
  localFile?: string;
}

const PACKAGE_FILE_SPECS: Record<string, PackageFileSpec> = {
  opentasks:            { configFile: 'config.json',    format: 'json' },
  minimem:              { configFile: 'config.json',    format: 'json' },
  'skill-tree':         { configFile: 'config.yaml',   format: 'yaml' },
  'self-driving-repo':  { configFile: 'config.yml',    format: 'yaml' },
  openteams:            { configFile: 'config.json',    format: 'json' },
  sessionlog:           { configFile: 'settings.json',  format: 'json', localFile: 'settings.local.json' },
  'claude-code-swarm':  { configFile: 'config.json',    format: 'json' },
};

// ─── Config I/O ─────────────────────────────────────────────

/**
 * Read a config file. Returns empty object if missing or invalid.
 */
export function readConfig(descriptor: PackageConfigDescriptor): Record<string, unknown> {
  if (!descriptor.configFile) return {};
  const filePath = path.join(descriptor.configDir, descriptor.configFile);
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');

    if (descriptor.format === 'yaml') {
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    }

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Read the sibling local-override file (e.g. settings.local.json) when defined.
 * Returns {} if the descriptor has no localFile, the file is missing, or it is invalid.
 * Same parse semantics as readConfig (JSON or YAML per descriptor.format).
 */
export function readLocalConfig(descriptor: PackageConfigDescriptor): Record<string, unknown> {
  if (!descriptor.localFile) return {};
  const filePath = path.join(descriptor.configDir, descriptor.localFile);
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');

    if (descriptor.format === 'yaml') {
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    }

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Write a config file (atomic write via tmp + rename).
 */
export function writeConfig(
  descriptor: PackageConfigDescriptor,
  data: Record<string, unknown>,
): void {
  if (!descriptor.configFile) return;
  const filePath = path.join(descriptor.configDir, descriptor.configFile);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = filePath + '.tmp';

  if (descriptor.format === 'yaml') {
    fs.writeFileSync(tmpPath, yaml.dump(data, { indent: 2, lineWidth: 120 }), 'utf-8');
  } else {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  fs.renameSync(tmpPath, filePath);
}

// ─── Descriptor resolution ──────────────────────────────────

/**
 * Resolve config file descriptors for a package.
 * Returns 0–2 descriptors (global and/or project scope).
 */
export function resolveDescriptors(
  packageName: string,
  projectRoot: string | null,
  usePrefix: boolean,
): PackageConfigDescriptor[] {
  const descriptors: PackageConfigDescriptor[] = [];
  const spec = PACKAGE_FILE_SPECS[packageName];

  // Global scope
  const globalRelDir = GLOBAL_CONFIG_DIRS[packageName];
  if (globalRelDir && spec) {
    const configDir = path.join(homedir(), globalRelDir);
    const filePath = path.join(configDir, spec.configFile);
    descriptors.push({
      packageName,
      scope: 'global',
      configDir,
      configFile: spec.configFile,
      format: spec.format,
      exists: fs.existsSync(filePath),
    });
  }

  // Project scope
  if (projectRoot && spec) {
    const projectDirs = usePrefix ? PROJECT_CONFIG_DIRS : FLAT_PROJECT_CONFIG_DIRS;
    const relDir = projectDirs[packageName];
    if (relDir) {
      const configDir = path.join(projectRoot, relDir);
      const filePath = path.join(configDir, spec.configFile);
      descriptors.push({
        packageName,
        scope: 'project',
        configDir,
        configFile: spec.configFile,
        format: spec.format,
        exists: fs.existsSync(filePath),
        localFile: spec.localFile,
      });
    }
  }

  // cognitive-core has no config file, only directories
  if (packageName === 'cognitive-core') {
    if (projectRoot) {
      const projectDirs = usePrefix ? PROJECT_CONFIG_DIRS : FLAT_PROJECT_CONFIG_DIRS;
      const relDir = projectDirs['cognitive-core'];
      if (relDir) {
        const configDir = path.join(projectRoot, relDir);
        descriptors.push({
          packageName,
          scope: 'project',
          configDir,
          configFile: '',
          format: 'json',
          exists: fs.existsSync(configDir),
        });
      }
    }
  }

  return descriptors;
}

/**
 * Find the descriptor for a specific scope, or return null.
 */
export function findDescriptor(
  descriptors: PackageConfigDescriptor[],
  scope: PackageScope,
): PackageConfigDescriptor | null {
  return descriptors.find((d) => d.scope === scope) ?? null;
}

/**
 * Read the SwarmKit global config from ~/.swarmkit/config.json.
 */
export function readSwarmKitGlobalConfig(): Record<string, unknown> {
  const configPath = path.join(homedir(), '.swarmkit', 'config.json');
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Check if SwarmKit is installed (has global config).
 */
export function isSwarmKitInstalled(): boolean {
  return fs.existsSync(path.join(homedir(), '.swarmkit', 'config.json'));
}

/**
 * Get all package names that have known config specs.
 */
export function getKnownPackages(): string[] {
  return Object.keys(PACKAGE_FILE_SPECS);
}

/**
 * Get the project config directory tables (for external use).
 */
export function getProjectConfigDirs(usePrefix: boolean): Record<string, string> {
  return usePrefix ? { ...PROJECT_CONFIG_DIRS } : { ...FLAT_PROJECT_CONFIG_DIRS };
}
