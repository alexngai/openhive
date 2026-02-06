/**
 * Resolves the OpenHive data directory.
 *
 * Priority:
 *   1. Explicit path passed via --data-dir CLI flag
 *   2. OPENHIVE_HOME environment variable
 *   3. .openhive/ in the current working directory (if it exists or if init was run here)
 *   4. ~/.openhive/ (global default)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/** Sentinel file written inside every data dir so we can detect it later. */
const MARKER_FILE = '.openhive-root';

/**
 * Resolve the data directory for this OpenHive instance.
 *
 * @param explicit  Value passed via --data-dir (highest priority)
 */
export function resolveDataDir(explicit?: string): string {
  // 1. Explicit flag
  if (explicit) {
    return path.resolve(explicit);
  }

  // 2. OPENHIVE_HOME env var
  if (process.env.OPENHIVE_HOME) {
    return path.resolve(process.env.OPENHIVE_HOME);
  }

  // 3. .openhive/ in CWD (if marker exists — means user ran init here)
  const localDir = path.join(process.cwd(), '.openhive');
  if (fs.existsSync(path.join(localDir, MARKER_FILE))) {
    return localDir;
  }

  // 4. Global default: ~/.openhive/
  return path.join(os.homedir(), '.openhive');
}

/**
 * Ensure the data directory structure exists and write the marker file.
 */
export function ensureDataDir(dataDir: string): void {
  const dirs = [
    dataDir,
    path.join(dataDir, 'data'),
    path.join(dataDir, 'uploads'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Write marker so we can detect this dir later
  const markerPath = path.join(dataDir, MARKER_FILE);
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, `Created by OpenHive at ${new Date().toISOString()}\n`);
  }
}

/**
 * Return conventional paths inside a data directory.
 */
export function dataDirPaths(dataDir: string) {
  return {
    root: dataDir,
    database: path.join(dataDir, 'data', 'openhive.db'),
    uploads: path.join(dataDir, 'uploads'),
    config: path.join(dataDir, 'config.js'),
    configJson: path.join(dataDir, 'config.json'),
  };
}

/**
 * Check whether a data directory has been initialised (marker exists).
 */
export function isInitialised(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, MARKER_FILE));
}

/**
 * Find the config file, checking CWD first, then the data directory.
 */
export function findConfigFile(dataDir: string): string | undefined {
  const candidates = [
    path.join(process.cwd(), 'openhive.config.js'),
    path.join(process.cwd(), 'openhive.config.json'),
    path.join(dataDir, 'config.js'),
    path.join(dataDir, 'config.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
