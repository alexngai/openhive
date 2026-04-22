/**
 * Unit tests for the git-pull-trigger debouncer.
 *
 * We mock the resource DAL + the opentasks IPC client to verify the
 * debounce / eligibility / coalescing behavior without running a daemon.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findResourceById = vi.fn();
const ipcConnect = vi.fn();
const ipcRequest = vi.fn();
const ipcDisconnect = vi.fn();
const ipcClientFactory = vi.fn((_socketPath: string) => ({
  connect: ipcConnect,
  request: ipcRequest,
  disconnect: ipcDisconnect,
  get connected() { return true; },
  onNotification: () => () => {},
}));

vi.mock('../../db/dal/syncable-resources.js', () => ({
  findResourceById: (...args: unknown[]) => findResourceById(...args),
}));

vi.mock('../../map/task-daemon-client.js', () => ({
  resolveDaemonSocket: (localPath: string) => `${localPath}/.opentasks/daemon.sock`,
}));

vi.mock('opentasks', () => ({
  createIPCClient: (socketPath: string) => ipcClientFactory(socketPath),
}));

import {
  triggerPullForResource,
  _resetGitPullTriggerForTests,
} from '../../map/git-pull-trigger.js';

beforeEach(() => {
  vi.useFakeTimers();
  findResourceById.mockReset();
  ipcConnect.mockReset().mockResolvedValue(undefined);
  ipcRequest.mockReset().mockResolvedValue({ ran: true, result: { pulled: true, hasChanges: false } });
  ipcDisconnect.mockReset();
  ipcClientFactory.mockClear();
  _resetGitPullTriggerForTests();
});

afterEach(() => {
  vi.useRealTimers();
  _resetGitPullTriggerForTests();
});

function asTaskResource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res_1',
    resource_type: 'task',
    local_path: '/tmp/fake',
    metadata: { git_sync: { enabled: true } },
    ...overrides,
  };
}

describe('triggerPullForResource', () => {
  it('returns false when the resource does not exist', () => {
    findResourceById.mockReturnValue(null);
    expect(triggerPullForResource('missing')).toBe(false);
  });

  it('returns false when git_sync is not configured', () => {
    findResourceById.mockReturnValue(asTaskResource({ metadata: { opentasks: true } }));
    expect(triggerPullForResource('res_1')).toBe(false);
  });

  it('returns false when git_sync.enabled is false', () => {
    findResourceById.mockReturnValue(asTaskResource({ metadata: { git_sync: { enabled: false } } }));
    expect(triggerPullForResource('res_1')).toBe(false);
  });

  it('returns false when pullOnSignal is explicitly false', () => {
    findResourceById.mockReturnValue(
      asTaskResource({ metadata: { git_sync: { enabled: true, pullOnSignal: false } } }),
    );
    expect(triggerPullForResource('res_1')).toBe(false);
  });

  it('returns false when resource has no local_path', () => {
    findResourceById.mockReturnValue(asTaskResource({ local_path: null }));
    expect(triggerPullForResource('res_1')).toBe(false);
  });

  it('schedules a pull when eligible, fires it after the debounce window', async () => {
    findResourceById.mockReturnValue(asTaskResource());
    expect(triggerPullForResource('res_1')).toBe(true);

    // No pull yet — timer pending.
    expect(ipcRequest).not.toHaveBeenCalled();

    // Advance past the 2s debounce.
    await vi.advanceTimersByTimeAsync(2100);

    expect(ipcRequest).toHaveBeenCalledWith('sync.pull', {});
    expect(ipcClientFactory).toHaveBeenCalledWith('/tmp/fake/.opentasks/daemon.sock');
  });

  it('coalesces rapid triggers into a single pull', async () => {
    findResourceById.mockReturnValue(asTaskResource());
    triggerPullForResource('res_1');
    triggerPullForResource('res_1');
    triggerPullForResource('res_1');
    triggerPullForResource('res_1');
    triggerPullForResource('res_1');

    await vi.advanceTimersByTimeAsync(2100);

    expect(ipcRequest).toHaveBeenCalledTimes(1);
  });

  it('different resource ids get independent timers', async () => {
    findResourceById
      .mockImplementationOnce((id) =>
        id === 'res_a' ? asTaskResource({ id: 'res_a', local_path: '/tmp/a' }) : null,
      )
      .mockImplementationOnce((id) =>
        id === 'res_b' ? asTaskResource({ id: 'res_b', local_path: '/tmp/b' }) : null,
      );

    expect(triggerPullForResource('res_a')).toBe(true);
    expect(triggerPullForResource('res_b')).toBe(true);

    await vi.advanceTimersByTimeAsync(2100);

    expect(ipcRequest).toHaveBeenCalledTimes(2);
  });

  it('swallows IPC errors silently', async () => {
    findResourceById.mockReturnValue(asTaskResource());
    ipcConnect.mockRejectedValueOnce(new Error('daemon down'));

    triggerPullForResource('res_1');
    await vi.advanceTimersByTimeAsync(2100);
    // should not throw; runner stays alive
    expect(true).toBe(true);
  });
});
