/**
 * Swarm Runner TUI Binary Resolution
 *
 * Resolves the platform-specific Swarm Runner TUI binary path.
 * Mirrors the logic from swarm-runner/bin/swarm-runner.mjs lines 69-98.
 */

import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Resolve the Swarm Runner TUI binary path for the current platform.
 * Returns the absolute path to the binary, or null if not available.
 */
export function resolveSwarmRunnerTuiBinary(): string | null {
  const { platform, arch } = process;
  const packageName = `@swarmkit-ai/swarm-runner-cli-${platform}-${arch}`;

  // Try 1: resolve from installed npm package (production path)
  try {
    const platformPkgJson = require.resolve(`${packageName}/package.json`);
    const platformPkgDir = dirname(platformPkgJson);
    const binaryPath = join(platformPkgDir, 'swarm-runner');
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // Package not installed
  }

  // Try 2: check local packages/ directory in swarm-runner source (development path)
  try {
    const swarmRunnerPkgJson = require.resolve('@swarmkit-ai/swarm-runner/package.json');
    const swarmRunnerPkgDir = dirname(swarmRunnerPkgJson);
    const localPath = join(swarmRunnerPkgDir, 'packages', `cli-${platform}-${arch}`, 'swarm-runner');
    if (existsSync(localPath)) {
      return localPath;
    }
  } catch {
    // @swarmkit-ai/swarm-runner package not found
  }

  return null;
}
