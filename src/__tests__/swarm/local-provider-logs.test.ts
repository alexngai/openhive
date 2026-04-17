/**
 * LocalProvider — log file placement + port-in-use fallback
 *
 * Two behaviors that are easy to break and hard to debug when they regress:
 *
 * 1. `resolveLogPath` picks the right file for each `LogConfig.dir` value,
 *    and keys the filename on the stable hosted-swarm path (basename of
 *    `data_dir`) rather than the rotating instance id — otherwise logs
 *    scatter across N files after N restarts.
 *
 * 2. `LocalProvider.restart()` throws a typed `PortInUseError` when the
 *    original port can't be reclaimed (stuck TIME_WAIT, stale squatter,
 *    etc.), letting the manager fall through to `autoRestart` with a fresh
 *    port allocation instead of crash-looping on the bound one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { LocalProvider, PortInUseError, resolveLogPath } from '../../swarm/providers/local.js';
import { testRoot, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('local-provider-logs');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SLEEP_SCRIPT = path.join(FIXTURES_DIR, 'sleep-server.js');

// ============================================================================
// resolveLogPath
// ============================================================================

describe('resolveLogPath', () => {
  // Use path.join in expectations so tests work on every platform.
  const DATA_DIR = '/var/openhive/data/swarms/swarm-9000';
  const INSTANCE = 'local_1700000000000_9000';
  const CUSTOM = '/var/log/my-swarms';

  it('"tmp" places the file under os.tmpdir()/openhive-swarm-logs/', () => {
    const p = resolveLogPath('tmp', DATA_DIR, INSTANCE);
    expect(p).toBe(path.join(os.tmpdir(), 'openhive-swarm-logs', 'swarm-9000.log'));
  });

  it('"data_dir" places the file at <dataDir>/openswarm.log', () => {
    expect(resolveLogPath('data_dir', DATA_DIR, INSTANCE)).toBe(
      path.join(DATA_DIR, 'openswarm.log'),
    );
  });

  it('absolute paths resolve to <dir>/<hostedSwarmKey>.log', () => {
    expect(resolveLogPath(CUSTOM, DATA_DIR, INSTANCE)).toBe(
      path.join(CUSTOM, 'swarm-9000.log'),
    );
  });

  it('keys the filename on basename(dataDir), not instance id', () => {
    // Regression guard: the filename MUST remain stable across restarts
    // (instance id rotates every spawn). Two different instance ids on the
    // same dataDir resolve to the same log file.
    const a = resolveLogPath('tmp', DATA_DIR, 'local_111_9000');
    const b = resolveLogPath('tmp', DATA_DIR, 'local_222_9000');
    expect(a).toBe(b);
  });

  it('falls back to instanceId when dataDir has no usable basename', () => {
    // e.g. dataDir = '/' (unlikely in prod but defensible).
    const p = resolveLogPath('tmp', '/', INSTANCE);
    expect(p).toBe(path.join(os.tmpdir(), 'openhive-swarm-logs', `${INSTANCE}.log`));
  });

  it('resolves relative dataDir before taking basename', () => {
    // OpenHive uses relative data_dir by default ("./data/swarms/swarm-9000").
    // basename of that string is fine on its own ("swarm-9000"), but once we
    // path.resolve it first the key is stable even if cwd changes.
    const p = resolveLogPath('tmp', './data/swarms/swarm-7777', INSTANCE);
    expect(p).toBe(path.join(os.tmpdir(), 'openhive-swarm-logs', 'swarm-7777.log'));
  });
});

// ============================================================================
// LocalProvider.restart() — PortInUseError fallback
// ============================================================================

/** Spin up a squatter on (port, 127.0.0.1). Returns a stop() to release. */
async function squatPort(port: number): Promise<() => Promise<void>> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

describe('LocalProvider.restart() port reassignment', () => {
  let provider: LocalProvider | null = null;

  afterEach(async () => {
    if (provider) {
      await provider.stopAll();
      provider.removeExitHandler();
      provider = null;
    }
    cleanTestRoot(TEST_ROOT);
  });

  it('throws PortInUseError when the original port is still bound on restart', async () => {
    // The command runs the sleep-server fixture with `--port <N>` so it
    // behaves like a real openswarm child for the provider's lifecycle
    // (spawn, stdout, health endpoint). We don't actually care about
    // health here — just that provision/deprovision work and then restart
    // trips the port probe.
    const command = `node ${SLEEP_SCRIPT}`;
    provider = new LocalProvider(command, { enabled: false, dir: 'tmp' });

    const port = await allocatePort();
    const dataDir = path.join(TEST_ROOT, `squat-test-${port}`);
    const { instance_id } = await provider.provision({
      name: 'squat-test',
      adapter: 'generic',
      bootstrap_token: 'token',
      assigned_port: port,
      data_dir: dataDir,
    });

    // Hold the port on the side before restart. deprovision releases it,
    // then the squatter grabs it faster than the OS can recycle — simulating
    // TIME_WAIT / stale child / external process.
    const stopSquat = await squatPort(port);
    try {
      // First observe the squatter is up (the restart handler won't see
      // any process-level race with `provider.deprovision` because we
      // already own the port).
      await expect(provider.restart(instance_id)).rejects.toBeInstanceOf(PortInUseError);
    } finally {
      await stopSquat();
    }
  }, 20000);

  it('PortInUseError exposes the port and a stable code for catch blocks', () => {
    const err = new PortInUseError(9000);
    expect(err.port).toBe(9000);
    expect(err.code).toBe('PORT_IN_USE');
    // catch blocks in the manager match on `.code`; if someone swaps this
    // to a string literal without `as const` the match would break.
    expect((err as { code?: string }).code).toBe('PORT_IN_USE');
  });
});
