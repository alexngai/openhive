/**
 * Unit test: openswarm spawn path with repo_id (env-var injection only).
 *
 * Openswarm spawns route through LocalProvider, which copies
 * `config.resolved_credentials` into the child process env. The TUI
 * Phase 3c work also gave openswarm a `repo_id` resolution step:
 *
 *   1. resolveRepoForSpawn → applyRepoEnvVars(credentialOverlay, …)
 *   2. credentialOverlay flows into provisionConfig.resolved_credentials
 *   3. LocalProvider.provision merges resolved_credentials into env
 *
 * Unlike the TUI path, openswarm does NOT clone or override cwd — the
 * spawned sidecar reads WORKSPACE_* on connect and emits
 * `x-workspace/repo.declare` itself.
 *
 * This test pins steps 1+2: the env vars land on the provisionConfig
 * that LocalProvider sees, and `repo_id` itself is persisted on the
 * hosted_swarm config for audit. Step 3 is covered by LocalProvider's
 * own tests (resolved_credentials → process.env merge).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as reposDAL from '../../db/dal/repos.js';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { SwarmManager } from '../../swarm/manager.js';
import type { SwarmHostingConfig, SwarmProvisionConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('openswarm-repo-spawn');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'openswarm-repo-spawn.db');
const TEST_DATA_DIR = `${TEST_ROOT}/data`;

// ── Mock provider ───────────────────────────────────────────────────────────

interface CapturedProvision {
  config: SwarmProvisionConfig;
}

class MockLocalProvider extends EventEmitter {
  captured: CapturedProvision[] = [];
  onProcessExit?: (instanceId: string, code: number | null, signal: string | null) => void;

  async provision(config: SwarmProvisionConfig) {
    this.captured.push({ config });
    return {
      instance_id: `mock_${Date.now()}`,
      pid: 99999,
      logs_path: undefined,
    };
  }
  async deprovision() {}
  async healthCheck() { return { healthy: true } as const; }
  async restart(config: SwarmProvisionConfig) { return this.provision(config); }
  async listInstances() { return []; }
  async shutdown() {}
}

function makeConfig(): SwarmHostingConfig {
  return {
    enabled: true,
    default_provider: 'local',
    openswarm_command: 'echo unused',
    data_dir: TEST_DATA_DIR,
    port_range: [19500, 19510],
    max_swarms: 5,
    health_check_interval: 60_000,
    max_health_failures: 3,
    auto_restart: false,
    max_restart_attempts: 0,
  };
}

function buildManager(mockProvider: MockLocalProvider): SwarmManager {
  const mgr = new SwarmManager(makeConfig(), 'http://127.0.0.1:0');
  // Replace the registered 'local' provider with our mock.
  (mgr as any).providers.set('local', mockProvider);
  // Skip the 30s waitForHealth that polls the assigned port — there's no
  // real openswarm process behind the mock provider, so health never
  // succeeds. The path under test (repo_id → provisionConfig) finishes
  // before waitForHealth runs.
  (mgr as any).waitForHealth = async () => true;
  return mgr;
}

// ── Setup ────────────────────────────────────────────────────────────────────

describe('openswarm spawn — repo_id env-var injection', () => {
  let agentId: string;
  let repoId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initTokenService(undefined, TEST_ROOT);

    const { agent } = await agentsDAL.createAgent({
      name: 'openswarm-repo-spawn-agent',
      is_admin: true,
    });
    agentId = agent.id;

    const repo = reposDAL.upsertRepoByCanonicalUrl(
      canonicalizeRepoUrl('https://github.com/test-org/openswarm-repo.git'),
      {
        name: 'openswarm-repo',
        origin: 'user_defined',
        owner_agent_id: agentId,
        default_branch: 'main',
      },
    );
    repoId = repo.id;
  });

  afterAll(() => {
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM hosted_swarms').run();
    db.prepare(
      'DELETE FROM map_swarms WHERE id NOT IN (SELECT id FROM hosted_swarms)',
    ).run();
  });

  // ── Env-var injection ─────────────────────────────────────────────────────

  it('injects WORKSPACE_* env vars into provisionConfig.resolved_credentials when repo_id is supplied', async () => {
    const mockProvider = new MockLocalProvider();
    const mgr = buildManager(mockProvider);

    try {
      await mgr.spawn(agentId, {
        kind: 'openswarm',
        name: 'env-test',
        repo_id: repoId,
      });

      expect(mockProvider.captured).toHaveLength(1);
      const config = mockProvider.captured[0].config;

      // Provider sees the env vars in resolved_credentials.
      const creds = config.resolved_credentials ?? {};
      expect(creds.WORKSPACE_REPO_URL).toBe('https://github.com/test-org/openswarm-repo');
      expect(creds.WORKSPACE_BRANCH).toBe('main');
      expect(creds.WORKSPACE_LOCAL_PATH).toBeTruthy();

      // No clone happens at the manager level — workspace.repos stays unset.
      // (LocalProvider would clone if config.workspace.repos existed; openswarm
      //  with bare repo_id leaves cloning to the sidecar.)
      expect(config.workspace).toBeUndefined();
    } finally {
      await mgr.shutdown();
    }
  });

  // ── repo_id persisted on config for audit ─────────────────────────────────

  it('persists repo_id on the hosted_swarm config for audit', async () => {
    const mockProvider = new MockLocalProvider();
    const mgr = buildManager(mockProvider);

    try {
      const hosted = await mgr.spawn(agentId, {
        kind: 'openswarm',
        name: 'audit-test',
        repo_id: repoId,
      });

      const row = getDatabase().prepare(
        'SELECT config FROM hosted_swarms WHERE id = ?',
      ).get(hosted.id) as { config: string } | undefined;
      const cfg = JSON.parse(row!.config);
      expect(cfg.repo_id).toBe(repoId);
    } finally {
      await mgr.shutdown();
    }
  });

  // ── Unknown repo_id rejection ─────────────────────────────────────────────

  it('rejects with REPO_NOT_FOUND for unknown repo_id and never calls the provider', async () => {
    const mockProvider = new MockLocalProvider();
    const mgr = buildManager(mockProvider);

    try {
      await expect(
        mgr.spawn(agentId, {
          kind: 'openswarm',
          name: 'bad-repo',
          repo_id: 'repo_nonexistent',
        }),
      ).rejects.toMatchObject({
        code: 'REPO_NOT_FOUND',
        name: 'SwarmHostingError',
      });

      expect(mockProvider.captured).toHaveLength(0);
    } finally {
      await mgr.shutdown();
    }
  });

  // ── No repo_id → no WORKSPACE_* env vars ──────────────────────────────────

  it('does not inject WORKSPACE_* env vars when repo_id is absent', async () => {
    const mockProvider = new MockLocalProvider();
    const mgr = buildManager(mockProvider);

    try {
      await mgr.spawn(agentId, {
        kind: 'openswarm',
        name: 'no-repo',
      });

      expect(mockProvider.captured).toHaveLength(1);
      const creds = mockProvider.captured[0].config.resolved_credentials ?? {};
      expect(creds.WORKSPACE_REPO_URL).toBeUndefined();
      expect(creds.WORKSPACE_BRANCH).toBeUndefined();
      expect(creds.WORKSPACE_LOCAL_PATH).toBeUndefined();
    } finally {
      await mgr.shutdown();
    }
  });

  // ── Authorization: stranger cannot spawn against another agent's repo ────

  it('rejects with REPO_NOT_FOUND when the spawning agent has no access to the repo', async () => {
    // Pre-existing repo is owned by `agentId` (set up in beforeAll). A
    // second agent that doesn't own it and isn't subscribed should not be
    // able to spawn against the repo_id, even if they know the id.
    const { agent: stranger } = await agentsDAL.createAgent({
      name: 'openswarm-repo-stranger',
    });
    const mockProvider = new MockLocalProvider();
    const mgr = buildManager(mockProvider);

    try {
      await expect(
        mgr.spawn(stranger.id, {
          kind: 'openswarm',
          name: 'stranger-spawn',
          repo_id: repoId,
        }),
      ).rejects.toMatchObject({
        code: 'REPO_NOT_FOUND',
        name: 'SwarmHostingError',
      });

      // Provider should never be invoked for an unauthorized repo_id.
      expect(mockProvider.captured).toHaveLength(0);
    } finally {
      await mgr.shutdown();
    }
  });
});
