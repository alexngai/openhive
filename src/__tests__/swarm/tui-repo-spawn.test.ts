/**
 * E2E test: TUI spawn path (kind=claude-code) with repo_id.
 *
 * Verifies the Phase 3c flow:
 *   1. repo_id → resolveRepoForSpawn → WORKSPACE_* env vars in PTY env
 *   2. Existing local_path → mount (no clone), cwd = local_path
 *   3. No local_path → clone via cloneWorkspaceRepos, cwd = dataDir/repo
 *   4. No repo_id → cwd = dataDir (unchanged behavior)
 *
 * Uses mocked PtyManager + claude binary resolver to capture spawn args
 * without actually launching a process.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

vi.mock('../../swarm/claude-binary.js', () => ({
  resolveClaudeBinary: vi.fn(() => '/usr/bin/claude'),
}));

vi.mock('../../swarm/providers/workspace.js', () => ({
  cloneWorkspaceRepos: vi.fn(async () => {}),
}));

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as reposDAL from '../../db/dal/repos.js';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { SwarmManager } from '../../swarm/manager.js';
import { cloneWorkspaceRepos } from '../../swarm/providers/workspace.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('tui-repo-spawn');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'tui-repo-spawn.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

// ── Mock PtyManager ─────────────────────────────────────────────────────────

interface CapturedPtyCreate {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

class MockPtyManager extends EventEmitter {
  captured: CapturedPtyCreate[] = [];
  private nextId = 1;

  create(opts: { command: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }) {
    this.captured.push({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: { ...opts.env },
    });
    return { id: `pty_${this.nextId++}`, pid: 99999 };
  }

  destroy(_id: string) {}
  write(_id: string, _data: string) {}
  resize(_id: string, _cols: number, _rows: number) {}
  getScrollback(_id: string) { return ''; }
  listSessions() { return []; }
}

function makeConfig(): SwarmHostingConfig {
  return {
    enabled: true,
    default_provider: 'local',
    swarm_runner_command: 'echo unused',
    data_dir: TEST_DATA_DIR,
    port_range: [19300, 19310],
    max_swarms: 5,
    health_check_interval: 60_000,
    max_health_failures: 3,
    auto_restart: false,
    max_restart_attempts: 0,
  };
}

function buildManager(mockPty: MockPtyManager): SwarmManager {
  const mgr = new SwarmManager(makeConfig(), 'http://127.0.0.1:0');
  mgr.setPtyManager(mockPty as any);
  // Skip sidecar registration wait — no real sidecar in unit tests.
  (mgr as any).waitForSidecarRegistration = async () => true;
  return mgr;
}

// ── Setup ────────────────────────────────────────────────────────────────────

describe('TUI spawn — repo_id mount-or-clone', () => {
  let agentId: string;
  let repoId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initTokenService(undefined, TEST_ROOT);
    const { agent } = await agentsDAL.createAgent({
      name: 'tui-repo-spawn-agent',
      is_admin: true,
    });
    agentId = agent.id;

    const repo = reposDAL.upsertRepoByCanonicalUrl(
      canonicalizeRepoUrl('https://github.com/test-org/tui-repo.git'),
      { name: 'tui-repo', origin: 'user_defined', owner_agent_id: agentId, default_branch: 'main' },
    );
    repoId = repo.id;
  });

  afterAll(async () => {
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    vi.mocked(cloneWorkspaceRepos).mockClear();
    const db = getDatabase();
    db.prepare('DELETE FROM hosted_swarms').run();
    db.prepare(
      'DELETE FROM map_swarms WHERE id NOT IN (SELECT id FROM hosted_swarms)',
    ).run();
  });

  // ── Clone path: no local_path on repo ─────────────────────────────────────

  it('clones repo and sets cwd to clone target when no local_path exists', async () => {
    const mockPty = new MockPtyManager();
    const mgr = buildManager(mockPty);

    try {
      await mgr.spawn(agentId, { kind: 'claude-code', name: 'clone-test', repo_id: repoId });

      expect(mockPty.captured).toHaveLength(1);
      const pty = mockPty.captured[0];

      // cwd should be dataDir/repo (clone target)
      expect(pty.cwd).toMatch(/\/repo$/);

      // WORKSPACE_* env vars injected
      expect(pty.env.WORKSPACE_REPO_URL).toBe('https://github.com/test-org/tui-repo');
      expect(pty.env.WORKSPACE_BRANCH).toBe('main');
      expect(pty.env.WORKSPACE_LOCAL_PATH).toBe(pty.cwd);

      // cloneWorkspaceRepos was called
      expect(cloneWorkspaceRepos).toHaveBeenCalledTimes(1);
      const cloneArgs = vi.mocked(cloneWorkspaceRepos).mock.calls[0];
      expect(cloneArgs[0].repos[0].url).toBe('https://github.com/test-org/tui-repo');
      expect(cloneArgs[0].repos[0].branch).toBe('main');
    } finally {
      await mgr.shutdown();
    }
  });

  // ── Mount path: local_path exists on disk ─────────────────────────────────

  it('mounts existing local_path without cloning when directory exists', async () => {
    // Create a directory to simulate an existing checkout
    const localDir = path.join(TEST_ROOT, 'existing-repo');
    fs.mkdirSync(localDir, { recursive: true });

    // Create a repo with local_path pointing to the existing dir
    const repo = reposDAL.upsertRepoByCanonicalUrl(
      canonicalizeRepoUrl('https://github.com/test-org/local-mount.git'),
      { name: 'local-mount', origin: 'user_defined', owner_agent_id: agentId },
    );
    getDatabase().prepare(
      'UPDATE syncable_resources SET local_path = ? WHERE id = ?',
    ).run(localDir, repo.id);

    const mockPty = new MockPtyManager();
    const mgr = buildManager(mockPty);

    try {
      await mgr.spawn(agentId, { kind: 'claude-code', name: 'mount-test', repo_id: repo.id });

      expect(mockPty.captured).toHaveLength(1);
      const pty = mockPty.captured[0];

      // cwd should be the existing local directory
      expect(pty.cwd).toBe(localDir);

      // WORKSPACE_* env vars point to the local path
      expect(pty.env.WORKSPACE_REPO_URL).toBe('https://github.com/test-org/local-mount');
      expect(pty.env.WORKSPACE_LOCAL_PATH).toBe(localDir);

      // No clone was attempted
      expect(cloneWorkspaceRepos).not.toHaveBeenCalled();
    } finally {
      await mgr.shutdown();
    }
  });

  // ── No repo_id → unchanged behavior ───────────────────────────────────────

  it('uses dataDir as cwd when no repo_id is provided', async () => {
    const mockPty = new MockPtyManager();
    const mgr = buildManager(mockPty);

    try {
      await mgr.spawn(agentId, { kind: 'claude-code', name: 'no-repo-test' });

      expect(mockPty.captured).toHaveLength(1);
      const pty = mockPty.captured[0];

      // cwd should be the raw dataDir (no /repo suffix)
      expect(pty.cwd).not.toMatch(/\/repo$/);

      // No WORKSPACE_* env vars
      expect(pty.env.WORKSPACE_REPO_URL).toBeUndefined();
      expect(pty.env.WORKSPACE_BRANCH).toBeUndefined();
      expect(pty.env.WORKSPACE_LOCAL_PATH).toBeUndefined();

      // No clone
      expect(cloneWorkspaceRepos).not.toHaveBeenCalled();
    } finally {
      await mgr.shutdown();
    }
  });

  // ── Unknown repo_id → error ───────────────────────────────────────────────

  it('rejects with REPO_NOT_FOUND for unknown repo_id', async () => {
    const mockPty = new MockPtyManager();
    const mgr = buildManager(mockPty);

    try {
      await expect(
        mgr.spawn(agentId, { kind: 'claude-code', name: 'bad-repo', repo_id: 'repo_nonexistent' }),
      ).rejects.toMatchObject({
        code: 'REPO_NOT_FOUND',
        name: 'SwarmHostingError',
      });

      // PtyManager was never called
      expect(mockPty.captured).toHaveLength(0);
    } finally {
      await mgr.shutdown();
    }
  });

  // ── repo_id on provision config for audit ─────────────────────────────────

  it('persists repo_id on the hosted_swarm config for audit', async () => {
    const mockPty = new MockPtyManager();
    const mgr = buildManager(mockPty);

    try {
      const hosted = await mgr.spawn(agentId, {
        kind: 'claude-code',
        name: 'audit-test',
        repo_id: repoId,
      });

      const row = getDatabase().prepare(
        'SELECT config FROM hosted_swarms WHERE id = ?',
      ).get(hosted.id) as { config: string } | undefined;
      const config = JSON.parse(row!.config);
      expect(config.repo_id).toBe(repoId);
    } finally {
      await mgr.shutdown();
    }
  });
});
