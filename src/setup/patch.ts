/**
 * Config-file patching for setup sections — same write path as
 * `PATCH /admin/config` (deepMerge over the raw file, atomic write).
 */

import { readConfigFile, writeConfigFile, deepMerge } from '../config-persistence.js';
import type { SetupContext } from './types.js';

export function patchConfig(
  ctx: SetupContext,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const current = readConfigFile(ctx.configPath);
  const merged = deepMerge(current, patch);
  writeConfigFile(ctx.configPath, merged);
  ctx.rawConfig = merged;
  return merged;
}
