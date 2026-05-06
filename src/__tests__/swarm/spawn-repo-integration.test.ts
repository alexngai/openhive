/**
 * Slice 6 — swarm spawn integration with `kinds/repo`.
 *
 * Verifies:
 *   - `spawn(input.repo_id)` resolves the repo and injects WORKSPACE_*
 *     env vars into the provision config's `resolved_credentials`.
 *   - `spawn(input.workspace_policy)` persists the policy JSON on the
 *     pre-registered `map_swarms.workspace_policy` column.
 *   - Spawn without these fields is unchanged (no env injection, no policy).
 *   - Unknown repo_id rejects with REPO_NOT_FOUND.
 *
 * Uses a stub provider that captures `provision()` arguments rather than
 * actually spawning subprocesses. Real spawn lifecycle is exercised by
 * `e2e.test.ts`; this test isolates the input → provision-config wiring.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as path from 'path';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as repos from '../../db/dal/repos.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { SwarmManager, SwarmHostingError } from '../../swarm/manager.js';
import type {
  HostingProvider,
  HostingProviderType,
  SwarmProvisionConfig,
  ProvisionResult,
  InstanceStatus,
  LogOptions,
} from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_ROOT = testRoot('spawn-repo-integration');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'spawn-repo-integration.db');

// ── Stub provider ────────────────────────────────────────────────────────────

class StubProvider implements HostingProvider {
  readonly type: HostingProviderType = 'local';
  capturedConfigs: SwarmProvisionConfig[] = [];

  async provision(config: SwarmProvisionConfig): Promise<ProvisionResult> {
    this.capturedConfigs.push(config);
    return {
      instance_id: `stub_${config.assigned_port}`,
      state: 'running',
      pid: 12345,
      endpoint: `ws://127.0.0.1:${config.assigned_port}`,
    };
  }

  async stop(_instanceId: string): Promise<void> {}
  async restart(_instanceId: string): Promise<void> {}
  async getStatus(_instanceId: string): Promise<InstanceStatus> {
    return { state: 'running' };
  }
  async getLogs(_instanceId: string, _options?: LogOptions): Promise<string> {
    return '';
  }
  async cleanup(): Promise<void> {}
}

function buildManager(stub: StubProvider): SwarmManager {
  const config = {
    enabled: true,
    default_provider: 'local' as const,
    openswarm_command: 'true',  // unused — provider is stubbed
    data_dir: path.join(TEST_ROOT, 'data'),
    port_range: [40000, 40100] as [number, number],
    max_swarms: 10,
    health_check_interval: 60_000,
    max_health_failures: 3,
    auto_restart: false,
    max_restart_attempts: 0,
  };
  const mgr = new SwarmManager(config, 'http://127.0.0.1:0');
  // Replace the auto-built local provider with our stub. SwarmManager's
  // `providers` field is private; cast to access for test isolation.
  (mgr as unknown as { providers: Map<string, unknown> }).providers.set('local', stub);
  // The real `waitForHealth` opens a WebSocket against the assigned port to
  // verify the spawned process is up. Our stub doesn't actually listen, so
  // short-circuit to keep the tests fast (~ms instead of 30s).
  (mgr as unknown as { waitForHealth: (port: number, timeoutMs: number) => Promise<boolean> })
    .waitForHealth = async () => true;
  return mgr;
}

// ── Test setup ───────────────────────────────────────────────────────────────

describe('swarm spawn — repo_id + workspace_policy integration', () => {
  let ownerAgentId: string;
  let repoId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initTokenService(undefined, TEST_ROOT);
    const { agent } = await agentsDAL.createAgent({
      name: 'spawn-test-owner',
      is_admin: true,
    });
    ownerAgentId = agent.id;

    // Seed a repo resource we can target with repo_id
    const identity = canonicalizeRepoUrl('https://github.com/foo/bar');
    const repo = repos.upsertRepoByCanonicalUrl(identity, {
      origin: 'user_defined',
      owner_agent_id: ownerAgentId,
      default_branch: 'main',
    });
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
      `DELETE FROM map_swarms WHERE id NOT IN (SELECT id FROM hosted_swarms)`,
    ).run();
  });

  // ── repo_id injects WORKSPACE_* env ──────────────────────────────────────

  it('spawn with repo_id injects WORKSPACE_REPO_URL/BRANCH/LOCAL_PATH into resolved_credentials', async () => {
    const stub = new StubProvider();
    const mgr = buildManager(stub);

    const hosted = await mgr.spawn(ownerAgentId, {
      name: 'with-repo',
      repo_id: repoId,
    });

    expect(stub.capturedConfigs).toHaveLength(1);
    const provisioned = stub.capturedConfigs[0]!;
    const env = provisioned.resolved_credentials!;
    expect(env.WORKSPACE_REPO_URL).toBe('https://github.com/foo/bar');
    expect(env.WORKSPACE_BRANCH).toBe('main');
    // Default clone path is `${dataDir}/repo`
    expect(env.WORKSPACE_LOCAL_PATH).toBe(path.join(provisioned.data_dir, 'repo'));

    expect(hosted.id).toBeTruthy();
  });

  it('spawn without repo_id leaves resolved_credentials free of WORKSPACE_* keys', async () => {
    const stub = new StubProvider();
    const mgr = buildManager(stub);

    await mgr.spawn(ownerAgentId, { name: 'no-repo' });

    const provisioned = stub.capturedConfigs[0]!;
    const env = provisioned.resolved_credentials ?? {};
    expect(env.WORKSPACE_REPO_URL).toBeUndefined();
    expect(env.WORKSPACE_BRANCH).toBeUndefined();
    expect(env.WORKSPACE_LOCAL_PATH).toBeUndefined();
  });

  it('spawn with unknown repo_id throws SwarmHostingError REPO_NOT_FOUND', async () => {
    const stub = new StubProvider();
    const mgr = buildManager(stub);

    await expect(
      mgr.spawn(ownerAgentId, { name: 'bogus', repo_id: 'repo_nonexistent' }),
    ).rejects.toBeInstanceOf(SwarmHostingError);

    // Ensure the provider was never called (early bail before provision)
    expect(stub.capturedConfigs).toHaveLength(0);
  });

  it('spawn with a non-repo resource_type rejects', async () => {
    const stub = new StubProvider();
    const mgr = buildManager(stub);

    // Find a non-repo resource by scoping to an existing one
    // (none exist by default; insert a session resource as a stub)
    const db = getDatabase();
    db.prepare(`
      INSERT INTO syncable_resources (id, resource_type, name, git_remote_url, owner_agent_id)
      VALUES ('res_bogus', 'session', 'bogus-session', 'map://session/x', ?)
    `).run(ownerAgentId);

    await expect(
      mgr.spawn(ownerAgentId, { name: 'wrong-type', repo_id: 'res_bogus' }),
    ).rejects.toBeInstanceOf(SwarmHostingError);
  });

  // ── workspace_policy persistence ─────────────────────────────────────────

  it('spawn with workspace_policy persists policy on map_swarms', async () => {
    const stub = new StubProvider();
    const mgr = buildManager(stub);

    const policy = {
      mode: 'allow_listed' as const,
      allowed_repos: ['https://github.com/foo/bar', 'https://github.com/foo/baz'],
    };
    const hosted = await mgr.spawn(ownerAgentId, {
      name: 'with-policy',
      workspace_policy: policy,
    });

    // Look up the corresponding map_swarms row
    const provisioned = stub.capturedConfigs[0]!;
    const swarmEndpoint = `ws://127.0.0.1:${provisioned.assigned_port}`;
    const row = getDatabase().prepare(
      'SELECT workspace_policy FROM map_swarms WHERE map_endpoint = ?',
    ).get(swarmEndpoint) as { workspace_policy: string | null } | undefined;
    expect(row?.workspace_policy).toBeDefined();
    expect(JSON.parse(row!.workspace_policy!)).toEqual(policy);

    expect(hosted.id).toBeTruthy();
  });

  it('spawn without workspace_policy leaves the column null', async () => {
    const stub = new StubProvider();
    const mgr = buildManager(stub);

    await mgr.spawn(ownerAgentId, { name: 'no-policy' });

    const provisioned = stub.capturedConfigs[0]!;
    const swarmEndpoint = `ws://127.0.0.1:${provisioned.assigned_port}`;
    const row = getDatabase().prepare(
      'SELECT workspace_policy FROM map_swarms WHERE map_endpoint = ?',
    ).get(swarmEndpoint) as { workspace_policy: string | null } | undefined;
    expect(row?.workspace_policy).toBeNull();
  });

  // ── repo_id + workspace_policy together ──────────────────────────────────

  it('spawn with both repo_id and workspace_policy injects env AND persists policy', async () => {
    const stub = new StubProvider();
    const mgr = buildManager(stub);

    const policy = {
      mode: 'pinned' as const,
      pinned_repo: 'https://github.com/foo/bar',
    };
    await mgr.spawn(ownerAgentId, {
      name: 'with-both',
      repo_id: repoId,
      workspace_policy: policy,
    });

    const provisioned = stub.capturedConfigs[0]!;
    expect(provisioned.resolved_credentials!.WORKSPACE_REPO_URL).toBe(
      'https://github.com/foo/bar',
    );

    const row = getDatabase().prepare(
      'SELECT workspace_policy FROM map_swarms WHERE map_endpoint = ?',
    ).get(`ws://127.0.0.1:${provisioned.assigned_port}`) as
      | { workspace_policy: string | null }
      | undefined;
    expect(JSON.parse(row!.workspace_policy!)).toEqual(policy);
  });

  // ── repo_id is echoed onto SwarmProvisionConfig ──────────────────────────

  it('echoes repo_id and workspace_policy onto SwarmProvisionConfig for audit', async () => {
    const stub = new StubProvider();
    const mgr = buildManager(stub);

    const policy = { mode: 'open' as const };
    await mgr.spawn(ownerAgentId, {
      name: 'echo-test',
      repo_id: repoId,
      workspace_policy: policy,
    });

    const provisioned = stub.capturedConfigs[0]!;
    expect(provisioned.repo_id).toBe(repoId);
    expect(provisioned.workspace_policy).toEqual(policy);
  });
});
