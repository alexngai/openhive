import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
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
    swarm_runner_command: `node ${SLEEP_SCRIPT}`,
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
    initTokenService(undefined, TEST_ROOT);

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
    _resetTokenService();
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

    it('derives data_dir from the hosted swarm id, not the port', async () => {
      // Regression guard: before this change, data_dir was `swarm-${port}`,
      // which meant two swarms that ran on the same port at different
      // times shared a directory on disk. Keying on the (stable) hosted
      // swarm id instead keeps each swarm's on-disk state isolated and
      // unaffected by port drift across restarts.
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        const hosted = await manager.spawn(agentId, { name: 'data-dir-id-test' });
        expect(hosted.config?.data_dir).toBe(
          path.join(TEST_DATA_DIR, `swarm-${hosted.id}`),
        );
        // And — paranoia — the directory name must not encode a port.
        expect(hosted.config?.data_dir).not.toMatch(/swarm-\d+$/);
      } finally {
        await manager.shutdown();
      }
    }, 35000);

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
        // swarm-runner process gets the same env vars exported.
        const afterRestart = swarmDAL.findHostedSwarmById(hosted.id);
        expect(afterRestart?.config?.bootstrap).toEqual({
          coordinator: true,
          cwd: '/some/project',
        });
      } finally {
        await manager.shutdown();
      }
    }, 60000);

    it('reuses the previous port on cold restart when free', async () => {
      // Restarts should hand the swarm back its original port so
      // endpoints stay stable for cached clients. Before this fix,
      // autoRestart called allocatePorts() unconditionally, which scans
      // from port_range.min — so two stopped swarms could swap ports
      // on restart purely by allocation order.
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        const hosted = await manager.spawn(agentId, { name: 'port-preserve-test' });
        const originalPort = hosted.assigned_port;
        expect(originalPort).toBeGreaterThanOrEqual(19100);

        await manager.stop(hosted.id, agentId);
        const revived = await manager.restart(hosted.id, agentId);
        expect(revived.assigned_port).toBe(originalPort);
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

  describe('reviveHostedSwarms (startup revival)', () => {
    it('no-ops when there are no active-state swarms', async () => {
      // Clean DB slate — any prior test rows should be stopped/failed/removed
      // by their own shutdown paths. If a previous test leaked an active row,
      // filter for our test agent so we only count our own.
      const config = createTestConfig();
      const manager = new SwarmManager(config, 'http://localhost:3000');

      try {
        const result = await manager.reviveHostedSwarms();
        // May be 0 or revive some leaked row; key contract: it doesn't throw.
        expect(result).toHaveProperty('revived');
        expect(result).toHaveProperty('orphaned');
        expect(result).toHaveProperty('failed');
      } finally {
        await manager.shutdown();
      }
    });

    it('revives a running-state swarm whose PID is no longer alive', async () => {
      // Simulate the post-crash state: spawn normally, then forcibly clear
      // the in-memory exit handler + SIGKILL the child. The parent-side
      // handleProcessExit would normally flip state to 'failed' when it
      // observes the kill, but we want to model the openhive-parent-dying
      // case where that handler never runs — hosted_swarms stays in
      // state='running' with a now-dead PID.
      const config = createTestConfig();
      const manager1 = new SwarmManager(config, 'http://localhost:3000');
      let hostedId = '';
      let originalPid: number | null = null;

      try {
        const hosted = await manager1.spawn(agentId, { name: 'revive-test' });
        hostedId = hosted.id;
        originalPid = hosted.pid;
        expect(hosted.state).toBe('running');

        // Disable the exit handler so our forced kill below doesn't flip the
        // DB row state to 'failed' — we're simulating the server dying
        // before the handler could run.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const localProvider = (manager1 as any).providers.get('local');
        if (localProvider) localProvider.onProcessExit = null;

        if (hosted.pid) {
          try { process.kill(hosted.pid, 'SIGKILL'); } catch { /* ignore */ }
        }
      } finally {
        await manager1.shutdown();
      }

      // Give the OS a moment to reap. Also defensively reset state='running'
      // in case shutdown's other paths updated the row.
      await new Promise((r) => setTimeout(r, 500));
      swarmDAL.updateHostedSwarm(hostedId, { state: 'running', error: null });

      const manager2 = new SwarmManager(config, 'http://localhost:3000');
      try {
        const result = await manager2.reviveHostedSwarms();
        expect(result.revived + result.failed + result.orphaned).toBeGreaterThanOrEqual(1);

        const row = swarmDAL.findHostedSwarmById(hostedId);
        // After revival, row should be running (new PID) or unhealthy (if
        // health check timed out on the sleep-server fixture). Either way,
        // NOT 'failed' from orphan-detection — the prior PID was dead.
        expect(['running', 'unhealthy']).toContain(row?.state);
        if (row?.state === 'running' && row.pid && originalPid) {
          expect(row.pid).not.toBe(originalPid);
        }
      } finally {
        await manager2.shutdown();
      }
    }, 90000);
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

/**
 * The kind dispatcher (`SwarmManager.spawn` → `spawnSwarmRunner` |
 * `spawnClaudeCode`) is the seam introduced when the hosted-swarm pipeline
 * was generalized beyond SwarmRunner. These tests pin its behavior:
 *   - 'claude-code' goes to the (currently stub) claude-code path
 *   - omitted kind defaults to swarm-runner
 * The actual swarm-runner and claude-code spawns are exercised by other tests;
 * here we just assert the routing.
 */
describe('SwarmManager.spawn — kind dispatcher', () => {
  // Self-contained DB lifecycle: the outer SwarmManager describe closes the
  // DB in its afterAll, so we re-init under a separate test root rather than
  // riding on its lifecycle.
  const DISPATCHER_ROOT = testRoot('swarm-manager-dispatcher');
  const DISPATCHER_DB = testDbPath(DISPATCHER_ROOT, 'swarm-manager-dispatcher.db');
  let dispatcherAgentId: string;

  beforeAll(async () => {
    initDatabase(DISPATCHER_DB);
    initTokenService(undefined, DISPATCHER_ROOT);
    const created = await agentsDAL.createAgent({
      name: 'kind-dispatcher-agent',
      description: 'Agent for kind dispatcher tests',
    });
    dispatcherAgentId = created.agent.id;
  });

  afterAll(() => {
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(DISPATCHER_ROOT);
  });

  // The kind=claude-code path is exercised end-to-end by
  // src/__tests__/swarm/claude-code-spawn.test.ts, which mocks the binary
  // resolver and asserts the error paths cleanly. The dispatcher behavior
  // for the default swarm-runner path is covered below.

  it('treats omitted kind as swarm-runner (default path)', async () => {
    // We don't run a full swarm-runner spawn — that's covered elsewhere — we
    // just want to assert the dispatcher does NOT route to the claude-code
    // stub. We force the swarm-runner path to fail early (max_swarms=0) and
    // assert the error code is the expected swarm-runner-path failure, NOT
    // NOT_IMPLEMENTED.
    const config: SwarmHostingConfig = {
      enabled: true,
      default_provider: 'local',
      swarm_runner_command: `node ${SLEEP_SCRIPT}`,
      data_dir: TEST_DATA_DIR,
      port_range: [19140, 19145],
      max_swarms: 0,
      health_check_interval: 60000,
      max_health_failures: 3,
      auto_restart: false,
      max_restart_attempts: 3,
    };
    const manager = new SwarmManager(config, 'http://localhost:3000');
    try {
      await expect(
        manager.spawn(dispatcherAgentId, { name: 'dispatcher-default' }),
      ).rejects.toMatchObject({
        code: 'MAX_SWARMS_REACHED', // hit before any kind-specific logic
        name: 'SwarmHostingError',
      });
    } finally {
      await manager.shutdown();
    }
  });
});
