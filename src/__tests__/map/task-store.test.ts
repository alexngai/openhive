/**
 * Tests for MAPTaskStore (event-emitter-only API):
 * - emit() broadcasts to listeners
 * - onTaskEvent() returns unsubscribe function
 * - Unsubscribe works
 * - Multiple listeners
 * - Listener errors are caught gracefully
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAPTaskStore } from '../../map/task-store.js';
import type { MAPTaskEvent } from '../../map/task-types.js';

describe('MAPTaskStore', () => {
  let store: MAPTaskStore;

  beforeEach(() => {
    store = new MAPTaskStore();
  });

  // ==========================================================================
  // emit
  // ==========================================================================

  describe('emit', () => {
    it('calls registered listeners with event and sourceSwarmId', () => {
      const received: Array<{ event: MAPTaskEvent; swarmId: string }> = [];
      store.onTaskEvent((event, swarmId) => received.push({ event, swarmId }));

      const event: MAPTaskEvent = { type: 'task.created', data: { task: { id: 't1' } } };
      store.emit(event, 'swarm-1');

      expect(received).toHaveLength(1);
      expect(received[0].event).toBe(event);
      expect(received[0].swarmId).toBe('swarm-1');
    });

    it('calls multiple listeners', () => {
      const calls1: MAPTaskEvent[] = [];
      const calls2: MAPTaskEvent[] = [];
      store.onTaskEvent((event) => calls1.push(event));
      store.onTaskEvent((event) => calls2.push(event));

      const event: MAPTaskEvent = { type: 'task.status', data: { taskId: 't1', current: 'completed' } };
      store.emit(event, 'swarm-1');

      expect(calls1).toHaveLength(1);
      expect(calls2).toHaveLength(1);
    });

    it('does nothing when no listeners registered', () => {
      // Should not throw
      expect(() => store.emit({ type: 'task.created', data: {} }, 'swarm-1')).not.toThrow();
    });
  });

  // ==========================================================================
  // onTaskEvent
  // ==========================================================================

  describe('onTaskEvent', () => {
    it('returns an unsubscribe function', () => {
      const unsub = store.onTaskEvent(() => {});
      expect(typeof unsub).toBe('function');
    });

    it('unsubscribe stops future events', () => {
      const events: MAPTaskEvent[] = [];
      const unsub = store.onTaskEvent((event) => events.push(event));

      store.emit({ type: 'task.created', data: { task: { id: 't1' } } }, 'swarm-1');
      expect(events).toHaveLength(1);

      unsub();
      store.emit({ type: 'task.created', data: { task: { id: 't2' } } }, 'swarm-1');
      expect(events).toHaveLength(1); // no new event
    });

    it('unsubscribe is idempotent', () => {
      const events: MAPTaskEvent[] = [];
      const unsub = store.onTaskEvent((event) => events.push(event));

      unsub();
      unsub(); // second call should not throw

      store.emit({ type: 'task.created', data: {} }, 'swarm-1');
      expect(events).toHaveLength(0);
    });

    it('only removes the specific listener on unsubscribe', () => {
      const calls1: MAPTaskEvent[] = [];
      const calls2: MAPTaskEvent[] = [];
      const unsub1 = store.onTaskEvent((event) => calls1.push(event));
      store.onTaskEvent((event) => calls2.push(event));

      unsub1();
      store.emit({ type: 'task.assigned', data: { taskId: 't1', agentId: 'a1' } }, 'swarm-1');

      expect(calls1).toHaveLength(0);
      expect(calls2).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Error handling
  // ==========================================================================

  describe('listener error handling', () => {
    it('catches listener errors without throwing', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      store.onTaskEvent(() => { throw new Error('boom'); });

      expect(() => store.emit({ type: 'task.created', data: {} }, 'swarm-1')).not.toThrow();
      consoleSpy.mockRestore();
    });

    it('continues calling remaining listeners after one throws', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const events: MAPTaskEvent[] = [];

      store.onTaskEvent(() => { throw new Error('first fails'); });
      store.onTaskEvent((event) => events.push(event));

      store.emit({ type: 'task.status', data: { taskId: 't1' } }, 'swarm-1');

      expect(events).toHaveLength(1);
      consoleSpy.mockRestore();
    });
  });
});
