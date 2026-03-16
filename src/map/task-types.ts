/**
 * MAP Task Wire Protocol Types
 *
 * Matches the @multi-agent-protocol/sdk task method shapes.
 * Wire methods: map/tasks/create, map/tasks/assign, map/tasks/update, map/tasks/list
 * Events: task.created, task.assigned, task.status, task.completed
 */

// ============================================================================
// Core Task Types
// ============================================================================

export type MAPTaskStatus = 'open' | 'in_progress' | 'blocked' | 'completed' | 'failed';

export interface MAPTask {
  id: string;
  title?: string;
  status?: MAPTaskStatus;
  description?: string;
  assignee?: string | null;
  meta?: Record<string, unknown>;
}

// ============================================================================
// JSON-RPC Method Names (from MAP SDK TASK_METHODS)
// ============================================================================

export const MAP_TASK_METHODS = {
  CREATE: 'map/tasks/create',
  ASSIGN: 'map/tasks/assign',
  UPDATE: 'map/tasks/update',
  LIST: 'map/tasks/list',
} as const;

export type MAPTaskMethod = (typeof MAP_TASK_METHODS)[keyof typeof MAP_TASK_METHODS];

/** Set for fast lookup */
export const MAP_TASK_METHOD_SET = new Set<string>(Object.values(MAP_TASK_METHODS));

// ============================================================================
// Request Parameter Types
// ============================================================================

export interface TasksCreateParams {
  task: Omit<MAPTask, 'id'> & { id?: string };
}

export interface TasksAssignParams {
  taskId: string;
  agentId: string;
}

export interface TasksUpdateParams {
  taskId: string;
  status?: MAPTaskStatus;
  title?: string;
  description?: string;
  assignee?: string | null;
  meta?: Record<string, unknown>;
}

export interface TasksListParams {
  filter?: {
    assignee?: string;
    status?: MAPTaskStatus | MAPTaskStatus[];
  };
  limit?: number;
  cursor?: string;
}

// ============================================================================
// Response Types
// ============================================================================

export interface TasksCreateResult {
  task: MAPTask;
}

export interface TasksAssignResult {
  task: MAPTask;
}

export interface TasksUpdateResult {
  task: MAPTask;
}

export interface TasksListResult {
  tasks: MAPTask[];
  hasMore: boolean;
  nextCursor?: string;
}

// ============================================================================
// Event Types (sent as map/event notifications)
// ============================================================================

export type MAPTaskEventType = 'task.created' | 'task.assigned' | 'task.status' | 'task.completed';

export interface MAPTaskEvent {
  type: MAPTaskEventType;
  data: Record<string, unknown>;
  _origin?: string;
}
