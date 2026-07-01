import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LocalProvider } from '../../swarm/providers/local.js';
import { SandboxedLocalProvider } from '../../swarm/providers/sandboxed-local.js';
import { testRoot, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('swarm-provider');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SLEEP_SCRIPT = path.join(FIXTURES_DIR, 'sleep-server.js');
const FAIL_SCRIPT = path.join(FIXTURES_DIR, 'exit-immediately.js');
const ENV_DUMP_SCRIPT = path.join(FIXTURES_DIR, 'env-dump.js');

/**
 * Provision a child via the env-dump fixture and return the env vars it captured.
 * Used to verify provider env propagation without modifying production code.
 */
async function captureProvisionedEnv(
  provider: LocalProvider | SandboxedLocalProvider,
  config: Parameters<typeof provider.provision>[0],
  testCaseDir: string,
): Promise<Record<string, string | null>> {
  fs.mkdirSync(testCaseDir, { recursive: true });
  const dumpPath = path.join(testCaseDir, 'env.json');
  // Pass the dump path through process.env so the fixture sees it via inheritance.
  const prevDump = process.env.MACRO_TEST_ENV_DUMP;
  process.env.MACRO_TEST_ENV_DUMP = dumpPath;
  try {
    const result = await provider.provision(config);
    // Wait for the fixture to write the file.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (fs.existsSync(dumpPath)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(dumpPath)).toBe(true);
    const captured = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
    await provider.deprovision(result.instance_id);
    return captured;
  } finally {
    if (prevDump === undefined) delete process.env.MACRO_TEST_ENV_DUMP;
    else process.env.MACRO_TEST_ENV_DUMP = prevDump;
  }
}

describe('LocalProvider', () => {
  let provider: LocalProvider;

  afterEach(async () => {
    if (provider) {
      await provider.stopAll();
      provider.removeExitHandler();
    }
    cleanTestRoot(TEST_ROOT);
  });

  describe('constructor', () => {
    it('should set type to local', () => {
      provider = new LocalProvider('node');
      expect(provider.type).toBe('local');
    });
  });

  describe('provision', () => {
    it('should spawn a process and return instance info', async () => {
      // Use the sleep-server fixture — the provider prepends args like 'serve --port X'
      // which become harmless extra argv entries for the fixture script
      provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

      const result = await provider.provision({
        name: 'test-swarm',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19001,
        data_dir: path.join(TEST_DATA_DIR, 'provision-test'),
      });

      expect(result.instance_id).toMatch(/^local_/);
      expect(result.state).toBe('running');
      expect(result.pid).toBeDefined();
      expect(result.pid).toBeGreaterThan(0);
      expect(result.endpoint).toBe('ws://127.0.0.1:19001');

      await provider.deprovision(result.instance_id);
    }, 10000);

    it('should create the data directory if it does not exist', async () => {
      provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);
      const dataDir = path.join(TEST_DATA_DIR, 'auto-create-dir');

      expect(fs.existsSync(dataDir)).toBe(false);

      const result = await provider.provision({
        name: 'test',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19002,
        data_dir: dataDir,
      });

      expect(fs.existsSync(dataDir)).toBe(true);
      await provider.deprovision(result.instance_id);
    }, 10000);

    it('should throw when process exits immediately', async () => {
      provider = new LocalProvider(`node ${FAIL_SCRIPT}`);

      await expect(
        provider.provision({
          name: 'failing-swarm',
          adapter: '',
          bootstrap_token: 'dGVzdA==',
          assigned_port: 19003,
          data_dir: path.join(TEST_DATA_DIR, 'fail-test'),
        })
      ).rejects.toThrow(/exited immediately/);
    });

    it('honors spawn_command_override + spawn_args_override (replaces swarm-runner command)', async () => {
      // Constructor default points at sleep-server; the override should
      // instead spawn env-dump.js. env-dump only writes env.json when it
      // actually runs, so file existence proves the override path took.
      // Args replace (not append) — env-dump receives no --port flag, so
      // its server never starts; we only care that the env capture runs.
      provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);
      const dataDir = path.join(TEST_DATA_DIR, 'override-test');
      fs.mkdirSync(dataDir, { recursive: true });
      const dumpPath = path.join(dataDir, 'env.json');
      const prevDump = process.env.MACRO_TEST_ENV_DUMP;
      process.env.MACRO_TEST_ENV_DUMP = dumpPath;
      try {
        const result = await provider.provision({
          name: 'override-test',
          adapter: '',
          bootstrap_token: 'dGVzdA==',
          assigned_port: 19004,
          data_dir: dataDir,
          spawn_command_override: 'node',
          spawn_args_override: [ENV_DUMP_SCRIPT],
        });

        // Wait briefly for env-dump to write the file.
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (fs.existsSync(dumpPath)) break;
          await new Promise((r) => setTimeout(r, 25));
        }

        expect(fs.existsSync(dumpPath)).toBe(true);
        expect(result.state).toBe('running');
        await provider.deprovision(result.instance_id);
      } finally {
        if (prevDump === undefined) delete process.env.MACRO_TEST_ENV_DUMP;
        else process.env.MACRO_TEST_ENV_DUMP = prevDump;
      }
    }, 10000);

    it('falls back to swarm-runner command when override is unset', async () => {
      // Pure regression guard: omitting the override fields keeps the
      // existing behavior. We use env-dump as the swarm-runner command (so
      // env.json appears unconditionally) and verify the provision call
      // succeeds + env was captured.
      provider = new LocalProvider(`node ${ENV_DUMP_SCRIPT}`);
      const dataDir = path.join(TEST_DATA_DIR, 'no-override-test');
      fs.mkdirSync(dataDir, { recursive: true });
      const dumpPath = path.join(dataDir, 'env.json');
      const prevDump = process.env.MACRO_TEST_ENV_DUMP;
      process.env.MACRO_TEST_ENV_DUMP = dumpPath;
      try {
        const result = await provider.provision({
          name: 'no-override-test',
          adapter: '',
          bootstrap_token: 'dGVzdA==',
          assigned_port: 19005,
          data_dir: dataDir,
          // No override fields set.
        });

        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (fs.existsSync(dumpPath)) break;
          await new Promise((r) => setTimeout(r, 25));
        }

        expect(fs.existsSync(dumpPath)).toBe(true);
        // Endpoint reflects the swarm-runner-shaped --port arg the provider
        // appended when no override was set.
        expect(result.endpoint).toBe('ws://127.0.0.1:19005');
        await provider.deprovision(result.instance_id);
      } finally {
        if (prevDump === undefined) delete process.env.MACRO_TEST_ENV_DUMP;
        else process.env.MACRO_TEST_ENV_DUMP = prevDump;
      }
    }, 10000);
  });

  describe('getStatus', () => {
    it('should return stopped for unknown instance', async () => {
      provider = new LocalProvider('node');
      const status = await provider.getStatus('nonexistent_instance');
      expect(status.state).toBe('stopped');
    });

    it('should return running for a live process', async () => {
      provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

      const result = await provider.provision({
        name: 'status-test',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19004,
        data_dir: path.join(TEST_DATA_DIR, 'status-test'),
      });

      const status = await provider.getStatus(result.instance_id);
      expect(status.state).toBe('running');
      expect(status.pid).toBeDefined();
      expect(status.uptime_ms).toBeGreaterThanOrEqual(0);

      await provider.deprovision(result.instance_id);
    }, 10000);
  });

  describe('deprovision', () => {
    it('should stop a running process', async () => {
      provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

      const result = await provider.provision({
        name: 'deprovision-test',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19005,
        data_dir: path.join(TEST_DATA_DIR, 'deprovision-test'),
      });

      let status = await provider.getStatus(result.instance_id);
      expect(status.state).toBe('running');

      await provider.deprovision(result.instance_id);

      status = await provider.getStatus(result.instance_id);
      expect(status.state).toBe('stopped');
    }, 15000);

    it('should be a no-op for unknown instance', async () => {
      provider = new LocalProvider('node');
      await provider.deprovision('nonexistent_instance');
    });
  });

  describe('getLogs', () => {
    it('should return not-found message for unknown instance', async () => {
      provider = new LocalProvider('node');
      const logs = await provider.getLogs('nonexistent_instance');
      expect(logs).toContain('not found');
    });

    it('should capture stdout/stderr output', async () => {
      // Use the verbose flag to trigger output in the fixture script
      provider = new LocalProvider(`node ${SLEEP_SCRIPT} --verbose`);

      const result = await provider.provision({
        name: 'logs-test',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19006,
        data_dir: path.join(TEST_DATA_DIR, 'logs-test'),
      });

      // Wait for output to be captured
      await new Promise((resolve) => setTimeout(resolve, 500));

      const logs = await provider.getLogs(result.instance_id);
      expect(logs).toContain('hello from swarm');
      expect(logs).toContain('err msg');

      await provider.deprovision(result.instance_id);
    }, 10000);

    it('should respect lines option', async () => {
      provider = new LocalProvider(`node ${SLEEP_SCRIPT} --verbose`);

      const result = await provider.provision({
        name: 'logs-lines-test',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19007,
        data_dir: path.join(TEST_DATA_DIR, 'logs-lines-test'),
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      const logs = await provider.getLogs(result.instance_id, { lines: 3 });
      const lines = logs.split('\n').filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(3);

      await provider.deprovision(result.instance_id);
    }, 10000);
  });

  describe('restart', () => {
    it('should stop and re-provision with the same config', async () => {
      provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

      const result = await provider.provision({
        name: 'restart-test',
        adapter: 'macro-agent',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19008,
        data_dir: path.join(TEST_DATA_DIR, 'restart-test'),
      });

      const originalPid = result.pid;

      const newResult = await provider.restart(result.instance_id);

      expect(newResult.instance_id).not.toBe(result.instance_id);
      expect(newResult.pid).toBeDefined();
      expect(newResult.pid).not.toBe(originalPid);
      expect(newResult.state).toBe('running');

      await provider.deprovision(newResult.instance_id);
    }, 15000);

    it('should throw for unknown instance', async () => {
      provider = new LocalProvider('node');
      await expect(provider.restart('nonexistent')).rejects.toThrow(/not found/);
    });
  });

  describe('stopAll', () => {
    it('should stop all managed processes', async () => {
      provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

      const r1 = await provider.provision({
        name: 'stop-all-1',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19009,
        data_dir: path.join(TEST_DATA_DIR, 'stop-all-1'),
      });

      const r2 = await provider.provision({
        name: 'stop-all-2',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19010,
        data_dir: path.join(TEST_DATA_DIR, 'stop-all-2'),
      });

      expect((await provider.getStatus(r1.instance_id)).state).toBe('running');
      expect((await provider.getStatus(r2.instance_id)).state).toBe('running');

      await provider.stopAll();

      expect((await provider.getStatus(r1.instance_id)).state).toBe('stopped');
      expect((await provider.getStatus(r2.instance_id)).state).toBe('stopped');
    }, 15000);
  });

  describe('health failure tracking', () => {
    it('should track and reset health failures', async () => {
      provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

      const result = await provider.provision({
        name: 'health-track-test',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19011,
        data_dir: path.join(TEST_DATA_DIR, 'health-track-test'),
      });

      expect(provider.recordHealthFailure(result.instance_id)).toBe(1);
      expect(provider.recordHealthFailure(result.instance_id)).toBe(2);
      expect(provider.recordHealthFailure(result.instance_id)).toBe(3);

      provider.resetHealthFailures(result.instance_id);

      expect(provider.recordHealthFailure(result.instance_id)).toBe(1);

      await provider.deprovision(result.instance_id);
    }, 10000);

    it('should return 0 for unknown instance', () => {
      provider = new LocalProvider('node');
      expect(provider.recordHealthFailure('nonexistent')).toBe(0);
    });
  });

  describe('event listener cleanup', () => {
    it('should use once() so exit listener does not accumulate across instances', () => {
      const before = process.listenerCount('exit');

      const p1 = new LocalProvider('node');
      const p2 = new LocalProvider('node');
      const p3 = new LocalProvider('node');

      const after = process.listenerCount('exit');
      // Each instance adds exactly one listener
      expect(after - before).toBe(3);

      // Cleanup
      p1.removeExitHandler();
      p2.removeExitHandler();
      p3.removeExitHandler();

      expect(process.listenerCount('exit')).toBe(before);
    });

    it('should not exceed default maxListeners with many instances', () => {
      const providers: LocalProvider[] = [];
      const before = process.listenerCount('exit');

      // Simulate hot-reload: create providers, remove them, create new ones
      for (let i = 0; i < 5; i++) {
        const p = new LocalProvider('node');
        providers.push(p);
      }

      // Remove all (simulating proper shutdown)
      for (const p of providers) {
        p.removeExitHandler();
      }

      // All listeners should be cleaned up
      expect(process.listenerCount('exit')).toBe(before);

      // Create another batch — should work without warning
      const batch2: LocalProvider[] = [];
      for (let i = 0; i < 5; i++) {
        const p = new LocalProvider('node');
        batch2.push(p);
      }

      // Should still be well under the default max (10)
      expect(process.listenerCount('exit') - before).toBe(5);

      for (const p of batch2) {
        p.removeExitHandler();
      }
    });

    it('should clean up child process listeners on deprovision', async () => {
      provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

      const result = await provider.provision({
        name: 'listener-cleanup-test',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19012,
        data_dir: path.join(TEST_DATA_DIR, 'listener-cleanup-test'),
      });

      await provider.deprovision(result.instance_id);

      // After deprovision, instance should be fully removed
      const status = await provider.getStatus(result.instance_id);
      expect(status.state).toBe('stopped');
    }, 15000);
  });

  describe('bootstrap env vars', () => {
    it('does not set MACRO_BOOTSTRAP_* when bootstrap is unset', async () => {
      provider = new LocalProvider(`node ${ENV_DUMP_SCRIPT}`);
      const env = await captureProvisionedEnv(
        provider,
        {
          name: 'no-bootstrap',
          adapter: '',
          bootstrap_token: 'dGVzdA==',
          assigned_port: 19020,
          data_dir: path.join(TEST_DATA_DIR, 'no-bootstrap'),
        },
        path.join(TEST_DATA_DIR, 'no-bootstrap-capture'),
      );
      expect(env.MACRO_BOOTSTRAP_COORDINATOR).toBeNull();
      expect(env.MACRO_BOOTSTRAP_CWD).toBeNull();
      expect(env.SWARM_RUNNER_BOOTSTRAP_TOKEN).toBe('set');
      expect(env.SWARM_RUNNER_DATA_DIR).toBe(path.join(TEST_DATA_DIR, 'no-bootstrap'));
      expect(env.OPENSWARM_BOOTSTRAP_TOKEN).toBe('set');
      expect(env.OPENSWARM_DATA_DIR).toBe(path.join(TEST_DATA_DIR, 'no-bootstrap'));
    }, 10000);

    it('sets MACRO_BOOTSTRAP_COORDINATOR=true when bootstrap.coordinator is true', async () => {
      provider = new LocalProvider(`node ${ENV_DUMP_SCRIPT}`);
      const env = await captureProvisionedEnv(
        provider,
        {
          name: 'with-bootstrap',
          adapter: '',
          bootstrap_token: 'dGVzdA==',
          assigned_port: 19021,
          data_dir: path.join(TEST_DATA_DIR, 'with-bootstrap'),
          bootstrap: { coordinator: true },
        },
        path.join(TEST_DATA_DIR, 'with-bootstrap-capture'),
      );
      expect(env.MACRO_BOOTSTRAP_COORDINATOR).toBe('true');
      expect(env.MACRO_BOOTSTRAP_CWD).toBeNull();
    }, 10000);

    it('sets MACRO_BOOTSTRAP_CWD when bootstrap.cwd is provided', async () => {
      provider = new LocalProvider(`node ${ENV_DUMP_SCRIPT}`);
      const projectPath = '/tmp/some/project/path';
      const env = await captureProvisionedEnv(
        provider,
        {
          name: 'with-cwd',
          adapter: '',
          bootstrap_token: 'dGVzdA==',
          assigned_port: 19022,
          data_dir: path.join(TEST_DATA_DIR, 'with-cwd'),
          bootstrap: { coordinator: true, cwd: projectPath },
        },
        path.join(TEST_DATA_DIR, 'with-cwd-capture'),
      );
      expect(env.MACRO_BOOTSTRAP_COORDINATOR).toBe('true');
      expect(env.MACRO_BOOTSTRAP_CWD).toBe(projectPath);
    }, 10000);

    it('does not set MACRO_BOOTSTRAP_COORDINATOR when coordinator is false', async () => {
      provider = new LocalProvider(`node ${ENV_DUMP_SCRIPT}`);
      const env = await captureProvisionedEnv(
        provider,
        {
          name: 'coord-false',
          adapter: '',
          bootstrap_token: 'dGVzdA==',
          assigned_port: 19023,
          data_dir: path.join(TEST_DATA_DIR, 'coord-false'),
          bootstrap: { coordinator: false, cwd: '/some/path' },
        },
        path.join(TEST_DATA_DIR, 'coord-false-capture'),
      );
      // cwd should NOT be exported when coordinator is opt-out — the gate is
      // the `coordinator` flag, not the cwd field.
      expect(env.MACRO_BOOTSTRAP_COORDINATOR).toBeNull();
      expect(env.MACRO_BOOTSTRAP_CWD).toBeNull();
    }, 10000);
  });
});

describe('SandboxedLocalProvider', () => {
  let provider: SandboxedLocalProvider;

  afterEach(async () => {
    if (provider) {
      await provider.stopAll();
      provider.removeExitHandler();
    }
    cleanTestRoot(TEST_ROOT);
  });

  describe('event listener cleanup', () => {
    it('should use once() so exit listener does not accumulate across instances', () => {
      const before = process.listenerCount('exit');

      const p1 = new SandboxedLocalProvider('node');
      const p2 = new SandboxedLocalProvider('node');
      const p3 = new SandboxedLocalProvider('node');

      const after = process.listenerCount('exit');
      expect(after - before).toBe(3);

      p1.removeExitHandler();
      p2.removeExitHandler();
      p3.removeExitHandler();

      expect(process.listenerCount('exit')).toBe(before);
    });

    it('should clean up child process listeners on deprovision', async () => {
      provider = new SandboxedLocalProvider(`node ${SLEEP_SCRIPT}`);

      const result = await provider.provision({
        name: 'sandbox-listener-cleanup',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19013,
        data_dir: path.join(TEST_DATA_DIR, 'sandbox-listener-cleanup'),
      });

      await provider.deprovision(result.instance_id);

      const status = await provider.getStatus(result.instance_id);
      expect(status.state).toBe('stopped');
    }, 15000);
  });

  describe('bootstrap env vars', () => {
    it('sets MACRO_BOOTSTRAP_COORDINATOR + MACRO_BOOTSTRAP_CWD when configured', async () => {
      provider = new SandboxedLocalProvider(`node ${ENV_DUMP_SCRIPT}`);
      const projectPath = '/tmp/sandboxed-project';
      const env = await captureProvisionedEnv(
        provider,
        {
          name: 'sandbox-bootstrap',
          adapter: '',
          bootstrap_token: 'dGVzdA==',
          assigned_port: 19024,
          data_dir: path.join(TEST_DATA_DIR, 'sandbox-bootstrap'),
          bootstrap: { coordinator: true, cwd: projectPath },
        },
        path.join(TEST_DATA_DIR, 'sandbox-bootstrap-capture'),
      );
      expect(env.MACRO_BOOTSTRAP_COORDINATOR).toBe('true');
      expect(env.MACRO_BOOTSTRAP_CWD).toBe(projectPath);
    }, 10000);
  });
});
