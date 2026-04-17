import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { SwarmManager, SwarmHostingError } from '../../swarm/manager.js';
import * as swarmDAL from '../../swarm/dal.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('swarm-manager');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'swarm-manager-test.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-manager-data');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SLEEP_SCRIPT = path.join(FIXTURES_DIR, 'sleep-server.js');

function createTestConfig(overrides?: Partial<SwarmHostingConfig>): SwarmHostingConfig {
  return {
    enabled: true,
    default_provider: 'local',
    openswarm_command: `node ${SLEEP_SCRIPT}`,
    data_dir: TEST_DATA_DIR,
    port_range: [19100, 19110],
    max_swarms: 3,
    health_check_interval: 60000, // long interval so it doesn't interfere with tests
    max_health_failures: 3,
    auto_restart: false,
    max_restart_attempts: 3,
    ...overrides,
  };
}

describe('SwarmManager', () => {
  let agentId: string;
  let hiveAgentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const agentResult = await agentsDAL.createAgent({
      name: 'manager-test-agent',
      description: 'Agent for manager tests',
    });
    agentId = agentResult.agent.id;

    // Create a second agent for ownership tests
    const hiveAgentResult = await agentsDAL.createAgent({
      name: 'hive-owner-agent',
      description: 'Agent that owns a hive',
    });
    hiveAgentId = hiveAgentResult.agent.id;

    // Create a test hive
    hivesDAL.createHive({
      name: 'test-hive',
      description: 'A test hive for swarm manager tests',
      owner_id: hiveAgentId,
    });
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('spawn error paths', () => {
    it('should reject when max_swarms is reached', async () => {
      const config = createTestConfig({ max_swarms: 0 });
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        await expect(
          manager.spawn(agentId, { name: 'too-many' })
        ).rejects.toThrow(SwarmHostingError);

        await expect(
          manager.spawn(agentId, { name: 'too-many' })
        ).rejects.toThrow(/Maximum of 0/);
      } finally {
        await manager.shutdown();
      }
    });

    it('should reject for unsupported provider', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        await expect(
          manager.spawn(agentId, { name: 'bad-provider', provider: 'fly' })
        ).rejects.toThrow(/not configured/);
      } finally {
        await manager.shutdown();
      }
    });

    it('should reject when hive does not exist', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        await expect(
          manager.spawn(agentId, { name: 'bad-hive', hive: 'nonexistent-hive' })
        ).rejects.toThrow(/not found/i);
      } finally {
        await manager.shutdown();
      }
    });
  });

  describe('spawn with local provider', () => {
    it('should spawn a swarm and create DB record', async () => {
      // Use a process that stays alive but won't have health endpoint
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        // The spawn will partially succeed: process starts but health check will timeout
        // since our dummy process doesn't serve HTTP
        const hosted = await manager.spawn(agentId, {
          name: 'test-spawn-swarm',
          adapter: 'macro-agent',
        });

        expect(hosted).toBeDefined();
        expect(hosted.id).toMatch(/^hswarm_/);
        expect(hosted.provider).toBe('local');
        expect(hosted.spawned_by).toBe(agentId);
        // State will be unhealthy since our test process doesn't serve health
        expect(['running', 'unhealthy']).toContain(hosted.state);
        expect(hosted.assigned_port).toBeGreaterThanOrEqual(19100);
        expect(hosted.assigned_port).toBeLessThanOrEqual(19110);
      } finally {
        await manager.shutdown();
      }
    }, 35000);

    it('should allocate sequential ports', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        const hosted1 = await manager.spawn(agentId, { name: 'port-test-1' });
        const hosted2 = await manager.spawn(agentId, { name: 'port-test-2' });

        expect(hosted1.assigned_port).not.toBe(hosted2.assigned_port);
        expect(hosted1.assigned_port).toBeGreaterThanOrEqual(19100);
        expect(hosted2.assigned_port).toBeGreaterThanOrEqual(19100);
      } finally {
        await manager.shutdown();
      }
    }, 65000);

    it('should use default adapter when none specified', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        const hosted = await manager.spawn(agentId, { name: 'default-adapter-test' });

        expect(hosted.config).toBeDefined();
        expect(hosted.config!.adapter).toBe('macro-agent');
      } finally {
        await manager.shutdown();
      }
    }, 35000);
  });

  describe('stop', () => {
    it('should reject for non-existent hosted swarm', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        await expect(
          manager.stop('hswarm_nonexistent', agentId)
        ).rejects.toThrow(/not found/i);
      } finally {
        await manager.shutdown();
      }
    });

    it('should reject when caller is not the owner', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        const hosted = await manager.spawn(agentId, { name: 'ownership-test' });

        // Try to stop with a different agent
        await expect(
          manager.stop(hosted.id, hiveAgentId)
        ).rejects.toThrow(/not spawn/i);
      } finally {
        await manager.shutdown();
      }
    }, 35000);

    it('should stop a hosted swarm and update state', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        const hosted = await manager.spawn(agentId, { name: 'stop-test' });
        const stopped = await manager.stop(hosted.id, agentId);

        expect(stopped.state).toBe('stopped');
      } finally {
        await manager.shutdown();
      }
    }, 40000);
  });

  describe('getLogs', () => {
    it('should reject for non-existent hosted swarm', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        await expect(
          manager.getLogs('hswarm_nonexistent', agentId)
        ).rejects.toThrow(/not found/i);
      } finally {
        await manager.shutdown();
      }
    });

    it('should reject when caller is not the owner', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        const hosted = await manager.spawn(agentId, { name: 'logs-owner-test' });

        await expect(
          manager.getLogs(hosted.id, hiveAgentId)
        ).rejects.toThrow(/not spawn/i);
      } finally {
        await manager.shutdown();
      }
    }, 35000);
  });

  describe('restart', () => {
    it('should reject for non-existent hosted swarm', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        await expect(
          manager.restart('hswarm_nonexistent', agentId)
        ).rejects.toThrow(/not found/i);
      } finally {
        await manager.shutdown();
      }
    });

    it('preserves bootstrap config across cold restart', async () => {
      // bootstrap.coordinator + bootstrap.cwd live on the persisted hosted
      // swarm row's `config` JSON. After stop+restart (cold path), the
      // re-provision must read them back so the env-var bridge fires
      // again and the auto-coordinator spawns. Without this, an
      // auto-spawn-on-startup setting would silently de-activate after
      // the first stop/restart cycle.
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        const hosted = await manager.spawn(agentId, {
          name: 'bootstrap-restart-test',
          bootstrap: { coordinator: true, cwd: '/some/project' },
        });
        expect(hosted.state).toBe('running');

        // Verify bootstrap was persisted in the DB row.
        const persisted = swarmDAL.findHostedSwarmById(hosted.id);
        expect(persisted?.config?.bootstrap).toEqual({
          coordinator: true,
          cwd: '/some/project',
        });

        await manager.stop(hosted.id, agentId);

        const revived = await manager.restart(hosted.id, agentId);
        expect(revived.state).toBe('running');

        // Bootstrap field survives the round trip — the re-provisioned
        // openswarm process gets the same env vars exported.
        const afterRestart = swarmDAL.findHostedSwarmById(hosted.id);
        expect(afterRestart?.config?.bootstrap).toEqual({
          coordinator: true,
          cwd: '/some/project',
        });
      } finally {
        await manager.shutdown();
      }
    }, 60000);

    it('cold-starts a stopped swarm by re-provisioning from persisted config', async () => {
      // This exercises the path where stop() has cleared the in-memory instance
      // tracking, so provider.restart() is unavailable. restart() must fall
      // through to provider.provision(hosted.config) using the saved bootstrap
      // token + port + adapter. Before this fix, restart() errored with
      // "No tracked instance to restart" — making stop/resume cycles impossible
      // via the UI and blocking /sessions/:id/resume for stopped swarms.
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        const hosted = await manager.spawn(agentId, { name: 'cold-start-test' });
        expect(hosted.state).toBe('running');
        const firstPid = hosted.pid;
        expect(firstPid).toBeGreaterThan(0);

        await manager.stop(hosted.id, agentId);
        const afterStop = swarmDAL.findHostedSwarmById(hosted.id);
        expect(afterStop?.state).toBe('stopped');

        // Restart from cold. The in-memory instance tracking was cleared by
        // stop(), so this forces the cold-start branch.
        const revived = await manager.restart(hosted.id, agentId);
        expect(revived.state).toBe('running');
        expect(revived.pid).toBeGreaterThan(0);
        expect(revived.pid).not.toBe(firstPid); // fresh process
      } finally {
        await manager.shutdown();
      }
    }, 60000);
  });

  describe('health monitor', () => {
    it('should start and stop the health monitor without error', async () => {
      const config = createTestConfig({ health_check_interval: 100000 });
      const manager = new SwarmManager(config, 'http://localhost:3000');

      // Should not throw
      manager.startHealthMonitor();
      manager.stopHealthMonitor();

      await manager.shutdown();
    });

    it('should not start duplicate monitors', () => {
      const config = createTestConfig({ health_check_interval: 100000 });
      const manager = new SwarmManager(config, 'http://localhost:3000');

      manager.startHealthMonitor();
      manager.startHealthMonitor(); // Should be a no-op

      manager.stopHealthMonitor();
    });
  });

  describe('shutdown', () => {
    it('should stop health monitor and all processes on shutdown', async () => {
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      manager.startHealthMonitor();

      // Shutdown should not throw
      await manager.shutdown();
    });
  });
});

describe('SwarmHostingError', () => {
  it('should have code and message', () => {
    const error = new SwarmHostingError('NOT_FOUND', 'Hosted swarm not found');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Hosted swarm not found');
    expect(error.name).toBe('SwarmHostingError');
    expect(error instanceof Error).toBe(true);
  });
});
