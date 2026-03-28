/**
 * Tests for MAP task request handler (unified, async, daemon-routed):
 * - Routes map/tasks/* methods to daemon via IPC
 * - Validates required params
 * - Emits events to the store after daemon operations
 * - Resolves graph target from connection registry
 * - Handles errors properly
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAPTaskStore } from '../../map/task-store.js';
import { MAP_TASK_METHODS } from '../../map/task-types.js';
import type { MAPTaskEvent } from '../../map/task-types.js';

// Mock daemon client
const mockDaemonCreateTask = vi.fn();
const mockDaemonUpdateTask = vi.fn();
const mockDaemonAssignTask = vi.fn();
const mockDaemonListTasks = vi.fn();
const mockResolveDaemonSocket = vi.fn((_path?: string) => '/tmp/test.sock');

vi.mock('../../map/task-daemon-client.js', () => ({
  daemonCreateTask: (...args: any[]) => mockDaemonCreateTask(...args),
  daemonUpdateTask: (...args: any[]) => mockDaemonUpdateTask(...args),
  daemonAssignTask: (...args: any[]) => mockDaemonAssignTask(...args),
  daemonListTasks: (...args: any[]) => mockDaemonListTasks(...args),
  resolveDaemonSocket: (_path: string) => mockResolveDaemonSocket(_path),
}));

// Mock resource DAL — return a resource that passes validateOpenTasksResource
const fakeResource = {
  resource_type: 'task',
  git_remote_url: '/tmp/test/.opentasks',
  local_path: '/tmp/test/.opentasks',
  metadata: { opentasks: true },
};
vi.mock('../../db/dal/syncable-resources.js', () => ({
  findResourceById: vi.fn(),
  findResourceByLocalPath: vi.fn(),
  findResourceByLocationHash: vi.fn(),
  canAccessResource: vi.fn(() => true),
  upsertDiscoveredResource: vi.fn(() => ({ resource: fakeResource })),
}));

// Mock connection registry — return a default task graph so resolveGraphTarget succeeds
const mockGetDefaultTaskGraph = vi.fn();
vi.mock('../../map/connection-registry.js', () => ({
  getDefaultTaskGraph: (...args: unknown[]) => mockGetDefaultTaskGraph(...args),
}));

// Mock fs calls used in resolveGraphTarget
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
  readFileSync: vi.fn(() => '{}'),
  realpathSync: vi.fn((p: string) => p),
}));

import { handleTaskRequest, MAPTaskRequestError } from '../../map/task-handler.js';

describe('handleTaskRequest', () => {
  let store: MAPTaskStore;
  const ctx = { swarmId: 'swarm-1', agentId: 'agent-1' };

  beforeEach(() => {
    store = new MAPTaskStore();
    vi.clearAllMocks();
    // Default: provide a path-based target so resolveGraphTarget resolves
    mockGetDefaultTaskGraph.mockReturnValue({ path: '/tmp/test/.opentasks' });
  });

  // ==========================================================================
  // map/tasks/create
  // ==========================================================================

  describe('map/tasks/create', () => {
    it('calls daemonCreateTask and returns the task', async () => {
      const fakeTask = { id: 'task-1', title: 'New task', status: 'open' };
      mockDaemonCreateTask.mockResolvedValue(fakeTask);

      const result = await handleTaskRequest(
        MAP_TASK_METHODS.CREATE,
        { task: { title: 'New task', status: 'open' } },
        ctx,
        store,
      );

      expect(mockDaemonCreateTask).toHaveBeenCalledTimes(1);
      expect(result).toHaveProperty('task');
      expect((result as { task: { title: string } }).task.title).toBe('New task');
    });

    it('emits task.created event after daemon call', async () => {
      const fakeTask = { id: 'task-1', title: 'T', status: 'open' };
      mockDaemonCreateTask.mockResolvedValue(fakeTask);

      const events: MAPTaskEvent[] = [];
      store.onTaskEvent((event) => events.push(event));

      await handleTaskRequest(MAP_TASK_METHODS.CREATE, { task: { title: 'T' } }, ctx, store);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.created');
    });

    it('throws MAPTaskRequestError on missing task param', async () => {
      await expect(handleTaskRequest(MAP_TASK_METHODS.CREATE, {}, ctx, store))
        .rejects.toThrow(MAPTaskRequestError);
    });

    it('throws MAPTaskRequestError on null params', async () => {
      await expect(handleTaskRequest(MAP_TASK_METHODS.CREATE, null, ctx, store))
        .rejects.toThrow(MAPTaskRequestError);
    });
  });

  // ==========================================================================
  // map/tasks/update
  // ==========================================================================

  describe('map/tasks/update', () => {
    it('calls daemonUpdateTask and returns the task', async () => {
      const fakeTask = { id: 'task-1', title: 'Updated', status: 'in_progress' };
      mockDaemonUpdateTask.mockResolvedValue(fakeTask);

      const result = await handleTaskRequest(
        MAP_TASK_METHODS.UPDATE,
        { taskId: 'task-1', status: 'in_progress' },
        ctx,
        store,
      );

      expect(mockDaemonUpdateTask).toHaveBeenCalledTimes(1);
      expect((result as { task: { status: string } }).task.status).toBe('in_progress');
    });

    it('emits task.status event on status change', async () => {
      mockDaemonUpdateTask.mockResolvedValue({ id: 'task-1', status: 'in_progress' });

      const events: MAPTaskEvent[] = [];
      store.onTaskEvent((event) => events.push(event));

      await handleTaskRequest(
        MAP_TASK_METHODS.UPDATE,
        { taskId: 'task-1', status: 'in_progress' },
        ctx,
        store,
      );

      const statusEvent = events.find((e) => e.type === 'task.status');
      expect(statusEvent).toBeTruthy();
      expect(statusEvent!.data).toEqual({ taskId: 'task-1', previous: null, current: 'in_progress' });
    });

    it('throws MAPTaskRequestError on missing taskId', async () => {
      await expect(handleTaskRequest(MAP_TASK_METHODS.UPDATE, { status: 'completed' }, ctx, store))
        .rejects.toThrow(MAPTaskRequestError);
    });
  });

  // ==========================================================================
  // map/tasks/assign
  // ==========================================================================

  describe('map/tasks/assign', () => {
    it('calls daemonAssignTask and returns the task', async () => {
      const fakeTask = { id: 'task-1', assignee: 'alice', status: 'in_progress' };
      mockDaemonAssignTask.mockResolvedValue(fakeTask);

      const result = await handleTaskRequest(
        MAP_TASK_METHODS.ASSIGN,
        { taskId: 'task-1', agentId: 'alice' },
        ctx,
        store,
      );

      expect(mockDaemonAssignTask).toHaveBeenCalledTimes(1);
      expect((result as { task: { assignee: string } }).task.assignee).toBe('alice');
    });

    it('emits task.assigned event after daemon call', async () => {
      mockDaemonAssignTask.mockResolvedValue({ id: 'task-1', assignee: 'alice' });

      const events: MAPTaskEvent[] = [];
      store.onTaskEvent((event) => events.push(event));

      await handleTaskRequest(
        MAP_TASK_METHODS.ASSIGN,
        { taskId: 'task-1', agentId: 'alice' },
        ctx,
        store,
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.assigned');
      expect(events[0].data).toEqual({ taskId: 'task-1', agentId: 'alice' });
    });

    it('throws MAPTaskRequestError on missing taskId', async () => {
      await expect(handleTaskRequest(MAP_TASK_METHODS.ASSIGN, { agentId: 'alice' }, ctx, store))
        .rejects.toThrow(MAPTaskRequestError);
    });

    it('throws MAPTaskRequestError on missing agentId', async () => {
      await expect(handleTaskRequest(MAP_TASK_METHODS.ASSIGN, { taskId: 'task-1' }, ctx, store))
        .rejects.toThrow(MAPTaskRequestError);
    });
  });

  // ==========================================================================
  // map/tasks/list
  // ==========================================================================

  describe('map/tasks/list', () => {
    it('calls daemonListTasks and returns result', async () => {
      mockDaemonListTasks.mockResolvedValue({ tasks: [{ id: 't1' }, { id: 't2' }], hasMore: false });

      const result = await handleTaskRequest(MAP_TASK_METHODS.LIST, {}, ctx, store);

      expect(mockDaemonListTasks).toHaveBeenCalledTimes(1);
      expect(result).toHaveProperty('tasks');
      expect((result as { tasks: unknown[] }).tasks).toHaveLength(2);
      expect(result).toHaveProperty('hasMore', false);
    });

    it('handles null params (defaults)', async () => {
      mockDaemonListTasks.mockResolvedValue({ tasks: [], hasMore: false });

      const result = await handleTaskRequest(MAP_TASK_METHODS.LIST, null, ctx, store);
      expect((result as { tasks: unknown[] }).tasks).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Unknown method
  // ==========================================================================

  it('throws MAPTaskRequestError on unknown method', async () => {
    await expect(handleTaskRequest('map/tasks/delete', {}, ctx, store))
      .rejects.toThrow(MAPTaskRequestError);
  });

  // ==========================================================================
  // Graph target resolution
  // ==========================================================================

  describe('graph target resolution', () => {
    it('throws error -32002 when no graph target is available', async () => {
      mockGetDefaultTaskGraph.mockReturnValue(undefined);

      try {
        await handleTaskRequest(
          MAP_TASK_METHODS.LIST,
          {},
          ctx,
          store,
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MAPTaskRequestError);
        expect((err as MAPTaskRequestError).code).toBe(-32002);
      }
    });

    it('uses connection default when no per-request target', async () => {
      mockGetDefaultTaskGraph.mockReturnValue({ path: '/custom/.opentasks' });
      mockDaemonListTasks.mockResolvedValue({ tasks: [], hasMore: false });

      await handleTaskRequest(MAP_TASK_METHODS.LIST, {}, ctx, store);

      expect(mockGetDefaultTaskGraph).toHaveBeenCalledWith('swarm-1');
    });
  });
});
