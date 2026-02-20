import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LocalProvider } from '../../swarm/providers/local.js';
import { testRoot, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('swarm-provider');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SLEEP_SCRIPT = path.join(FIXTURES_DIR, 'sleep-server.js');
const FAIL_SCRIPT = path.join(FIXTURES_DIR, 'exit-immediately.js');

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
});
