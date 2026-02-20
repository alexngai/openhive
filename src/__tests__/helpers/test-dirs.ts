/**
 * Shared test utilities for filesystem isolation.
 *
 * All tests should use these helpers to create temp directories instead of
 * writing to `./test-data/` or other paths inside the project root.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Create a unique temp root for a test file, scoped by name and PID.
 * Call `cleanTestRoot(root)` in `afterAll` to remove it.
 */
export function testRoot(name: string): string {
  return path.join(os.tmpdir(), `openhive-test-${name}-${process.pid}`);
}

/**
 * Create a sub-directory inside a test root.
 */
export function mkTestDir(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Recursively remove a test directory if it exists.
 */
export function cleanTestRoot(root: string): void {
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Return a DB path inside a test root, ensuring the parent directory exists.
 */
export function testDbPath(root: string, filename: string): string {
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, filename);
}
