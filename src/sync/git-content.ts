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
  unpulledCommits: number;
  localHead: string | null;
  remoteHead: string | null;
  /** Breakdown of uncommitted changes (only present when hasUncommittedChanges is true) */
  uncommittedDetails?: {
    added: number;
    modified: number;
    deleted: number;
    linesAdded: number;
    linesDeleted: number;
  };
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
  let uncommittedDetails: GitSyncStatus['uncommittedDetails'];
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: clonePath, timeout: 5_000,
    });
    const lines = stdout.trim().split('\n').filter(Boolean);
    hasUncommittedChanges = lines.length > 0;

    if (hasUncommittedChanges) {
      let added = 0, modified = 0, deleted = 0;
      for (const line of lines) {
        const code = line.slice(0, 2);
        if (code.includes('A') || code === '??') added++;
        else if (code.includes('D')) deleted++;
        else modified++;
      }

      // Get line-level diff stats
      let linesAdded = 0, linesDeleted = 0;
      try {
        const { stdout: diffStat } = await execFileAsync(
          'git', ['diff', '--numstat', 'HEAD'],
          { cwd: clonePath, timeout: 5_000 },
        );
        for (const dl of diffStat.trim().split('\n').filter(Boolean)) {
          const [a, d] = dl.split('\t');
          if (a !== '-') linesAdded += parseInt(a, 10) || 0;
          if (d !== '-') linesDeleted += parseInt(d, 10) || 0;
        }
        // Untracked stats are harder than the diff path — just count from status above.
      } catch { /* diff failed, that's ok */ }

      uncommittedDetails = { added, modified, deleted, linesAdded, linesDeleted };
    }
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

  // Check for unpulled commits (remote has commits we don't)
  let unpulledCommits = 0;
  try {
    // Fetch to ensure we have latest remote refs
    await execFileAsync('git', ['fetch', 'origin'], { cwd: clonePath, timeout: 10_000 });
    const { stdout } = await execFileAsync(
      'git', ['rev-list', '--count', 'HEAD..@{upstream}'],
      { cwd: clonePath, timeout: 5_000 },
    );
    unpulledCommits = parseInt(stdout.trim(), 10) || 0;
  } catch { /* no upstream or fetch failed */ }

  return { hasUncommittedChanges, unpushedCommits, unpulledCommits, localHead, remoteHead, uncommittedDetails };
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
export async function pullFromRemote(
  clonePath: string,
  timeout: number = GIT_TIMEOUT,
): Promise<{ pulled: boolean; previousHead: string | null; newHead: string | null }> {
  const previousHead = await getLocalHead(clonePath);

  // Fetch first to update tracking refs
  await execFileAsync('git', ['fetch', 'origin'], {
    cwd: clonePath, timeout,
  });

  // Merge fast-forward only — avoids conflicts
  try {
    await execFileAsync('git', ['merge', '--ff-only', '@{upstream}'], {
      cwd: clonePath, timeout: 10_000,
    });
  } catch {
    // ff-only failed — could be diverged. Return without merge.
    return { pulled: false, previousHead, newHead: previousHead };
  }

  const newHead = await getLocalHead(clonePath);
  return { pulled: newHead !== previousHead, previousHead, newHead };
}

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
