/**
 * Config persistence — reads/writes the JSON config file directly.
 *
 * OpenHive uses JSON as its primary config format. JS configs are
 * still readable for backwards compatibility but cannot be written
 * to by the UI. The PATCH endpoint writes directly to the JSON
 * config file, making it the single source of truth.
 *
 * Env var overrides (OPENHIVE_*, SWARMHUB_*, etc.) always take
 * precedence over file values at load time.
 */

import * as fs from 'fs';

/**
 * Read a JSON config file. Returns empty object if absent or invalid.
 */
export function readConfigFile(filePath: string): Record<string, unknown> {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {
    // Corrupt or unreadable — treat as empty
  }
  return {};
}

/**
 * Write config to a JSON file (atomic write via tmp + rename).
 */
export function writeConfigFile(filePath: string, config: Record<string, unknown>): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Deep merge source into target. Returns a new object.
 * - Objects are recursively merged
 * - Arrays are replaced (not concatenated)
 * - null values remove the key
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (srcVal === null || srcVal === undefined) {
      delete result[key];
    } else if (
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal) &&
      tgtVal !== null
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }

  return result;
}
