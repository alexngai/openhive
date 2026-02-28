/**
 * Workspace Setup
 *
 * Shared utility for cloning git repositories into a swarm's working
 * directory before the process starts. Used by both the local and
 * sandboxed-local hosting providers.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkspaceConfig } from '../types.js';

/**
 * Clone workspace repositories into the swarm data directory.
 * Runs sequentially so errors are clearly attributable to a specific repo.
 */
export async function cloneWorkspaceRepos(
  workspace: WorkspaceConfig,
  dataDir: string,
  env: Record<string, string>,
): Promise<void> {
  for (const repo of workspace.repos) {
    const cloneDir = repo.path ? path.resolve(dataDir, repo.path) : dataDir;

    // Ensure the target directory exists
    if (!fs.existsSync(cloneDir)) {
      fs.mkdirSync(cloneDir, { recursive: true });
    }

    const args = ['clone'];
    if (repo.depth) {
      args.push('--depth', String(repo.depth));
    }
    if (repo.branch) {
      args.push('--branch', repo.branch);
    }
    args.push('--', repo.url, cloneDir);

    await new Promise<void>((resolve, reject) => {
      execFile('git', args, { env, timeout: 120_000 }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(
            `git clone failed for ${repo.url}: ${error.message}${stderr ? `\n${stderr}` : ''}`
          ));
        } else {
          resolve();
        }
      });
    });
  }
}
