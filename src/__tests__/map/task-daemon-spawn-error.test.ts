/**
 * Regression test for the OpenTasks daemon spawn failing on a host without the
 * CLI available.
 *
 * `spawn` does not throw when the binary is missing — it reports ENOENT
 * asynchronously through an 'error' event. With no listener attached, the
 * EventEmitter rethrows it as an uncaught exception, which killed the entire
 * OpenHive server the first time anything requested task data.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import { testRoot, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

vi.mock('node:child_process', () => ({
  execSync: () => Buffer.from(''),
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & {
      unref: () => void;
      stderr: null;
    };
    child.unref = () => {};
    child.stderr = null;
    // Node reports a missing binary on the next tick, not by throwing.
    setTimeout(() => {
      child.emit(
        'error',
        Object.assign(new Error('spawn opentasks ENOENT'), { code: 'ENOENT' }),
      );
    }, 0);
    return child;
  },
}));

const { ensureDaemon } = await import('../../map/task-daemon-lifecycle.js');

const TEST_ROOT = testRoot('task-daemon-spawn-error');

beforeAll(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterAll(() => {
  cleanTestRoot(TEST_ROOT);
  vi.restoreAllMocks();
});

describe('ensureDaemon when the opentasks binary is missing', () => {
  it('reports failure instead of crashing the process', async () => {
    const dir = mkTestDir(TEST_ROOT, 'missing-cli');

    // An unhandled 'error' event would surface here as a rejection rather than
    // a clean `false`, and in the real server as an uncaught exception.
    await expect(ensureDaemon(dir)).resolves.toBe(false);
  });

  it('gives up as soon as the spawn fails rather than polling for 5s', async () => {
    const dir = mkTestDir(TEST_ROOT, 'fast-bail');

    const start = Date.now();
    await ensureDaemon(dir);
    const elapsed = Date.now() - start;

    // The readiness loop is 20 polls at 250ms. Bailing on the error keeps this
    // to roughly one poll; anything near 5s means the break was dropped.
    expect(elapsed).toBeLessThan(2000);
  });
});
