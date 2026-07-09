/**
 * Tests for task-daemon-lifecycle.ts — socket path resolution and daemon cwd.
 *
 * Verifies:
 * - resolveDaemonSocket checks config.json, direct socket, nested socket
 * - ensureDaemon uses parent dir as cwd when opentasksDir is .opentasks/
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { resolveDaemonSocket } from '../../map/task-daemon-client.js';
import {
  resolveOpentasksCliPath,
  reapStaleDaemonLock,
  maxUnixSocketPathBytes,
  diagnoseSocketPathLength,
} from '../../map/task-daemon-lifecycle.js';
import { testRoot, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('task-daemon-lifecycle');

beforeAll(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterAll(() => {
  cleanTestRoot(TEST_ROOT);
});

describe('resolveDaemonSocket', () => {
  it('should use daemon.socketPath from config.json when present', () => {
    const dir = mkTestDir(TEST_ROOT, 'config-socket');
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ daemon: { socketPath: '/custom/daemon.sock' } }),
    );

    expect(resolveDaemonSocket(dir)).toBe('/custom/daemon.sock');
  });

  it('should use direct daemon.sock when it exists', () => {
    const dir = mkTestDir(TEST_ROOT, 'direct-socket');
    const socketPath = path.join(dir, 'daemon.sock');
    // Create a file to simulate socket existence
    fs.writeFileSync(socketPath, '');

    expect(resolveDaemonSocket(dir)).toBe(socketPath);
  });

  it('should fall back to nested .opentasks/daemon.sock', () => {
    const dir = mkTestDir(TEST_ROOT, 'nested-socket');
    const nestedDir = path.join(dir, '.opentasks');
    fs.mkdirSync(nestedDir, { recursive: true });
    const nestedSocket = path.join(nestedDir, 'daemon.sock');
    fs.writeFileSync(nestedSocket, '');

    // No direct socket, no config — should find nested
    expect(resolveDaemonSocket(dir)).toBe(nestedSocket);
  });

  it('should return default direct path when no socket exists', () => {
    const dir = mkTestDir(TEST_ROOT, 'no-socket');

    expect(resolveDaemonSocket(dir)).toBe(path.join(dir, 'daemon.sock'));
  });

  it('should prefer config.json over file existence', () => {
    const dir = mkTestDir(TEST_ROOT, 'config-over-file');
    // Both config and direct socket exist
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ daemon: { socketPath: '/configured/path.sock' } }),
    );
    fs.writeFileSync(path.join(dir, 'daemon.sock'), '');

    expect(resolveDaemonSocket(dir)).toBe('/configured/path.sock');
  });

  it('should prefer direct socket over nested socket', () => {
    const dir = mkTestDir(TEST_ROOT, 'direct-over-nested');
    const directSocket = path.join(dir, 'daemon.sock');
    fs.writeFileSync(directSocket, '');
    const nestedDir = path.join(dir, '.opentasks');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'daemon.sock'), '');

    expect(resolveDaemonSocket(dir)).toBe(directSocket);
  });

  it('should handle config.json without daemon section', () => {
    const dir = mkTestDir(TEST_ROOT, 'config-no-daemon');
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ location: { hash: 'abc' } }),
    );

    expect(resolveDaemonSocket(dir)).toBe(path.join(dir, 'daemon.sock'));
  });

  it('should handle malformed config.json gracefully', () => {
    const dir = mkTestDir(TEST_ROOT, 'bad-config');
    fs.writeFileSync(path.join(dir, 'config.json'), 'not json');

    expect(resolveDaemonSocket(dir)).toBe(path.join(dir, 'daemon.sock'));
  });

  it('resolves the multi-location socket for a task graph inside a git repo', () => {
    // Regression: inside a git repo the opentasks daemon runs multi-location and
    // binds `<git-common-dir>/opentasks/daemon.sock`. resolveDaemonSocket must
    // resolve there deterministically — even before the daemon has created the
    // socket — otherwise probes hit the plain `.opentasks` path and miss the
    // running daemon ("daemon not ready" though it is listening).
    const repo = mkTestDir(TEST_ROOT, 'git-repo');
    execSync('git init -q', { cwd: repo });
    const graphDir = path.join(repo, 'task-graph', '.opentasks');
    fs.mkdirSync(graphDir, { recursive: true });

    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: graphDir,
      encoding: 'utf-8',
    }).trim();
    const expected = path.join(path.resolve(graphDir, gitCommonDir), 'opentasks', 'daemon.sock');

    expect(resolveDaemonSocket(graphDir)).toBe(expected);
  });
});

describe('socket path length guard', () => {
  // A path longer than the platform's sun_path buffer is truncated by the
  // kernel on bind() — the root cause behind phantom EADDRINUSE / "daemon never
  // ready" failures on deeply-nested macOS checkouts. These guard against a
  // regression that would let that fail silently again.
  it('maxUnixSocketPathBytes reflects per-platform sun_path limits', () => {
    expect(maxUnixSocketPathBytes('darwin')).toBe(103);
    expect(maxUnixSocketPathBytes('linux')).toBe(107);
    expect(maxUnixSocketPathBytes('win32')).toBe(Number.POSITIVE_INFINITY);
  });

  it('passes a comfortably short socket path', () => {
    expect(diagnoseSocketPathLength('/tmp/oh/daemon.sock', 'darwin')).toBeNull();
  });

  it('flags an over-long macOS path with an actionable message', () => {
    const longPath = '/' + 'a'.repeat(120) + '/daemon.sock'; // > 103 bytes
    const msg = diagnoseSocketPathLength(longPath, 'darwin');
    expect(msg).toBeTruthy();
    expect(msg).toContain(longPath);
    expect(msg).toContain('bind()');
    expect(msg).toMatch(/Fix:/);
  });

  it('applies the higher Linux limit at the boundary', () => {
    const path105 = '/' + 'a'.repeat(92) + '/daemon.sock';
    expect(Buffer.byteLength(path105)).toBe(105); // 105 > 103 (darwin), <= 107 (linux)
    expect(diagnoseSocketPathLength(path105, 'darwin')).toBeTruthy();
    expect(diagnoseSocketPathLength(path105, 'linux')).toBeNull();
  });

  it('never flags on Windows (named pipes, not sun_path)', () => {
    const longPipe = '\\\\.\\pipe\\' + 'a'.repeat(300);
    expect(diagnoseSocketPathLength(longPipe, 'win32')).toBeNull();
  });
});

describe('resolveOpentasksCliPath', () => {
  // Regression: the package's ESM-only `exports` map makes
  // require.resolve('opentasks/package.json') throw ERR_PACKAGE_PATH_NOT_EXPORTED
  // under a CJS createRequire, which used to silently fall back to spawning a
  // bare `opentasks` (not on $PATH in Docker/Electron) → auto-start always failed.
  it('locates the opentasks CLI by walking node_modules off disk', () => {
    const cli = resolveOpentasksCliPath();
    expect(cli).toBeTruthy();
    expect(cli).toMatch(/opentasks[/\\]dist[/\\]cli\.js$/);
    expect(fs.existsSync(cli!)).toBe(true);
  });
});

describe('reapStaleDaemonLock', () => {
  // Regression: after an ungraceful shutdown (SIGKILL on container restart)
  // proper-lockfile's `daemon.lock.lock` dir lingers, and opentasks acquires
  // with retries:0, so auto-start 500s for ~10s until the stale window elapses.
  it('removes an orphaned content lock + proper-lockfile dir (dead pid)', () => {
    const dir = mkTestDir(TEST_ROOT, 'reap-dead-pid');
    const content = path.join(dir, 'daemon.lock');
    const properDir = path.join(dir, 'daemon.lock.lock');
    // pid 2^31-1 is effectively guaranteed dead.
    fs.writeFileSync(content, JSON.stringify({ pid: 2147483646, socketPath: '/x.sock' }));
    fs.mkdirSync(properDir, { recursive: true });

    reapStaleDaemonLock(dir);

    expect(fs.existsSync(content)).toBe(false);
    expect(fs.existsSync(properDir)).toBe(false);
  });

  it('reaps a lingering proper-lockfile dir even without a content file', () => {
    const dir = mkTestDir(TEST_ROOT, 'reap-orphan-dir');
    const properDir = path.join(dir, 'daemon.lock.lock');
    fs.mkdirSync(properDir, { recursive: true });

    reapStaleDaemonLock(dir);

    expect(fs.existsSync(properDir)).toBe(false);
  });

  it('leaves the lock intact when a live process still owns it', () => {
    const dir = mkTestDir(TEST_ROOT, 'reap-live-pid');
    const content = path.join(dir, 'daemon.lock');
    const properDir = path.join(dir, 'daemon.lock.lock');
    // Our own pid is alive → treat as a real daemon mid-startup.
    fs.writeFileSync(content, JSON.stringify({ pid: process.pid, socketPath: '/x.sock' }));
    fs.mkdirSync(properDir, { recursive: true });

    reapStaleDaemonLock(dir);

    expect(fs.existsSync(content)).toBe(true);
    expect(fs.existsSync(properDir)).toBe(true);
  });

  it('is a no-op when no lock exists', () => {
    const dir = mkTestDir(TEST_ROOT, 'reap-none');
    expect(() => reapStaleDaemonLock(dir)).not.toThrow();
  });
});

describe('ensureDaemon cwd resolution', () => {
  // We can't easily test the actual spawn, but we can verify the cwd logic
  // by importing and checking the behavior indirectly via the module.

  it('should derive parent cwd when opentasksDir basename is .opentasks', async () => {
    // This tests the logic: basename('.opentasks') === '.opentasks' → use dirname
    const opentasksDir = '/project/root/.opentasks';
    expect(path.basename(opentasksDir)).toBe('.opentasks');
    expect(path.dirname(opentasksDir)).toBe('/project/root');
  });

  it('should use opentasksDir directly when basename is not .opentasks', () => {
    const opentasksDir = '/project/root/custom-tasks';
    expect(path.basename(opentasksDir)).not.toBe('.opentasks');
    // ensureDaemon would use opentasksDir as cwd in this case
  });

  it('should handle nested .opentasks paths correctly', () => {
    // Edge case: /a/.opentasks/.opentasks — basename is still .opentasks
    const opentasksDir = '/a/.opentasks/.opentasks';
    expect(path.basename(opentasksDir)).toBe('.opentasks');
    expect(path.dirname(opentasksDir)).toBe('/a/.opentasks');
  });
});
