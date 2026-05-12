/**
 * Layer 7 — end-to-end cross-instance bundle fetch over a real git remote.
 *
 * The unit tests in `cross-instance-resolver.test.ts` exercise the
 * orchestration via the inline-content branch — cheap, fast. This file
 * proves the full security boundary holds when the resolver actually
 * touches the network (well, a local `file://` repo standing in for one):
 *
 *   1. A replicated row from a trusted peer with `git_remote_url` but
 *      no `metadata.content` and no `local_path` → resolver lazy-clones,
 *      bundles from the on-disk YAML, hash matches, store caches.
 *   2. The same row from an *untrusted* peer → resolver returns null
 *      without ever invoking the clone path (verified by leaving the
 *      remote unreadable; if the clone were attempted, the test would
 *      fail differently).
 *   3. The standalone-loadout YAML path: a `loadout.yaml` at the repo
 *      root is honored (fix for the L6 standalone-loadout no-op).
 *   4. Hash drift between the requested id and the actual on-disk
 *      content fails closed (returns null + logs).
 *
 * "Trusted-but-compromised" is not directly modelled here — that's the
 * inline pre-filter's job in `cross-instance-resolver.test.ts`. This
 * file is specifically about: does the git-clone branch wire together
 * the trust gate, the clone, and the hash gate correctly?
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { nanoid } from 'nanoid';
import { LOADOUT_RESOURCE_TYPE, TEAM_RESOURCE_TYPE } from 'openteams';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
  broadcast: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as instancesDAL from '../../db/dal/instances.js';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsBundleStore,
} from '../../openteams/map-handlers.js';
import {
  bundleLoadoutContent,
  bundleTeamTemplateContent,
} from '../../openteams/internal/bundle-content.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('openteams-cross-instance-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'cross-instance-e2e.db');

const TEAM_CONTENT = {
  manifest: {
    name: 'cross-team',
    version: 1 as const,
    roles: ['worker'],
    topology: { root: { role: 'worker' } },
  },
  roles: { worker: { name: 'worker', capabilities: ['build'] } },
};

const LOADOUT_CONTENT = {
  name: 'cross-lo',
  capabilities: ['file.read', 'exec.test'],
  permissions: { deny: ['Bash(git push:*)'] },
  prompt_addendum: 'be precise',
};

function gitExec(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

/**
 * Build a real local git repo with a team_template layout (team.yaml +
 * roles/<name>.yaml). Returns the repo path; `file://${path}` is a
 * valid `git_remote_url`.
 */
function setupTeamRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'openteams-l7-team-'));
  writeFileSync(join(repoDir, 'team.yaml'), yaml.dump(TEAM_CONTENT.manifest));
  const rolesDir = join(repoDir, 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(
    join(rolesDir, 'worker.yaml'),
    yaml.dump(TEAM_CONTENT.roles.worker),
  );
  gitExec('git init -b main', repoDir);
  gitExec('git config user.email "test@test.com"', repoDir);
  gitExec('git config user.name "Test"', repoDir);
  gitExec('git add -A', repoDir);
  gitExec('git commit -m "init"', repoDir);
  return repoDir;
}

/**
 * Build a real local git repo with a standalone loadout layout
 * (loadout.yaml at the root). Exercises the fix-2 path.
 */
function setupLoadoutRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'openteams-l7-loadout-'));
  writeFileSync(join(repoDir, 'loadout.yaml'), yaml.dump(LOADOUT_CONTENT));
  gitExec('git init -b main', repoDir);
  gitExec('git config user.email "test@test.com"', repoDir);
  gitExec('git config user.name "Test"', repoDir);
  gitExec('git add -A', repoDir);
  gitExec('git commit -m "init"', repoDir);
  return repoDir;
}

/**
 * Insert a replicated row pointing at a real git remote. No
 * `metadata.content`, no `local_path` — the only way to bundle is to
 * clone.
 */
function insertReplicatedGitRow(opts: {
  resourceType: 'loadout' | 'team_template';
  name: string;
  ownerAgentId: string;
  originInstanceId: string;
  gitRemoteUrl: string;
}): string {
  const id = `rr_${nanoid()}`;
  // Note: metadata is empty (`{}`) — no `content` key. This is the
  // strict cross-instance shape we want to exercise (forces the git
  // path, no inline fallback).
  getDatabase()
    .prepare(
      `INSERT INTO syncable_resources
        (id, resource_type, name, git_remote_url, visibility, owner_agent_id,
         metadata, origin_instance_id, origin_resource_id, created_at)
       VALUES (?, ?, ?, ?, 'shared', ?, '{}', ?, ?, datetime('now'))`,
    )
    .run(
      id,
      opts.resourceType,
      opts.name,
      opts.gitRemoteUrl,
      opts.ownerAgentId,
      opts.originInstanceId,
      `origin_${opts.name}`,
    );
  return id;
}

describe('openteams cross-instance resolver — git e2e (Layer 7)', () => {
  let agentId: string;
  let trustedInstanceId: string;
  let untrustedInstanceId: string;
  let teamRepoDir: string;
  let loadoutRepoDir: string;
  const cleanup: string[] = [];

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'l7-e2e-owner',
      description: 'L7 e2e tests',
    });
    agentId = agent.id;

    const trusted = instancesDAL.createInstance({
      url: 'https://trusted.example.invalid',
      name: 'trusted-peer',
      is_trusted: true,
    });
    trustedInstanceId = trusted.id;

    const untrusted = instancesDAL.createInstance({
      url: 'https://untrusted.example.invalid',
      name: 'untrusted-peer',
      is_trusted: false,
    });
    untrustedInstanceId = untrusted.id;

    teamRepoDir = setupTeamRepo();
    loadoutRepoDir = setupLoadoutRepo();
    cleanup.push(teamRepoDir, loadoutRepoDir);
  });

  afterAll(() => {
    closeDatabase();
    for (const dir of cleanup) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase()
      .prepare(
        `DELETE FROM syncable_resources WHERE resource_type IN ('loadout', 'team_template')`,
      )
      .run();
    _resetOpenteamsMapHandlers();
  });

  it('team_template: trusted peer + git remote + no inline → lazy clone + hash match', async () => {
    const expected = bundleTeamTemplateContent('cross-team', TEAM_CONTENT);

    insertReplicatedGitRow({
      resourceType: 'team_template',
      name: 'cross-team',
      ownerAgentId: agentId,
      originInstanceId: trustedInstanceId,
      gitRemoteUrl: `file://${teamRepoDir}`,
    });

    const got = await getOpenteamsBundleStore().get(
      TEAM_RESOURCE_TYPE,
      expected.id,
    );
    expect(got).not.toBeNull();
    expect(got!.id).toBe(expected.id);
  }, 30_000);

  it('loadout: trusted peer + git remote with loadout.yaml at root → lazy clone + hash match', async () => {
    const expected = bundleLoadoutContent('cross-lo', LOADOUT_CONTENT);

    insertReplicatedGitRow({
      resourceType: 'loadout',
      name: 'cross-lo',
      ownerAgentId: agentId,
      originInstanceId: trustedInstanceId,
      gitRemoteUrl: `file://${loadoutRepoDir}`,
    });

    const got = await getOpenteamsBundleStore().get(
      LOADOUT_RESOURCE_TYPE,
      expected.id,
    );
    expect(got).not.toBeNull();
    expect(got!.id).toBe(expected.id);
  }, 30_000);

  it('untrusted peer: git remote is NEVER consulted (trust gate is upstream of clone)', async () => {
    const expected = bundleTeamTemplateContent('cross-team', TEAM_CONTENT);

    // Point at a deliberately-broken file:// URL. If the resolver were
    // to attempt the clone, it would fail noisily. The trust gate must
    // short-circuit before that happens.
    insertReplicatedGitRow({
      resourceType: 'team_template',
      name: 'cross-team',
      ownerAgentId: agentId,
      originInstanceId: untrustedInstanceId,
      gitRemoteUrl: 'file:///nonexistent/path/openteams.git',
    });

    const got = await getOpenteamsBundleStore().get(
      TEAM_RESOURCE_TYPE,
      expected.id,
    );
    expect(got).toBeNull();
  }, 30_000);

  it('hash drift: trusted peer git content does not hash to the requested id → returns null', async () => {
    insertReplicatedGitRow({
      resourceType: 'team_template',
      name: 'cross-team',
      ownerAgentId: agentId,
      originInstanceId: trustedInstanceId,
      gitRemoteUrl: `file://${teamRepoDir}`,
    });

    // Ask for a hash that does not match the real on-disk content.
    const wrongHash =
      'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    const got = await getOpenteamsBundleStore().get(
      TEAM_RESOURCE_TYPE,
      wrongHash,
    );
    expect(got).toBeNull();
  }, 30_000);

  it('inline pre-filter wins: matching inline content avoids the git clone (broken remote untouched)', async () => {
    const expected = bundleTeamTemplateContent('cross-team', TEAM_CONTENT);

    // A trusted row carrying BOTH inline content AND a deliberately-
    // broken git remote. The resolver's two-pass scan should serve the
    // request from the inline branch and never invoke the clone path —
    // if it did, the file:// URL would fail noisily.
    const id = `rr_${nanoid()}`;
    getDatabase()
      .prepare(
        `INSERT INTO syncable_resources
          (id, resource_type, name, git_remote_url, visibility, owner_agent_id,
           metadata, origin_instance_id, origin_resource_id, created_at)
         VALUES (?, 'team_template', 'cross-team', 'file:///nonexistent/broken.git',
                 'shared', ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        id,
        agentId,
        JSON.stringify({ content: TEAM_CONTENT }),
        trustedInstanceId,
        'origin_inline_with_broken_remote',
      );

    const got = await getOpenteamsBundleStore().get(
      TEAM_RESOURCE_TYPE,
      expected.id,
    );
    expect(got).not.toBeNull();
    expect(got!.id).toBe(expected.id);
  }, 30_000);
});
