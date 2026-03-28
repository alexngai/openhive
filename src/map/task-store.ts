/**
 * MAP Task Event Emitter
 *
 * Thin event layer for broadcasting task lifecycle events to connected
 * agents and the frontend via WebSocket. No data storage — OpenTasks
 * daemon owns all task state.
 */

import type { MAPTaskEvent } from './task-types.js';

type TaskEventCallback = (event: MAPTaskEvent, sourceSwarmId: string) => void;

export class MAPTaskStore {
  private listeners: TaskEventCallback[] = [];

  /**
   * Emit a task event to all registered listeners.
   * Called by the task handler after a successful daemon operation.
   */
  emit(event: MAPTaskEvent, sourceSwarmId: string): void {
    for (const cb of this.listeners) {
      try {
        cb(event, sourceSwarmId);
      } catch (err) {
        console.warn('[map-task-store] Event listener error:', err);
      }
    }
  }

  /**
   * Register a listener for task events.
   * Returns an unsubscribe function.
   */
  onTaskEvent(callback: TaskEventCallback): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: MAPTaskStore | null = null;

export function getMapTaskStore(): MAPTaskStore {
  if (!instance) {
    instance = new MAPTaskStore();
  }
  return instance;
}

export function resetMapTaskStore(): void {
  instance = null;
}
