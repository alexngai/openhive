/**
 * Unit test: `runner` sub-discriminator on kind=swarm-runner.
 *
 * The manager resolves `input.runner` to a spawn command:
 *   - default / 'swarmkit' → the configured swarm_runner_command (no override)
 *   - a name in swarmHosting.runners → passed to the provider as
 *     `swarm_runner_command_override` + recorded on map_swarms.metadata.runner
 *   - an unknown name → throws UNKNOWN_RUNNER before provisioning
 *
 * Uses a mock provider that captures the provisionConfig (mirrors
 * swarm-runner-repo-spawn.test.ts) so no real process is spawned.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { SwarmManager } from '../../swarm/manager.js';
import type { SwarmHostingConfig, SwarmProvisionConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('runner-selection');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'runner-selection.db');
const TEST_DATA_DIR = `${TEST_ROOT}/data`;

class MockLocalProvider extends EventEmitter {
  captured: { config: SwarmProvisionConfig }[] = [];
  onProcessExit?: (instanceId: string, code: number | null, signal: string | null) => void;
  async provision(config: SwarmProvisionConfig) {
    this.captured.push({ config });
    return { instance_id: `mock_${this.captured.length}`, pid: 99999, logs_path: undefined };
  }
  async deprovision() {}
  async healthCheck() { return { healthy: true } as const; }
  async restart(config: SwarmProvisionConfig) { return this.provision(config); }
  async listInstances() { return []; }
  async shutdown() {}
}

function makeConfig(runners?: Record<string, string>): SwarmHostingConfig {
  return {
    enabled: true,
    default_provider: 'local',
    swarm_runner_command: 'echo unused',
    runners: runners ?? { openswarm: 'echo openswarm-runner' },
    data_dir: TEST_DATA_DIR,
    port_range: [19560, 19580],
    max_swarms: 5,
    health_check_interval: 60_000,
    max_health_failures: 3,
    auto_restart: false,
    max_restart_attempts: 0,
  };
}

function buildManager(mockProvider: MockLocalProvider, runners?: Record<string, string>): SwarmManager {
  const mgr = new SwarmManager(makeConfig(runners), 'http://127.0.0.1:0');
  (mgr as any).providers.set('local', mockProvider);
  (mgr as any).waitForHealth = async () => true;
  return mgr;
}

describe('runner selection — kind=swarm-runner', () => {
  let agentId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initTokenService(undefined, TEST_ROOT);
    const { agent } = await agentsDAL.createAgent({ name: 'runner-selection-agent', is_admin: true });
    agentId = agent.id;
  });

  afterAll(() => {
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM hosted_swarms').run();
    db.prepare('DELETE FROM map_swarms WHERE id NOT IN (SELECT id FROM hosted_swarms)').run();
  });

  it('default runner: no swarm_runner_command_override, no metadata.runner', async () => {
    const provider = new MockLocalProvider();
    const mgr = buildManager(provider);
    try {
      const hosted = await mgr.spawn(agentId, { kind: 'swarm-runner', name: 'default-runner' });
      expect(provider.captured).toHaveLength(1);
      expect(provider.captured[0].config.swarm_runner_command_override).toBeUndefined();

      const row = getDatabase()
        .prepare('SELECT metadata FROM map_swarms WHERE id = ?')
        .get(hosted.swarm_id) as { metadata: string | null } | undefined;
      const meta = row?.metadata ? JSON.parse(row.metadata) : {};
      expect(meta.runner).toBeUndefined();
    } finally {
      await mgr.shutdown();
    }
  });

  it("runner='openswarm': passes the override + records metadata.runner", async () => {
    const provider = new MockLocalProvider();
    const mgr = buildManager(provider);
    try {
      const hosted = await mgr.spawn(agentId, {
        kind: 'swarm-runner',
        name: 'osw-runner',
        runner: 'openswarm',
      });
      expect(provider.captured[0].config.swarm_runner_command_override).toBe('echo openswarm-runner');

      const row = getDatabase()
        .prepare('SELECT metadata FROM map_swarms WHERE id = ?')
        .get(hosted.swarm_id) as { metadata: string | null } | undefined;
      expect(JSON.parse(row!.metadata!).runner).toBe('openswarm');
    } finally {
      await mgr.shutdown();
    }
  });

  it('honors a custom runner from swarmHosting.runners', async () => {
    const provider = new MockLocalProvider();
    const mgr = buildManager(provider, { myrunner: 'node /opt/my-runner.js host' });
    try {
      await mgr.spawn(agentId, { kind: 'swarm-runner', name: 'custom', runner: 'myrunner' });
      expect(provider.captured[0].config.swarm_runner_command_override).toBe('node /opt/my-runner.js host');
    } finally {
      await mgr.shutdown();
    }
  });

  it('rejects an unknown runner with UNKNOWN_RUNNER and never provisions', async () => {
    const provider = new MockLocalProvider();
    const mgr = buildManager(provider);
    try {
      await expect(
        mgr.spawn(agentId, { kind: 'swarm-runner', name: 'bad', runner: 'nope' }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_RUNNER', name: 'SwarmHostingError' });
      expect(provider.captured).toHaveLength(0);
    } finally {
      await mgr.shutdown();
    }
  });

  it("treats runner='swarmkit' as the default (no override)", async () => {
    const provider = new MockLocalProvider();
    const mgr = buildManager(provider);
    try {
      await mgr.spawn(agentId, { kind: 'swarm-runner', name: 'explicit-default', runner: 'swarmkit' });
      expect(provider.captured[0].config.swarm_runner_command_override).toBeUndefined();
    } finally {
      await mgr.shutdown();
    }
  });
});
