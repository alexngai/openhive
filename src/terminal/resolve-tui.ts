/**
 * OpenSwarm TUI Binary Resolution
 *
 * Resolves the platform-specific OpenSwarm TUI binary path.
 * Mirrors the logic from openswarm/bin/openswarm.mjs lines 69-98.
 */

import { existsSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Resolve the OpenSwarm TUI binary path for the current platform.
 * Returns the absolute path to the binary, or null if not available.
 */
export function resolveOpenSwarmTuiBinary(): string | null {
  const { platform, arch } = process;
  const packageName = `@openswarm/cli-${platform}-${arch}`;

  // Try 1: resolve from installed npm package (production path)
  try {
    const platformPkgJson = require.resolve(`${packageName}/package.json`);
    const platformPkgDir = dirname(platformPkgJson);
    const binaryPath = join(platformPkgDir, 'openswarm');
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // Package not installed
  }

  // Try 2: check local packages/ directory in openswarm source (development path)
  try {
    const openswarmPkgJson = require.resolve('openswarm/package.json');
    const openswarmPkgDir = dirname(openswarmPkgJson);
    const localPath = join(openswarmPkgDir, 'packages', `cli-${platform}-${arch}`, 'openswarm');
    if (existsSync(localPath)) {
      return localPath;
    }
  } catch {
    // openswarm package not found
  }

  return null;
}
