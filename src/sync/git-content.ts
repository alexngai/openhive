/**
 * Git Content Manager
 *
 * Shared git operations layer for sync providers that need git access.
 * Handles clone, fetch, freshness checks, and graph path resolution.
 *
 * Uses child_process.execFile for git commands — same approach as src/utils/git-remote.ts.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SyncableResource } from '../types.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT = 30_000; // 30 seconds default

export interface FreshnessResult {
  stale: boolean;
  remoteHead: string | null;
  localHead: string | null;
}

export interface FetchResult {
  previousHead: string | null;
  newHead: string;
  changed: boolean;
}

/**
 * Get the clone directory for a resource under the managed data directory.
 * Layout: {dataDir}/{resource_id}/
 */
export function getClonePath(dataDir: string, resourceId: string): string {
  return resolve(dataDir, resourceId);
}

/**
 * Check if a local clone exists for a resource.
 */
export function hasLocalClone(dataDir: string, resourceId: string): boolean {
  const clonePath = getClonePath(dataDir, resourceId);
  return existsSync(join(clonePath, '.git'));
}

/**
 * Get the current HEAD commit hash of a local clone.
 * Returns null if the clone doesn't exist.
 */
export async function getLocalHead(clonePath: string): Promise<string | null> {
  if (!existsSync(join(clonePath, '.git'))) return null;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: clonePath,
      timeout: 5_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check freshness of a remote against the local clone using git ls-remote.
 * This is cheap (~50ms, no disk I/O, no objects transferred).
 */
export async function checkFreshness(
  resource: SyncableResource,
  dataDir: string,
): Promise<FreshnessResult> {
  const gitUrl = resource.git_remote_url;
  if (!gitUrl) {
    return { stale: false, remoteHead: null, localHead: null };
  }

  const clonePath = getClonePath(dataDir, resource.id);
  const localHead = await getLocalHead(clonePath);

  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', gitUrl], {
      timeout: 15_000,
    });

    // Parse ls-remote output: "<hash>\trefs/heads/<branch>\n"
    // Look for main or master
    let remoteHead: string | null = null;
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const [hash, ref] = line.split('\t');
      if (ref === 'refs/heads/main' || ref === 'refs/heads/master') {
        remoteHead = hash;
        break;
      }
    }

    // If we couldn't find main/master, take the first ref
    if (!remoteHead && stdout.trim()) {
      const firstLine = stdout.trim().split('\n')[0];
      if (firstLine) {
        remoteHead = firstLine.split('\t')[0];
      }
    }

    return {
      stale: remoteHead !== null && remoteHead !== localHead,
      remoteHead,
      localHead,
    };
  } catch {
    return { stale: false, remoteHead: null, localHead };
  }
}

/**
 * Clone a git remote into the managed data directory.
 * Uses --depth=1 for shallow clone (faster, less disk).
 * Returns the clone path.
 */
export async function cloneRemote(
  gitUrl: string,
  clonePath: string,
  timeout: number = GIT_TIMEOUT,
): Promise<string> {
  // Ensure parent directory exists
  const parentDir = resolve(clonePath, '..');
  mkdirSync(parentDir, { recursive: true });

  await execFileAsync('git', ['clone', '--depth=1', gitUrl, clonePath], {
    timeout,
  });

  return clonePath;
}

/**
 * Ensure a local clone exists. Clones if missing, returns the path.
 */
export async function ensureClone(
  resource: SyncableResource,
  dataDir: string,
  timeout: number = GIT_TIMEOUT,
): Promise<string> {
  const clonePath = getClonePath(dataDir, resource.id);

  if (existsSync(join(clonePath, '.git'))) {
    return clonePath;
  }

  const gitUrl = resource.git_remote_url;
  if (!gitUrl) {
    throw new Error(`Resource ${resource.id} has no git_remote_url`);
  }

  return cloneRemote(gitUrl, clonePath, timeout);
}

/**
 * Fetch latest from remote into an existing clone.
 * Returns whether anything changed.
 */
export async function fetchLatest(
  clonePath: string,
  timeout: number = GIT_TIMEOUT,
): Promise<FetchResult> {
  const previousHead = await getLocalHead(clonePath);

  await execFileAsync('git', ['fetch', '--depth=1', 'origin'], {
    cwd: clonePath,
    timeout,
  });

  // Reset to the fetched remote HEAD
  await execFileAsync('git', ['reset', '--hard', 'FETCH_HEAD'], {
    cwd: clonePath,
    timeout: 5_000,
  });

  const newHead = await getLocalHead(clonePath);

  return {
    previousHead,
    newHead: newHead || previousHead || '',
    changed: newHead !== null && previousHead !== newHead,
  };
}

// ============================================================================
// Git Write Operations (commit + push for task graph sync)
// ============================================================================

export interface GitSyncStatus {
  hasUncommittedChanges: boolean;
  unpushedCommits: number;
  localHead: string | null;
  remoteHead: string | null;
}

/**
 * Check git sync status of a clone — uncommitted changes + unpushed commits.
 */
export async function getGitSyncStatus(clonePath: string): Promise<GitSyncStatus> {
  const localHead = await getLocalHead(clonePath);
  let hasUncommittedChanges = false;
  let unpushedCommits = 0;
  let remoteHead: string | null = null;

  // Check for uncommitted changes
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: clonePath, timeout: 5_000,
    });
    hasUncommittedChanges = stdout.trim().length > 0;
  } catch { /* assume no changes */ }

  // Check for unpushed commits (local vs remote tracking branch)
  try {
    const { stdout } = await execFileAsync(
      'git', ['rev-list', '--count', '@{upstream}..HEAD'],
      { cwd: clonePath, timeout: 5_000 },
    );
    unpushedCommits = parseInt(stdout.trim(), 10) || 0;
  } catch { /* no upstream or no commits */ }

  // Get remote HEAD for comparison
  try {
    const { stdout } = await execFileAsync(
      'git', ['rev-parse', '@{upstream}'],
      { cwd: clonePath, timeout: 5_000 },
    );
    remoteHead = stdout.trim() || null;
  } catch { /* no upstream */ }

  return { hasUncommittedChanges, unpushedCommits, localHead, remoteHead };
}

/**
 * Commit all opentasks-related changes in a clone.
 * Stages graph.jsonl and config.json in both root and .opentasks/ subdirectory.
 * Returns the new commit hash or null if nothing to commit.
 */
export async function commitChanges(
  clonePath: string,
  message = 'Update task graph',
): Promise<string | null> {
  // Stage all opentasks-related files (could be at root or in .opentasks/)
  const filesToStage = [
    'graph.jsonl', 'config.json',
    '.opentasks/graph.jsonl', '.opentasks/config.json', '.opentasks/.gitignore',
  ];
  for (const file of filesToStage) {
    try {
      await execFileAsync('git', ['add', '--', file], { cwd: clonePath, timeout: 5_000 });
    } catch { /* file may not exist — skip */ }
  }

  // Check if there's anything staged
  try {
    await execFileAsync('git', ['diff', '--cached', '--quiet'], {
      cwd: clonePath, timeout: 5_000,
    });
    // Exit 0 means no staged changes
    return null;
  } catch {
    // Exit 1 means there ARE staged changes — commit them
  }

  await execFileAsync('git', ['commit', '-m', message], {
    cwd: clonePath, timeout: 10_000,
  });

  return getLocalHead(clonePath);
}

/**
 * Push local commits to the remote.
 */
export async function pushToRemote(
  clonePath: string,
  timeout: number = GIT_TIMEOUT,
): Promise<void> {
  await execFileAsync('git', ['push'], {
    cwd: clonePath, timeout,
  });
}

/**
 * Resolve the graph.jsonl path within a clone or local directory.
 * Checks for graph.jsonl directly, then in .opentasks/ subdirectory.
 * Returns the directory containing graph.jsonl, or null.
 */
export function resolveGraphPath(basePath: string): string | null {
  // Direct: basePath/graph.jsonl (if basePath IS the .opentasks dir)
  if (existsSync(join(basePath, 'graph.jsonl'))) {
    return basePath;
  }

  // Nested: basePath/.opentasks/graph.jsonl
  const opentasksDir = join(basePath, '.opentasks');
  if (existsSync(join(opentasksDir, 'graph.jsonl'))) {
    return opentasksDir;
  }

  return null;
}

/**
 * Remove a cloned resource directory.
 */
export async function removeClone(dataDir: string, resourceId: string): Promise<void> {
  const clonePath = getClonePath(dataDir, resourceId);
  if (!existsSync(clonePath)) return;

  const { rm } = await import('node:fs/promises');
  await rm(clonePath, { recursive: true, force: true });
}
