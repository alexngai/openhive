/**
 * Task binder unit tests. We mock the connection registry, resource DAL,
 * and task update paths so we can exercise the resolveClosePolicy → update
 * decision logic without standing up a hub. Integration coverage (real DB,
 * real cascade-handler) lives in the cascade/task-binder-e2e.test.ts file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findResourceById = vi.fn();
const getAggregateCapabilities = vi.fn();
const daemonUpdateTask = vi.fn();
const resolveDaemonSocket = vi.fn();
const remoteUpdateTask = vi.fn();
const findSwarmForResource = vi.fn();
const broadcastTaskStatus = vi.fn();

vi.mock('../../db/dal/syncable-resources.js', () => ({
  findResourceById: (...args: unknown[]) => findResourceById(...args),
}));
vi.mock('../../map/connection-registry.js', () => ({
  getAggregateCapabilities: (...args: unknown[]) => getAggregateCapabilities(...args),
}));
vi.mock('../../map/task-daemon-client.js', () => ({
  daemonUpdateTask: (...args: unknown[]) => daemonUpdateTask(...args),
  resolveDaemonSocket: (...args: unknown[]) => resolveDaemonSocket(...args),
}));
vi.mock('../../map/opentasks-remote.js', () => ({
  remoteUpdateTask: (...args: unknown[]) => remoteUpdateTask(...args),
  findSwarmForResource: (...args: unknown[]) => findSwarmForResource(...args),
}));
vi.mock('../../map/task-broadcast.js', () => ({
  broadcastTaskStatus: (...args: unknown[]) => broadcastTaskStatus(...args),
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
}));

const { handleCascadeStreamMerged } = await import('../task-binder.js');

const DEPS = { defaultClosePolicy: 'manual' as const };
const DEPS_ON_MERGE = { defaultClosePolicy: 'on_merge' as const };

const baseEvent = {
  source_swarm_id: 'swarm-1',
  source_stream_id: 'stream-1',
  target_stream_id: 'stream-trunk',
  merge_commit: 'abc123',
  task_ref: { resource_id: 'resource-1', node_id: 'task-1' },
};

function makeResource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resource-1',
    resource_type: 'task',
    local_path: null,
    git_remote_url: 'remote://graph',
    metadata: null,
    ...overrides,
  };
}

beforeEach(() => {
  findResourceById.mockReset();
  getAggregateCapabilities.mockReset();
  daemonUpdateTask.mockReset();
  resolveDaemonSocket.mockReset();
  remoteUpdateTask.mockReset();
  findSwarmForResource.mockReset();
  broadcastTaskStatus.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('handleCascadeStreamMerged (binder core)', () => {
  it('short-circuits when event has no task_ref (no DB access)', async () => {
    await handleCascadeStreamMerged({ source_swarm_id: 'swarm-1' }, DEPS_ON_MERGE);
    expect(findResourceById).not.toHaveBeenCalled();
    expect(remoteUpdateTask).not.toHaveBeenCalled();
    expect(broadcastTaskStatus).not.toHaveBeenCalled();
  });

  it('does nothing when resolved policy is manual (default)', async () => {
    findResourceById.mockReturnValue(makeResource());
    getAggregateCapabilities.mockReturnValue(undefined);

    await handleCascadeStreamMerged(baseEvent, DEPS);

    expect(findResourceById).toHaveBeenCalledWith('resource-1');
    expect(remoteUpdateTask).not.toHaveBeenCalled();
    expect(broadcastTaskStatus).not.toHaveBeenCalled();
  });

  it('transitions task when per-swarm autoCloseOnMerge: true', async () => {
    findResourceById.mockReturnValue(makeResource());
    getAggregateCapabilities.mockReturnValue({ cascade: { autoCloseOnMerge: true } });
    findSwarmForResource.mockReturnValue('swarm-1');
    remoteUpdateTask.mockResolvedValue({ id: 'task-1', status: 'completed' });

    await handleCascadeStreamMerged(baseEvent, DEPS);

    expect(remoteUpdateTask).toHaveBeenCalledWith('swarm-1', 'task-1', 'completed');
    expect(broadcastTaskStatus).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'completed',
      resourceId: 'resource-1',
    });
  });

  it('transitions task when per-task close_policy: on_merge', async () => {
    findResourceById.mockReturnValue(
      makeResource({ metadata: { close_policy: 'on_merge' } }),
    );
    getAggregateCapabilities.mockReturnValue(undefined);
    findSwarmForResource.mockReturnValue('swarm-1');
    remoteUpdateTask.mockResolvedValue({ id: 'task-1', status: 'completed' });

    await handleCascadeStreamMerged(baseEvent, DEPS);

    expect(remoteUpdateTask).toHaveBeenCalled();
    expect(broadcastTaskStatus).toHaveBeenCalled();
  });

  it('per-task manual overrides per-swarm on_merge', async () => {
    findResourceById.mockReturnValue(
      makeResource({ metadata: { close_policy: 'manual' } }),
    );
    getAggregateCapabilities.mockReturnValue({ cascade: { autoCloseOnMerge: true } });

    await handleCascadeStreamMerged(baseEvent, DEPS);

    expect(remoteUpdateTask).not.toHaveBeenCalled();
    expect(broadcastTaskStatus).not.toHaveBeenCalled();
  });

  it('does not throw when task resource is missing', async () => {
    findResourceById.mockReturnValue(null);
    await expect(
      handleCascadeStreamMerged(baseEvent, DEPS_ON_MERGE),
    ).resolves.not.toThrow();
    expect(remoteUpdateTask).not.toHaveBeenCalled();
  });

  it('skips broadcast when remote update returns null (swarm unreachable)', async () => {
    findResourceById.mockReturnValue(makeResource());
    getAggregateCapabilities.mockReturnValue({ cascade: { autoCloseOnMerge: true } });
    findSwarmForResource.mockReturnValue('swarm-1');
    remoteUpdateTask.mockResolvedValue(null);

    await handleCascadeStreamMerged(baseEvent, DEPS);

    expect(remoteUpdateTask).toHaveBeenCalled();
    expect(broadcastTaskStatus).not.toHaveBeenCalled();
  });

  it('is a no-op with neither local path nor connected swarm', async () => {
    findResourceById.mockReturnValue(makeResource());
    getAggregateCapabilities.mockReturnValue({ cascade: { autoCloseOnMerge: true } });
    findSwarmForResource.mockReturnValue(null);

    await handleCascadeStreamMerged(baseEvent, DEPS);

    expect(remoteUpdateTask).not.toHaveBeenCalled();
    expect(broadcastTaskStatus).not.toHaveBeenCalled();
  });
});
