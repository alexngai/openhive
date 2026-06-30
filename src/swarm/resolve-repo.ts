/**
 * Shared repo resolution for swarm spawn paths.
 *
 * Both the swarm-runner and TUI spawn pipelines need to resolve a `repo_id`
 * into WORKSPACE_* env vars. This module extracts that logic so both paths
 * stay in sync.
 *
 * Resolution precedence for `localPath`:
 *   1. Repo resource's `local_path` (existing checkout on the host)
 *   2. Fallback: `${dataDir}/repo` (provider will clone to this path)
 *
 * When `localPath` points to an existing directory the provider should
 * skip cloning and just mount it as the working directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as repos from '../db/dal/repos.js';
import { canAccessResource } from '../db/dal/syncable-resources.js';

export interface ResolvedRepo {
  url: string;
  branch: string;
  localPath: string;
  /** true when localPath already exists on disk — skip clone, just mount. */
  existsLocally: boolean;
}

/**
 * Resolve a `repo_id` to env vars and a clone/mount target.
 *
 * `agentId` is the spawning agent. We check `canAccessResource(agentId,
 * repo)` so an agent can't spawn against a private repo owned by someone
 * else. Both "not found" and "no access" surface as the same
 * `RepoResolutionError` so we don't leak existence to fishing requests
 * (matches the pattern in `src/api/routes/resources.ts` for read paths).
 */
export function resolveRepoForSpawn(
  repoId: string,
  dataDir: string,
  agentId: string,
): ResolvedRepo {
  const repo = repos.findRepoById(repoId);
  if (!repo) {
    throw new RepoResolutionError(`Repo resource ${repoId} not found`);
  }
  if (repo.resource_type !== 'repo') {
    throw new RepoResolutionError(
      `Resource ${repoId} is type=${repo.resource_type}, not repo`,
    );
  }
  // Authorization gate. The repo row's owner_agent_id is the source of
  // truth; subscriptions extend access to non-owners. Without this check
  // any agent that knows a `repo_id` could spawn a TUI cwd'd to (and
  // pre-trusting) the operator's local_path.
  if (!canAccessResource(agentId, repo)) {
    throw new RepoResolutionError(`Repo resource ${repoId} not found`);
  }
  const meta = (repo.metadata ?? {}) as { default_branch?: string };

  // Prefer the resource's known local_path (existing checkout on the host).
  // Fall back to a clone target under the swarm's data directory.
  const knownLocal = repo.local_path;
  const localPath = knownLocal && fs.existsSync(knownLocal)
    ? knownLocal
    : path.join(dataDir, 'repo');
  const existsLocally = fs.existsSync(localPath);

  return {
    url: repo.git_remote_url,
    branch: meta.default_branch ?? 'main',
    localPath,
    existsLocally,
  };
}

export function applyRepoEnvVars(
  env: Record<string, string>,
  resolved: ResolvedRepo,
): void {
  env.WORKSPACE_REPO_URL = resolved.url;
  env.WORKSPACE_BRANCH = resolved.branch;
  env.WORKSPACE_LOCAL_PATH = resolved.localPath;
}

export class RepoResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoResolutionError';
  }
}
