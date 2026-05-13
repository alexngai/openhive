/**
 * Slice 8 path B — `autoRegisterResource` opportunistically stamps
 * `metadata.repo_id` on auto-created task resources when:
 *   1. The opentasks directory lives inside a git working tree, AND
 *   2. The working tree has an `origin` remote, AND
 *   3. A federated repo with that canonical URL already exists locally.
 *
 * All three conditions failing → silent skip (no `metadata.repo_id`).
 *
 * Uses a real on-disk git fixture (init + remote add) instead of mocking
 * `child_process.execSync`, since the integration is the contract.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as repos from '../../db/dal/repos.js';
import { autoRegisterResource, readGitOriginCanonical } from '../../map/task-handler.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('task-handler-repo-link');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'task-handler-repo-link.db');

const REMOTE_URL = 'https://github.com/openhive-org/path-b-test';

/**
 * Build an opentasks directory inside a git working tree with the given
 * remote URL. Returns the absolute path of the .opentasks dir.
 */
function makeFixture(name: string, remoteUrl: string | null): string {
  const repoDir = path.join(TEST_ROOT, name);
  fs.mkdirSync(repoDir, { recursive: true });
  execSync('git init -q', { cwd: repoDir });
  if (remoteUrl) {
    execSync(`git remote add origin ${remoteUrl}`, { cwd: repoDir });
  }
  const opentasksDir = path.join(repoDir, '.opentasks');
  fs.mkdirSync(opentasksDir, { recursive: true });
  fs.writeFileSync(path.join(opentasksDir, 'config.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '');
  return opentasksDir;
}

/**
 * Build an opentasks directory NOT inside a git working tree.
 */
function makeFixtureNoGit(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(dir, 'graph.jsonl'), '');
  return dir;
}

describe('autoRegisterResource → repo_id linking (slice 8 path B)', () => {
  let agentId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'task-link-owner' });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare(`DELETE FROM syncable_resources WHERE resource_type IN ('task', 'repo')`).run();
  });

  it('readGitOriginCanonical returns the canonical URL for a path inside a git tree', () => {
    const opentasksDir = makeFixture('with-remote', REMOTE_URL);
    expect(readGitOriginCanonical(opentasksDir)).toBe(canonicalizeRepoUrl(REMOTE_URL).canonicalUrl);
  });

  it('readGitOriginCanonical returns null for a path with no git tree', () => {
    const dir = makeFixtureNoGit('no-git');
    expect(readGitOriginCanonical(dir)).toBeNull();
  });

  it('readGitOriginCanonical returns null for a git tree without an origin remote', () => {
    const opentasksDir = makeFixture('no-remote', null);
    expect(readGitOriginCanonical(opentasksDir)).toBeNull();
  });

  it('stamps metadata.repo_id when a repo with the same canonical URL already exists', () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl(REMOTE_URL), {
      origin: 'user_defined',
      visibility: 'hub_local',
      owner_agent_id: agentId,
    });

    const opentasksDir = makeFixture('match', REMOTE_URL);
    const resource = autoRegisterResource(opentasksDir, agentId);

    const meta = resource.metadata as Record<string, unknown>;
    expect(meta.opentasks).toBe(true);
    expect(meta.repo_id).toBe(repo.id);
  });

  it('does NOT stamp metadata.repo_id when no matching repo exists', () => {
    // Different remote → no repo registered for this URL → silent skip.
    const opentasksDir = makeFixture('unknown-remote', 'https://github.com/somebody-else/random');
    const resource = autoRegisterResource(opentasksDir, agentId);

    const meta = resource.metadata as Record<string, unknown>;
    expect(meta.repo_id).toBeUndefined();
  });

  it('does NOT stamp metadata.repo_id when the opentasks dir has no git tree', () => {
    const opentasksDir = makeFixtureNoGit('orphan-tasks');
    const resource = autoRegisterResource(opentasksDir, agentId);

    const meta = resource.metadata as Record<string, unknown>;
    expect(meta.repo_id).toBeUndefined();
  });

  it('canonicalizes mixed-case / .git-suffixed remotes to find the repo', () => {
    // Repo persisted under canonical form
    const canonical = canonicalizeRepoUrl(REMOTE_URL).canonicalUrl;
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl(REMOTE_URL), {
      origin: 'user_defined',
      visibility: 'hub_local',
      owner_agent_id: agentId,
    });

    // Remote on disk uses the SSH variant + .git suffix
    const opentasksDir = makeFixture('ssh-form', 'git@github.com:OpenHive-Org/Path-B-Test.git');
    expect(readGitOriginCanonical(opentasksDir)).toBe(canonical);

    const resource = autoRegisterResource(opentasksDir, agentId);
    const meta = resource.metadata as Record<string, unknown>;
    expect(meta.repo_id).toBe(repo.id);
  });
});
