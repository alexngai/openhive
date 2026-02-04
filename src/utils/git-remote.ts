/**
 * Git Remote Utilities
 *
 * Provides functions for checking remote git repository state without webhooks.
 * Supports GitHub, GitLab, and generic git remotes via git ls-remote.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface RemoteRefInfo {
  commitHash: string;
  ref: string;
  timestamp?: string; // Only available from API calls, not git ls-remote
}

export interface CheckRemoteResult {
  success: boolean;
  ref?: RemoteRefInfo;
  error?: string;
  source: 'github-api' | 'gitlab-api' | 'git-ls-remote' | 'unknown';
}

/**
 * Parse a git remote URL into host, owner, and repo components.
 */
export function parseGitUrl(url: string): {
  host: string;
  owner: string;
  repo: string;
} | null {
  // Normalize the URL
  let normalized = url.trim();

  // Handle SSH format: git@github.com:user/repo.git
  const sshMatch = normalized.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { host: sshMatch[1], owner: sshMatch[2], repo: sshMatch[3] };
  }

  // Handle HTTPS format: https://github.com/user/repo.git
  const httpsMatch = normalized.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return { host: httpsMatch[1], owner: httpsMatch[2], repo: httpsMatch[3] };
  }

  // Handle git:// format: git://github.com/user/repo.git
  const gitMatch = normalized.match(
    /^git:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (gitMatch) {
    return { host: gitMatch[1], owner: gitMatch[2], repo: gitMatch[3] };
  }

  // Handle simple format: github.com/user/repo
  const simpleMatch = normalized.match(/^([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (simpleMatch) {
    return { host: simpleMatch[1], owner: simpleMatch[2], repo: simpleMatch[3] };
  }

  return null;
}

/**
 * Check GitHub repo for latest commit on default branch using API.
 * Works for public repos without authentication.
 */
async function checkGitHubApi(
  owner: string,
  repo: string,
  branch: string = 'main'
): Promise<CheckRemoteResult> {
  const branches = branch === 'main' ? ['main', 'master'] : [branch];

  for (const branchName of branches) {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${branchName}`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'OpenHive-MemoryBank-Sync',
          },
        }
      );

      if (response.status === 404 && branchName === 'main') {
        // Try master branch
        continue;
      }

      if (!response.ok) {
        if (response.status === 403) {
          return {
            success: false,
            error: 'GitHub API rate limit exceeded',
            source: 'github-api',
          };
        }
        return {
          success: false,
          error: `GitHub API error: ${response.status}`,
          source: 'github-api',
        };
      }

      const data = (await response.json()) as {
        sha: string;
        commit: { committer: { date: string } };
      };

      return {
        success: true,
        ref: {
          commitHash: data.sha,
          ref: `refs/heads/${branchName}`,
          timestamp: data.commit?.committer?.date,
        },
        source: 'github-api',
      };
    } catch (error) {
      return {
        success: false,
        error: `GitHub API error: ${(error as Error).message}`,
        source: 'github-api',
      };
    }
  }

  return {
    success: false,
    error: 'Branch not found',
    source: 'github-api',
  };
}

/**
 * Check GitLab repo for latest commit using API.
 * Works for public repos without authentication.
 */
async function checkGitLabApi(
  host: string,
  owner: string,
  repo: string,
  branch: string = 'main'
): Promise<CheckRemoteResult> {
  const projectPath = encodeURIComponent(`${owner}/${repo}`);
  const branches = branch === 'main' ? ['main', 'master'] : [branch];

  for (const branchName of branches) {
    try {
      const response = await fetch(
        `https://${host}/api/v4/projects/${projectPath}/repository/branches/${branchName}`,
        {
          headers: {
            'User-Agent': 'OpenHive-MemoryBank-Sync',
          },
        }
      );

      if (response.status === 404 && branchName === 'main') {
        // Try master branch
        continue;
      }

      if (!response.ok) {
        return {
          success: false,
          error: `GitLab API error: ${response.status}`,
          source: 'gitlab-api',
        };
      }

      const data = (await response.json()) as {
        commit: { id: string; committed_date: string };
      };

      return {
        success: true,
        ref: {
          commitHash: data.commit.id,
          ref: `refs/heads/${branchName}`,
          timestamp: data.commit.committed_date,
        },
        source: 'gitlab-api',
      };
    } catch (error) {
      return {
        success: false,
        error: `GitLab API error: ${(error as Error).message}`,
        source: 'gitlab-api',
      };
    }
  }

  return {
    success: false,
    error: 'Branch not found',
    source: 'gitlab-api',
  };
}

/**
 * Check remote using git ls-remote command.
 * Works with any git remote but requires git to be installed.
 */
async function checkGitLsRemote(
  url: string,
  branch: string = 'main'
): Promise<CheckRemoteResult> {
  const branches = branch === 'main' ? ['main', 'master'] : [branch];

  for (const branchName of branches) {
    try {
      const { stdout } = await execAsync(
        `git ls-remote --refs ${url} refs/heads/${branchName}`,
        { timeout: 15000 }
      );

      const lines = stdout.trim().split('\n');
      if (lines.length > 0 && lines[0]) {
        const [hash, ref] = lines[0].split('\t');
        if (hash && ref) {
          return {
            success: true,
            ref: {
              commitHash: hash,
              ref: ref,
            },
            source: 'git-ls-remote',
          };
        }
      }

      // If main not found, try master
      if (branchName === 'main') {
        continue;
      }
    } catch (error) {
      // If main fails, try master before giving up
      if (branchName === 'main') {
        continue;
      }
      return {
        success: false,
        error: `git ls-remote failed: ${(error as Error).message}`,
        source: 'git-ls-remote',
      };
    }
  }

  return {
    success: false,
    error: 'Could not find branch',
    source: 'git-ls-remote',
  };
}

/**
 * Check a git remote for the latest commit on the default branch.
 * Automatically selects the best method based on the host.
 *
 * @param gitRemoteUrl - The git remote URL to check
 * @param branch - The branch to check (defaults to 'main', will also try 'master')
 */
export async function checkRemoteForUpdates(
  gitRemoteUrl: string,
  branch: string = 'main'
): Promise<CheckRemoteResult> {
  const parsed = parseGitUrl(gitRemoteUrl);

  if (!parsed) {
    // Can't parse URL, try git ls-remote as fallback
    return checkGitLsRemote(gitRemoteUrl, branch);
  }

  const { host, owner, repo } = parsed;

  // Try API first for known hosts (faster, no git dependency)
  if (host === 'github.com') {
    const result = await checkGitHubApi(owner, repo, branch);
    if (result.success) {
      return result;
    }
    // Fall back to git ls-remote if API fails (e.g., rate limited)
  }

  if (host === 'gitlab.com' || host.includes('gitlab')) {
    const result = await checkGitLabApi(host, owner, repo, branch);
    if (result.success) {
      return result;
    }
    // Fall back to git ls-remote
  }

  // For other hosts or as fallback, use git ls-remote
  return checkGitLsRemote(gitRemoteUrl, branch);
}

/**
 * Check multiple remotes in parallel with concurrency limit.
 */
export async function checkRemotesBatch(
  remotes: Array<{ id: string; gitRemoteUrl: string; branch?: string }>,
  concurrency: number = 5
): Promise<Map<string, CheckRemoteResult>> {
  const results = new Map<string, CheckRemoteResult>();

  // Process in batches to limit concurrency
  for (let i = 0; i < remotes.length; i += concurrency) {
    const batch = remotes.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ id, gitRemoteUrl, branch }) => {
        const result = await checkRemoteForUpdates(gitRemoteUrl, branch);
        return { id, result };
      })
    );

    for (const { id, result } of batchResults) {
      results.set(id, result);
    }
  }

  return results;
}
