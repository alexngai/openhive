/**
 * MAP Task Request Handler
 *
 * Handles the four map/tasks/* JSON-RPC 2.0 request methods from the MAP SDK.
 * Pure dispatch: validates params, calls MAPTaskStore, returns result.
 */

import { MAP_TASK_METHODS } from './task-types.js';
import type {
  TasksCreateParams,
  TasksAssignParams,
  TasksUpdateParams,
  TasksListParams,
  TasksCreateResult,
  TasksAssignResult,
  TasksUpdateResult,
  TasksListResult,
} from './task-types.js';
import { MAPTaskStore, MAPTaskStoreError } from './task-store.js';

export interface TaskRequestContext {
  swarmId: string;
  agentId: string;
}

/**
 * Handle a map/tasks/* JSON-RPC request.
 * Returns the result object on success, throws on error.
 */
export function handleTaskRequest(
  method: string,
  params: unknown,
  context: TaskRequestContext,
  store: MAPTaskStore,
): TasksCreateResult | TasksAssignResult | TasksUpdateResult | TasksListResult {
  switch (method) {
    case MAP_TASK_METHODS.CREATE: {
      const p = params as TasksCreateParams;
      if (!p?.task || typeof p.task !== 'object') {
        throw new MAPTaskRequestError(-32602, 'Invalid params: missing task object');
      }
      const task = store.create(p, context.swarmId);
      return { task };
    }

    case MAP_TASK_METHODS.ASSIGN: {
      const p = params as TasksAssignParams;
      if (!p?.taskId || !p?.agentId) {
        throw new MAPTaskRequestError(-32602, 'Invalid params: missing taskId or agentId');
      }
      const task = store.assign(p, context.swarmId);
      return { task };
    }

    case MAP_TASK_METHODS.UPDATE: {
      const p = params as TasksUpdateParams;
      if (!p?.taskId) {
        throw new MAPTaskRequestError(-32602, 'Invalid params: missing taskId');
      }
      const task = store.update(p, context.swarmId);
      return { task };
    }

    case MAP_TASK_METHODS.LIST: {
      const p = (params ?? {}) as TasksListParams;
      return store.list(p);
    }

    default:
      throw new MAPTaskRequestError(-32601, `Unknown task method: ${method}`);
  }
}

// ============================================================================
// Errors
// ============================================================================

export class MAPTaskRequestError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'MAPTaskRequestError';
  }

  toJsonRpcError(): { code: number; message: string } {
    return { code: this.code, message: this.message };
  }
}

/**
 * Convert a store error to a JSON-RPC error code.
 */
export function storeErrorToJsonRpc(err: MAPTaskStoreError): { code: number; message: string } {
  switch (err.code) {
    case 'TASK_NOT_FOUND':
      return { code: -32001, message: err.message };
    case 'INVALID_PARAMS':
      return { code: -32602, message: err.message };
    default:
      return { code: -32603, message: err.message };
  }
}
