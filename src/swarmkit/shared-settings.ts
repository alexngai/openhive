/**
 * Shared settings propagation — manages cross-cutting settings
 * (embedding provider, API keys) that affect multiple SwarmKit packages.
 *
 * When a shared setting changes, this module fans out the update
 * to all affected package config files.
 */

import { deepMerge } from '../config-persistence.js';
import {
  readConfig,
  writeConfig,
  resolveDescriptors,
  findDescriptor,
} from './config-io.js';
import { getNestedValue, expandDotNotation } from './utils.js';
import type {
  SharedSettingStatus,
  SharedSettingTarget,
  PropagationResult,
} from './types.js';

// ─── Propagation targets ────────────────────────────────────────

interface TargetSpec {
  packageName: string;
  configPath: string;
}

interface SharedSettingDef {
  key: string;
  label: string;
  type: 'select' | 'password';
  choices?: Array<{ name: string; value: string }>;
  targets: TargetSpec[];
}

const SHARED_SETTINGS: SharedSettingDef[] = [
  {
    key: 'embeddingProvider',
    label: 'Embedding provider',
    type: 'select',
    choices: [
      { name: 'OpenAI', value: 'openai' },
      { name: 'Gemini', value: 'gemini' },
      { name: 'Local models', value: 'local' },
    ],
    targets: [
      { packageName: 'minimem', configPath: 'embedding.provider' },
    ],
  },
  {
    key: 'embeddingApiKey',
    label: 'Embedding API key',
    type: 'password',
    targets: [
      { packageName: 'minimem', configPath: 'embedding.apiKey' },
    ],
  },
];

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get the current status of all shared settings, including
 * whether each target package is in sync.
 */
export function getSharedSettingsStatus(
  sourceValues: Record<string, unknown>,
  projectRoot: string | null,
  usePrefix: boolean,
): SharedSettingStatus[] {
  return SHARED_SETTINGS.map((def) => {
    const sourceValue = sourceValues[def.key];
    const targets: SharedSettingTarget[] = def.targets.map((target) => {
      const descriptors = resolveDescriptors(target.packageName, projectRoot, usePrefix);
      const desc = findDescriptor(descriptors, 'project') ?? findDescriptor(descriptors, 'global');
      let currentValue: unknown;

      if (desc?.configFile) {
        const config = readConfig(desc);
        currentValue = getNestedValue(config, target.configPath);
      }

      return {
        packageName: target.packageName,
        configPath: target.configPath,
        currentValue,
        inSync: sourceValue !== undefined && currentValue === sourceValue,
      };
    });

    return {
      key: def.key,
      label: def.label,
      type: def.type,
      currentValue: sourceValue,
      choices: def.choices,
      targets,
    };
  });
}

/**
 * Propagate a shared setting to all target packages.
 * Returns which packages were updated.
 */
export function propagateSharedSetting(
  key: string,
  value: unknown,
  projectRoot: string | null,
  usePrefix: boolean,
): PropagationResult[] {
  const def = SHARED_SETTINGS.find((s) => s.key === key);
  if (!def) {
    return [{ packageName: '(unknown)', success: false, message: `Unknown shared setting: ${key}` }];
  }

  return def.targets.map((target) => {
    try {
      const descriptors = resolveDescriptors(target.packageName, projectRoot, usePrefix);
      const desc = findDescriptor(descriptors, 'project') ?? findDescriptor(descriptors, 'global');

      if (!desc?.configFile) {
        return {
          packageName: target.packageName,
          success: false,
          message: 'No config file found',
        };
      }

      const current = readConfig(desc);
      const update = expandDotNotation({ [target.configPath]: value });
      const merged = deepMerge(current, update);
      writeConfig(desc, merged);

      return { packageName: target.packageName, success: true };
    } catch (err) {
      return {
        packageName: target.packageName,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/**
 * Get all shared setting keys.
 */
export function getSharedSettingKeys(): string[] {
  return SHARED_SETTINGS.map((s) => s.key);
}
