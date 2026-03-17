/**
 * Tests for MAP task request handler:
 * - Dispatches map/tasks/* methods to the store
 * - Validates required params
 * - Returns correct result shapes
 * - Handles errors properly
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleTaskRequest, MAPTaskRequestError, storeErrorToJsonRpc } from '../../map/task-handler.js';
import { MAPTaskStore, MAPTaskStoreError } from '../../map/task-store.js';
import { MAP_TASK_METHODS } from '../../map/task-types.js';

describe('handleTaskRequest', () => {
  let store: MAPTaskStore;
  const ctx = { swarmId: 'swarm-1', agentId: 'agent-1' };

  beforeEach(() => {
    store = new MAPTaskStore();
  });

  // ==========================================================================
  // map/tasks/create
  // ==========================================================================

  describe('map/tasks/create', () => {
    it('creates a task and returns it', () => {
      const result = handleTaskRequest(
        MAP_TASK_METHODS.CREATE,
        { task: { title: 'New task', status: 'open' } },
        ctx,
        store,
      );

      expect(result).toHaveProperty('task');
      expect((result as { task: { title: string } }).task.title).toBe('New task');
    });

    it('throws on missing task param', () => {
      expect(() => handleTaskRequest(MAP_TASK_METHODS.CREATE, {}, ctx, store))
        .toThrow(MAPTaskRequestError);
    });

    it('throws on null params', () => {
      expect(() => handleTaskRequest(MAP_TASK_METHODS.CREATE, null, ctx, store))
        .toThrow(MAPTaskRequestError);
    });
  });

  // ==========================================================================
  // map/tasks/assign
  // ==========================================================================

  describe('map/tasks/assign', () => {
    it('assigns a task and returns it', () => {
      store.create({ task: { id: 'task-1', title: 'T' } }, 'swarm-1');

      const result = handleTaskRequest(
        MAP_TASK_METHODS.ASSIGN,
        { taskId: 'task-1', agentId: 'alice' },
        ctx,
        store,
      );

      expect((result as { task: { assignee: string } }).task.assignee).toBe('alice');
    });

    it('throws on missing taskId', () => {
      expect(() => handleTaskRequest(MAP_TASK_METHODS.ASSIGN, { agentId: 'alice' }, ctx, store))
        .toThrow(MAPTaskRequestError);
    });

    it('throws on missing agentId', () => {
      expect(() => handleTaskRequest(MAP_TASK_METHODS.ASSIGN, { taskId: 'task-1' }, ctx, store))
        .toThrow(MAPTaskRequestError);
    });
  });

  // ==========================================================================
  // map/tasks/update
  // ==========================================================================

  describe('map/tasks/update', () => {
    it('updates a task and returns it', () => {
      store.create({ task: { id: 'task-1', title: 'Original', status: 'open' } }, 'swarm-1');

      const result = handleTaskRequest(
        MAP_TASK_METHODS.UPDATE,
        { taskId: 'task-1', status: 'in_progress' },
        ctx,
        store,
      );

      expect((result as { task: { status: string } }).task.status).toBe('in_progress');
    });

    it('throws on missing taskId', () => {
      expect(() => handleTaskRequest(MAP_TASK_METHODS.UPDATE, { status: 'completed' }, ctx, store))
        .toThrow(MAPTaskRequestError);
    });
  });

  // ==========================================================================
  // map/tasks/list
  // ==========================================================================

  describe('map/tasks/list', () => {
    it('returns task list', () => {
      store.create({ task: { id: 't1', title: 'A' } }, 'swarm-1');
      store.create({ task: { id: 't2', title: 'B' } }, 'swarm-1');

      const result = handleTaskRequest(MAP_TASK_METHODS.LIST, {}, ctx, store);

      expect(result).toHaveProperty('tasks');
      expect((result as { tasks: unknown[] }).tasks).toHaveLength(2);
      expect(result).toHaveProperty('hasMore', false);
    });

    it('handles null params (defaults)', () => {
      const result = handleTaskRequest(MAP_TASK_METHODS.LIST, null, ctx, store);
      expect((result as { tasks: unknown[] }).tasks).toHaveLength(0);
    });

    it('passes filters through', () => {
      store.create({ task: { id: 't1', title: 'A', status: 'open' } }, 'swarm-1');
      store.create({ task: { id: 't2', title: 'B', status: 'completed' } }, 'swarm-1');

      const result = handleTaskRequest(
        MAP_TASK_METHODS.LIST,
        { filter: { status: 'open' } },
        ctx,
        store,
      );

      expect((result as { tasks: unknown[] }).tasks).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Unknown method
  // ==========================================================================

  it('throws on unknown method', () => {
    expect(() => handleTaskRequest('map/tasks/delete', {}, ctx, store))
      .toThrow(MAPTaskRequestError);
  });

  // ==========================================================================
  // Error conversion
  // ==========================================================================

  describe('storeErrorToJsonRpc', () => {
    it('maps TASK_NOT_FOUND to -32001', () => {
      const err = new MAPTaskStoreError('TASK_NOT_FOUND', 'Not found');
      const rpc = storeErrorToJsonRpc(err);
      expect(rpc.code).toBe(-32001);
    });

    it('maps INVALID_PARAMS to -32602', () => {
      const err = new MAPTaskStoreError('INVALID_PARAMS', 'Bad params');
      const rpc = storeErrorToJsonRpc(err);
      expect(rpc.code).toBe(-32602);
    });
  });
});
