/**
 * Tests for the shared resolveRepoForSpawn helper used by both
 * swarm-runner and TUI spawn paths.
 */

import * as fs from 'fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as reposDAL from '../../db/dal/repos.js';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { resolveRepoForSpawn, applyRepoEnvVars, RepoResolutionError } from '../../swarm/resolve-repo.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import * as path from 'path';

const TEST_ROOT = testRoot('resolve-repo');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'resolve-repo.db');

describe('resolveRepoForSpawn', () => {
  let agentId: string;
  let repoId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'resolve-repo-test' });
    agentId = agent.id;

    const repo = reposDAL.upsertRepoByCanonicalUrl(
      canonicalizeRepoUrl('https://github.com/org/myrepo.git'),
      { name: 'myrepo', origin: 'user_defined', owner_agent_id: agentId },
    );
    repoId = repo.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('resolves a valid repo_id to url, branch, and localPath', () => {
    const resolved = resolveRepoForSpawn(repoId, '/tmp/swarm-data', agentId);
    expect(resolved.url).toBe('https://github.com/org/myrepo');
    expect(resolved.branch).toBe('main');
    expect(resolved.localPath).toBe('/tmp/swarm-data/repo');
    expect(resolved.existsLocally).toBe(false);
  });

  it('throws RepoResolutionError for unknown repo_id', () => {
    expect(() => resolveRepoForSpawn('nonexistent-id', '/tmp/data', agentId)).toThrow(
      RepoResolutionError,
    );
  });

  it('uses default_branch from repo metadata when available', () => {
    const repo = reposDAL.upsertRepoByCanonicalUrl(
      canonicalizeRepoUrl('https://github.com/org/branched.git'),
      {
        name: 'branched',
        origin: 'user_defined',
        owner_agent_id: agentId,
        default_branch: 'develop',
      },
    );
    const resolved = resolveRepoForSpawn(repo.id, '/data', agentId);
    expect(resolved.branch).toBe('develop');
  });

  it('uses local_path from repo resource when directory exists on disk', () => {
    const localDir = path.join(TEST_ROOT, 'existing-checkout');
    fs.mkdirSync(localDir, { recursive: true });

    const repo = reposDAL.upsertRepoByCanonicalUrl(
      canonicalizeRepoUrl('https://github.com/org/local-repo.git'),
      { name: 'local-repo', origin: 'user_defined', owner_agent_id: agentId },
    );
    // Set local_path on the resource row.
    getDatabase().prepare(
      'UPDATE syncable_resources SET local_path = ? WHERE id = ?',
    ).run(localDir, repo.id);

    const resolved = resolveRepoForSpawn(repo.id, '/tmp/swarm-data', agentId);
    expect(resolved.localPath).toBe(localDir);
    expect(resolved.existsLocally).toBe(true);
  });

  // ── Authorization gate ───────────────────────────────────────────────────

  it('throws RepoResolutionError when the spawning agent has no access to a private repo', async () => {
    // Owner agent owns the repo; second agent is unrelated and unsubscribed.
    const { agent: stranger } = await agentsDAL.createAgent({
      name: 'resolve-repo-stranger',
    });
    expect(() => resolveRepoForSpawn(repoId, '/tmp/swarm-data', stranger.id)).toThrow(
      RepoResolutionError,
    );
  });

  it('falls back to dataDir/repo when local_path does not exist on disk', () => {
    const repo = reposDAL.upsertRepoByCanonicalUrl(
      canonicalizeRepoUrl('https://github.com/org/ghost-repo.git'),
      { name: 'ghost-repo', origin: 'user_defined', owner_agent_id: agentId },
    );
    getDatabase().prepare(
      'UPDATE syncable_resources SET local_path = ? WHERE id = ?',
    ).run('/nonexistent/path/that/does/not/exist', repo.id);

    const resolved = resolveRepoForSpawn(repo.id, '/tmp/swarm-data', agentId);
    expect(resolved.localPath).toBe('/tmp/swarm-data/repo');
    expect(resolved.existsLocally).toBe(false);
  });
});

describe('applyRepoEnvVars', () => {
  it('sets WORKSPACE_* env vars on the target object', () => {
    const env: Record<string, string> = {};
    applyRepoEnvVars(env, {
      url: 'https://github.com/org/repo.git',
      branch: 'feature-x',
      localPath: '/data/repo',
      existsLocally: false,
    });
    expect(env.WORKSPACE_REPO_URL).toBe('https://github.com/org/repo.git');
    expect(env.WORKSPACE_BRANCH).toBe('feature-x');
    expect(env.WORKSPACE_LOCAL_PATH).toBe('/data/repo');
  });
});
