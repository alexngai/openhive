/**
 * MAP Task Store
 *
 * In-memory store for MAP task state from connected agents. Tasks here are
 * ephemeral coordination state — the source of truth lives in each agent's
 * OpenTasks graph. When an agent disconnects, its tasks are cleaned up.
 *
 * This is intentionally separate from the coordination task DAL. MAP tasks
 * represent an agent's own task graph nodes, while coordination tasks are
 * OpenHive's inter-swarm delegation model.
 */

import { randomUUID } from 'crypto';
import type {
  MAPTask,
  MAPTaskEvent,
  TasksCreateParams,
  TasksAssignParams,
  TasksUpdateParams,
  TasksListParams,
  TasksListResult,
} from './task-types.js';

type TaskEventCallback = (event: MAPTaskEvent, sourceSwarmId: string) => void;

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

export class MAPTaskStore {
  /** taskId → MAPTask */
  private tasks = new Map<string, MAPTask>();
  /** taskId → swarmId that created it */
  private taskOwners = new Map<string, string>();
  /** Event listeners */
  private listeners: TaskEventCallback[] = [];

  // ==========================================================================
  // CRUD
  // ==========================================================================

  create(params: TasksCreateParams, sourceSwarmId: string): MAPTask {
    const id = params.task.id ?? randomUUID();
    const task: MAPTask = {
      id,
      title: params.task.title,
      status: params.task.status ?? 'open',
      description: params.task.description,
      assignee: params.task.assignee ?? null,
      meta: params.task.meta,
    };

    this.tasks.set(id, task);
    this.taskOwners.set(id, sourceSwarmId);

    this.emit({ type: 'task.created', data: { task } }, sourceSwarmId);
    return task;
  }

  assign(params: TasksAssignParams, sourceSwarmId: string): MAPTask {
    const task = this.tasks.get(params.taskId);
    if (!task) {
      throw new MAPTaskStoreError('TASK_NOT_FOUND', `Task ${params.taskId} not found`);
    }

    task.assignee = params.agentId;
    // Auto-transition to in_progress on assignment if currently open
    if (task.status === 'open') {
      const previous = task.status;
      task.status = 'in_progress';
      this.emit({ type: 'task.status', data: { taskId: task.id, previous, current: task.status } }, sourceSwarmId);
    }

    this.emit({ type: 'task.assigned', data: { taskId: task.id, agentId: params.agentId } }, sourceSwarmId);
    return task;
  }

  update(params: TasksUpdateParams, sourceSwarmId: string): MAPTask {
    const task = this.tasks.get(params.taskId);
    if (!task) {
      throw new MAPTaskStoreError('TASK_NOT_FOUND', `Task ${params.taskId} not found`);
    }

    const previousStatus = task.status;

    if (params.title !== undefined) task.title = params.title;
    if (params.description !== undefined) task.description = params.description;
    if (params.assignee !== undefined) task.assignee = params.assignee;
    if (params.meta !== undefined) task.meta = { ...task.meta, ...params.meta };
    if (params.status !== undefined) task.status = params.status;

    // Emit status change event
    if (params.status !== undefined && params.status !== previousStatus) {
      this.emit(
        { type: 'task.status', data: { taskId: task.id, previous: previousStatus, current: params.status } },
        sourceSwarmId,
      );

      // Emit completed event for terminal states
      if (params.status === 'completed' || params.status === 'failed') {
        this.emit({ type: 'task.completed', data: { taskId: task.id } }, sourceSwarmId);
      }
    }

    return task;
  }

  list(params?: TasksListParams): TasksListResult {
    let result = Array.from(this.tasks.values());

    // Apply filters
    if (params?.filter) {
      const { assignee, status } = params.filter;
      if (assignee) {
        result = result.filter((t) => t.assignee === assignee);
      }
      if (status) {
        const statuses = Array.isArray(status) ? status : [status];
        result = result.filter((t) => t.status && statuses.includes(t.status));
      }
    }

    // Cursor-based pagination
    const limit = Math.min(params?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    let startIdx = 0;
    if (params?.cursor) {
      const cursorIdx = result.findIndex((t) => t.id === params.cursor);
      if (cursorIdx >= 0) startIdx = cursorIdx + 1;
    }

    const page = result.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < result.length;

    return {
      tasks: page,
      hasMore,
      nextCursor: hasMore ? page[page.length - 1]?.id : undefined,
    };
  }

  get(taskId: string): MAPTask | undefined {
    return this.tasks.get(taskId);
  }

  getOwner(taskId: string): string | undefined {
    return this.taskOwners.get(taskId);
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Remove all tasks owned by a swarm (called on disconnect).
   * Emits task.status → failed for any non-terminal tasks.
   */
  removeBySwarm(swarmId: string): void {
    for (const [taskId, ownerId] of this.taskOwners) {
      if (ownerId !== swarmId) continue;

      const task = this.tasks.get(taskId);
      if (task && task.status !== 'completed' && task.status !== 'failed') {
        const previous = task.status;
        task.status = 'failed';
        this.emit(
          { type: 'task.status', data: { taskId, previous, current: 'failed' } },
          swarmId,
        );
        this.emit({ type: 'task.completed', data: { taskId } }, swarmId);
      }

      this.tasks.delete(taskId);
      this.taskOwners.delete(taskId);
    }
  }

  // ==========================================================================
  // Stats
  // ==========================================================================

  getStats(): { total: number; byStatus: Record<string, number>; bySwarm: Record<string, number> } {
    const byStatus: Record<string, number> = {};
    const bySwarm: Record<string, number> = {};

    for (const [taskId, task] of this.tasks) {
      const status = task.status ?? 'open';
      byStatus[status] = (byStatus[status] ?? 0) + 1;

      const owner = this.taskOwners.get(taskId) ?? 'unknown';
      bySwarm[owner] = (bySwarm[owner] ?? 0) + 1;
    }

    return { total: this.tasks.size, byStatus, bySwarm };
  }

  // ==========================================================================
  // Events
  // ==========================================================================

  onTaskEvent(callback: TaskEventCallback): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emit(event: MAPTaskEvent, sourceSwarmId: string): void {
    for (const cb of this.listeners) {
      try {
        cb(event, sourceSwarmId);
      } catch (err) {
        console.warn('[map-task-store] Event listener error:', err);
      }
    }
  }
}

// ============================================================================
// Errors
// ============================================================================

export type MAPTaskStoreErrorCode = 'TASK_NOT_FOUND' | 'INVALID_PARAMS';

export class MAPTaskStoreError extends Error {
  constructor(
    public code: MAPTaskStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MAPTaskStoreError';
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
