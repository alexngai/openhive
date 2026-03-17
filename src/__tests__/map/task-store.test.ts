/**
 * Tests for MAPTaskStore:
 * - CRUD operations (create, assign, update, list)
 * - Filtering and pagination
 * - Event emission
 * - Cleanup on swarm disconnect
 * - Stats aggregation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAPTaskStore, MAPTaskStoreError } from '../../map/task-store.js';
import type { MAPTaskEvent } from '../../map/task-types.js';

describe('MAPTaskStore', () => {
  let store: MAPTaskStore;

  beforeEach(() => {
    store = new MAPTaskStore();
  });

  // ==========================================================================
  // Create
  // ==========================================================================

  describe('create', () => {
    it('creates a task with generated id', () => {
      const task = store.create({ task: { title: 'Test task', status: 'open' } }, 'swarm-1');
      expect(task.id).toBeTruthy();
      expect(task.title).toBe('Test task');
      expect(task.status).toBe('open');
    });

    it('creates a task with provided id', () => {
      const task = store.create({ task: { id: 'custom-id', title: 'Custom' } }, 'swarm-1');
      expect(task.id).toBe('custom-id');
    });

    it('defaults status to open', () => {
      const task = store.create({ task: { title: 'No status' } }, 'swarm-1');
      expect(task.status).toBe('open');
    });

    it('stores assignee and meta', () => {
      const task = store.create({
        task: { title: 'Full', assignee: 'agent-1', meta: { priority: 3 } },
      }, 'swarm-1');
      expect(task.assignee).toBe('agent-1');
      expect(task.meta).toEqual({ priority: 3 });
    });

    it('emits task.created event', () => {
      const events: MAPTaskEvent[] = [];
      store.onTaskEvent((event) => events.push(event));

      store.create({ task: { title: 'Emit test' } }, 'swarm-1');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.created');
      expect((events[0].data as { task: { title: string } }).task.title).toBe('Emit test');
    });
  });

  // ==========================================================================
  // Assign
  // ==========================================================================

  describe('assign', () => {
    it('assigns an agent to a task', () => {
      store.create({ task: { id: 'task-1', title: 'Assignable' } }, 'swarm-1');
      const updated = store.assign({ taskId: 'task-1', agentId: 'agent-alice' }, 'swarm-1');

      expect(updated.assignee).toBe('agent-alice');
    });

    it('auto-transitions open → in_progress on assignment', () => {
      store.create({ task: { id: 'task-1', title: 'Open', status: 'open' } }, 'swarm-1');
      const updated = store.assign({ taskId: 'task-1', agentId: 'agent-1' }, 'swarm-1');

      expect(updated.status).toBe('in_progress');
    });

    it('does not change status if not open', () => {
      store.create({ task: { id: 'task-1', title: 'Blocked', status: 'blocked' } }, 'swarm-1');
      const updated = store.assign({ taskId: 'task-1', agentId: 'agent-1' }, 'swarm-1');

      expect(updated.status).toBe('blocked');
    });

    it('throws TASK_NOT_FOUND for unknown task', () => {
      expect(() => store.assign({ taskId: 'nonexistent', agentId: 'agent-1' }, 'swarm-1'))
        .toThrow(MAPTaskStoreError);
    });

    it('emits task.assigned event', () => {
      store.create({ task: { id: 'task-1', title: 'E' } }, 'swarm-1');

      const events: MAPTaskEvent[] = [];
      store.onTaskEvent((event) => events.push(event));

      store.assign({ taskId: 'task-1', agentId: 'agent-1' }, 'swarm-1');

      const assigned = events.find((e) => e.type === 'task.assigned');
      expect(assigned).toBeTruthy();
      expect(assigned!.data).toEqual({ taskId: 'task-1', agentId: 'agent-1' });
    });
  });

  // ==========================================================================
  // Update
  // ==========================================================================

  describe('update', () => {
    it('updates task fields', () => {
      store.create({ task: { id: 'task-1', title: 'Original' } }, 'swarm-1');
      const updated = store.update({ taskId: 'task-1', title: 'Updated', description: 'desc' }, 'swarm-1');

      expect(updated.title).toBe('Updated');
      expect(updated.description).toBe('desc');
    });

    it('merges meta fields', () => {
      store.create({ task: { id: 'task-1', title: 'Meta', meta: { a: 1 } } }, 'swarm-1');
      const updated = store.update({ taskId: 'task-1', meta: { b: 2 } }, 'swarm-1');

      expect(updated.meta).toEqual({ a: 1, b: 2 });
    });

    it('emits task.status event on status change', () => {
      store.create({ task: { id: 'task-1', title: 'S', status: 'open' } }, 'swarm-1');

      const events: MAPTaskEvent[] = [];
      store.onTaskEvent((event) => events.push(event));

      store.update({ taskId: 'task-1', status: 'in_progress' }, 'swarm-1');

      const statusEvent = events.find((e) => e.type === 'task.status');
      expect(statusEvent).toBeTruthy();
      expect(statusEvent!.data).toEqual({ taskId: 'task-1', previous: 'open', current: 'in_progress' });
    });

    it('emits task.completed on completed status', () => {
      store.create({ task: { id: 'task-1', title: 'C', status: 'in_progress' } }, 'swarm-1');

      const events: MAPTaskEvent[] = [];
      store.onTaskEvent((event) => events.push(event));

      store.update({ taskId: 'task-1', status: 'completed' }, 'swarm-1');

      const completedEvent = events.find((e) => e.type === 'task.completed');
      expect(completedEvent).toBeTruthy();
    });

    it('throws TASK_NOT_FOUND for unknown task', () => {
      expect(() => store.update({ taskId: 'nonexistent', status: 'completed' }, 'swarm-1'))
        .toThrow(MAPTaskStoreError);
    });
  });

  // ==========================================================================
  // List
  // ==========================================================================

  describe('list', () => {
    beforeEach(() => {
      store.create({ task: { id: 't1', title: 'A', status: 'open', assignee: 'alice' } }, 'swarm-1');
      store.create({ task: { id: 't2', title: 'B', status: 'in_progress', assignee: 'bob' } }, 'swarm-1');
      store.create({ task: { id: 't3', title: 'C', status: 'completed', assignee: 'alice' } }, 'swarm-2');
    });

    it('returns all tasks without filter', () => {
      const result = store.list();
      expect(result.tasks).toHaveLength(3);
      expect(result.hasMore).toBe(false);
    });

    it('filters by assignee', () => {
      const result = store.list({ filter: { assignee: 'alice' } });
      expect(result.tasks).toHaveLength(2);
    });

    it('filters by single status', () => {
      const result = store.list({ filter: { status: 'open' } });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe('t1');
    });

    it('filters by multiple statuses', () => {
      const result = store.list({ filter: { status: ['open', 'in_progress'] } });
      expect(result.tasks).toHaveLength(2);
    });

    it('paginates with limit', () => {
      const result = store.list({ limit: 2 });
      expect(result.tasks).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeTruthy();
    });

    it('paginates with cursor', () => {
      const first = store.list({ limit: 2 });
      const second = store.list({ cursor: first.nextCursor, limit: 2 });
      expect(second.tasks).toHaveLength(1);
      expect(second.hasMore).toBe(false);
    });
  });

  // ==========================================================================
  // Get / GetOwner
  // ==========================================================================

  describe('get / getOwner', () => {
    it('returns task by id', () => {
      store.create({ task: { id: 'task-1', title: 'Find me' } }, 'swarm-1');
      expect(store.get('task-1')?.title).toBe('Find me');
    });

    it('returns undefined for missing task', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('returns owner swarm id', () => {
      store.create({ task: { id: 'task-1', title: 'Owned' } }, 'swarm-42');
      expect(store.getOwner('task-1')).toBe('swarm-42');
    });
  });

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  describe('removeBySwarm', () => {
    it('removes all tasks owned by a swarm', () => {
      store.create({ task: { id: 't1', title: 'A' } }, 'swarm-1');
      store.create({ task: { id: 't2', title: 'B' } }, 'swarm-1');
      store.create({ task: { id: 't3', title: 'C' } }, 'swarm-2');

      store.removeBySwarm('swarm-1');

      expect(store.get('t1')).toBeUndefined();
      expect(store.get('t2')).toBeUndefined();
      expect(store.get('t3')).toBeTruthy();
    });

    it('emits task.status → failed for non-terminal tasks', () => {
      store.create({ task: { id: 't1', title: 'Open', status: 'open' } }, 'swarm-1');
      store.create({ task: { id: 't2', title: 'Done', status: 'completed' } }, 'swarm-1');

      const events: MAPTaskEvent[] = [];
      store.onTaskEvent((event) => events.push(event));

      store.removeBySwarm('swarm-1');

      // Only t1 should get a failed status event (t2 is already completed)
      const statusEvents = events.filter((e) => e.type === 'task.status');
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].data).toEqual({ taskId: 't1', previous: 'open', current: 'failed' });
    });
  });

  // ==========================================================================
  // Stats
  // ==========================================================================

  describe('getStats', () => {
    it('returns aggregate stats', () => {
      store.create({ task: { id: 't1', status: 'open' } }, 'swarm-1');
      store.create({ task: { id: 't2', status: 'open' } }, 'swarm-1');
      store.create({ task: { id: 't3', status: 'completed' } }, 'swarm-2');

      const stats = store.getStats();
      expect(stats.total).toBe(3);
      expect(stats.byStatus).toEqual({ open: 2, completed: 1 });
      expect(stats.bySwarm).toEqual({ 'swarm-1': 2, 'swarm-2': 1 });
    });
  });

  // ==========================================================================
  // Event Listener Management
  // ==========================================================================

  describe('event listeners', () => {
    it('unsubscribes via returned function', () => {
      const events: MAPTaskEvent[] = [];
      const unsub = store.onTaskEvent((event) => events.push(event));

      store.create({ task: { title: 'Before' } }, 'swarm-1');
      expect(events).toHaveLength(1);

      unsub();
      store.create({ task: { title: 'After' } }, 'swarm-1');
      expect(events).toHaveLength(1); // no new event
    });

    it('handles listener errors gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      store.onTaskEvent(() => { throw new Error('boom'); });

      // Should not throw
      expect(() => store.create({ task: { title: 'Safe' } }, 'swarm-1')).not.toThrow();
      consoleSpy.mockRestore();
    });
  });
});
