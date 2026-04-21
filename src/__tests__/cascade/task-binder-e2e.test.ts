/**
 * Task-binder end-to-end integration.
 *
 * Exercises the real event chain: cascade-handler emits via mapHubEvents,
 * task-binder subscribes, resolves policy against a real DB, and invokes
 * the task update path. The terminal write legs (daemon IPC, remote MAP)
 * are mocked since a real hub's worth of infra isn't set up here — but
 * every layer above that point is exercised live.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const broadcastToChannel = vi.fn();
const daemonUpdateTask = vi.fn();
const resolveDaemonSocket = vi.fn(() => '/tmp/fake-socket');
const remoteUpdateTask = vi.fn();
const findSwarmForResource = vi.fn();
const getAggregateCapabilities = vi.fn();

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...args),
}));
vi.mock('../../map/task-daemon-client.js', () => ({
  daemonUpdateTask: (...args: unknown[]) => daemonUpdateTask(...args),
  resolveDaemonSocket: (...args: unknown[]) => resolveDaemonSocket(...args),
  TaskDaemonError: class TaskDaemonError extends Error {},
}));
vi.mock('../../map/opentasks-remote.js', () => ({
  remoteUpdateTask: (...args: unknown[]) => remoteUpdateTask(...args),
  findSwarmForResource: (...args: unknown[]) => findSwarmForResource(...args),
}));
vi.mock('../../map/connection-registry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../map/connection-registry.js');
  return {
    ...actual,
    getAggregateCapabilities: (...args: unknown[]) => getAggregateCapabilities(...args),
  };
});

const { initDatabase, closeDatabase } = await import('../../db/index.js');
const agentsDAL = await import('../../db/dal/agents.js');
const resourcesDAL = await import('../../db/dal/syncable-resources.js');
const { handleCascadeRequest, CASCADE_METHODS } = await import('../../map/cascade-handler.js');
const { startTaskBinder, stopTaskBinder } = await import('../../cascade/task-binder.js');
const testDirs = await import('../helpers/test-dirs.js');

const TEST_ROOT = testDirs.testRoot('cascade-task-binder');
const TEST_DB = testDirs.testDbPath(TEST_ROOT, 'binder.db');
const SWARM = 'swarm-binder-test';
const AGENT = 'binder-test-agent';

describe('task-binder e2e (cascade → policy → update)', () => {
  let taskResourceId: string;
  const taskRef = { resource_id: '', node_id: 'task-binder-1' };

  beforeAll(async () => {
    initDatabase(TEST_DB);
    const { agent } = await agentsDAL.createAgent({
      name: AGENT,
      description: 'Task binder integration test agent',
    });

    const { resource } = resourcesDAL.upsertDiscoveredResource({
      resource_type: 'task',
      name: 'binder-task-graph',
      description: 'Graph used by task-binder e2e',
      git_remote_url: 'remote://binder-test',
      visibility: 'private',
      owner_agent_id: agent.id,
      scope: 'agent',
      sync_strategy: 'local',
      metadata: { opentasks: true },
    });
    taskResourceId = resource.id;
    taskRef.resource_id = taskResourceId;
  });

  afterAll(() => {
    stopTaskBinder();
    closeDatabase();
    testDirs.cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    daemonUpdateTask.mockReset();
    remoteUpdateTask.mockReset();
    findSwarmForResource.mockReset();
    getAggregateCapabilities.mockReset();
    broadcastToChannel.mockReset();
  });

  async function flushEventLoop(): Promise<void> {
    // mapHubEvents is synchronous, but the binder handler is async — allow
    // microtasks to drain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  it('does nothing on default (manual) policy', async () => {
    getAggregateCapabilities.mockReturnValue(undefined);
    startTaskBinder({ defaultClosePolicy: 'manual' });

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      {
        stream_id: 'binder-stream-1',
        name: 'binder-stream-1',
        agent_id: AGENT,
        metadata: { task_ref: taskRef },
      },
      { swarmId: SWARM, agentId: AGENT },
    );

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_MERGED,
      {
        source_stream_id: 'binder-stream-1',
        target_stream_id: 'main',
        merge_commit: 'merge-1',
        agent_id: AGENT,
        metadata: { task_ref: taskRef },
      },
      { swarmId: SWARM, agentId: AGENT },
    );

    await flushEventLoop();

    expect(remoteUpdateTask).not.toHaveBeenCalled();
    expect(daemonUpdateTask).not.toHaveBeenCalled();

    stopTaskBinder();
  });

  it('transitions task to completed when per-swarm autoCloseOnMerge is declared', async () => {
    getAggregateCapabilities.mockReturnValue({ cascade: { autoCloseOnMerge: true } });
    findSwarmForResource.mockReturnValue(SWARM);
    remoteUpdateTask.mockResolvedValue({ id: 'task-binder-1', status: 'completed' });

    startTaskBinder({ defaultClosePolicy: 'manual' });

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      {
        stream_id: 'binder-stream-2',
        name: 'binder-stream-2',
        agent_id: AGENT,
        metadata: { task_ref: taskRef },
      },
      { swarmId: SWARM, agentId: AGENT },
    );

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_MERGED,
      {
        source_stream_id: 'binder-stream-2',
        target_stream_id: 'main',
        merge_commit: 'merge-2',
        agent_id: AGENT,
        metadata: { task_ref: taskRef },
      },
      { swarmId: SWARM, agentId: AGENT },
    );

    await flushEventLoop();

    expect(remoteUpdateTask).toHaveBeenCalledWith(SWARM, 'task-binder-1', 'completed');

    // Binder's broadcastTaskStatus should have fired task.status on map:tasks.
    const taskStatusBroadcasts = broadcastToChannel.mock.calls.filter(
      (call) => call[0] === 'map:tasks' && call[1]?.type === 'task.status',
    );
    expect(taskStatusBroadcasts.length).toBeGreaterThanOrEqual(1);
    const lastStatusBroadcast = taskStatusBroadcasts[taskStatusBroadcasts.length - 1][1];
    expect(lastStatusBroadcast.data.current).toBe('completed');

    stopTaskBinder();
  });

  it('respects per-task close_policy: manual even when swarm opted in', async () => {
    // Update the task resource's metadata to carry close_policy: manual.
    resourcesDAL.updateResource(taskResourceId, {
      metadata: { opentasks: true, close_policy: 'manual' },
    });

    getAggregateCapabilities.mockReturnValue({ cascade: { autoCloseOnMerge: true } });
    findSwarmForResource.mockReturnValue(SWARM);
    remoteUpdateTask.mockResolvedValue({ id: 'task-binder-1', status: 'completed' });

    startTaskBinder({ defaultClosePolicy: 'on_merge' });

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      {
        stream_id: 'binder-stream-3',
        name: 'binder-stream-3',
        agent_id: AGENT,
        metadata: { task_ref: taskRef },
      },
      { swarmId: SWARM, agentId: AGENT },
    );

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_MERGED,
      {
        source_stream_id: 'binder-stream-3',
        target_stream_id: 'main',
        merge_commit: 'merge-3',
        agent_id: AGENT,
        metadata: { task_ref: taskRef },
      },
      { swarmId: SWARM, agentId: AGENT },
    );

    await flushEventLoop();

    expect(remoteUpdateTask).not.toHaveBeenCalled();

    stopTaskBinder();

    // Reset metadata for subsequent tests.
    resourcesDAL.updateResource(taskResourceId, { metadata: { opentasks: true } });
  });

  it('skips events without a task_ref', async () => {
    getAggregateCapabilities.mockReturnValue({ cascade: { autoCloseOnMerge: true } });
    startTaskBinder({ defaultClosePolicy: 'on_merge' });

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      {
        stream_id: 'binder-stream-4',
        name: 'binder-stream-4',
        agent_id: AGENT,
        // no task_ref
      },
      { swarmId: SWARM, agentId: AGENT },
    );

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_MERGED,
      {
        source_stream_id: 'binder-stream-4',
        target_stream_id: 'main',
        merge_commit: 'merge-4',
        agent_id: AGENT,
        // no metadata.task_ref, stream wasn't opened with one either
      },
      { swarmId: SWARM, agentId: AGENT },
    );

    await flushEventLoop();

    expect(remoteUpdateTask).not.toHaveBeenCalled();

    stopTaskBinder();
  });
});
