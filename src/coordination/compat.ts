/**
 * Coordination Compatibility Shim
 *
 * Translates MAP task events (task.created, task.status) into OpenTasks
 * graph mutations. When swarms report task activity via MAP scope messages,
 * this shim writes the data into the swarm's OpenTasks graph.jsonl file.
 *
 * The shim writes directly to the swarm's OpenTasks graph.jsonl file,
 * mirroring the behavior of map/opentasks/create-task and
 * map/opentasks/update-status.
 */

import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import * as resourcesDAL from '../db/dal/syncable-resources.js';
import type { TaskAssignParams, TaskStatusParams } from './types.js';

/**
 * Translate a legacy task.assign into an OpenTasks graph append.
 *
 * Finds a task-type OpenTasks resource owned by the agent and appends
 * a new task node to its graph.jsonl.
 *
 * Returns the created node ID, or null if no OpenTasks resource was found
 * (task is dropped — coordination_tasks table is no longer used).
 */
export function shimTaskAssign(
  params: TaskAssignParams,
  agentId: string,
): string | null {
  const resource = findOpenTasksResource(agentId);
  if (!resource) return null;

  const graphPath = resolveGraphPath(resource);
  if (!graphPath) return null;

  const nodeId = `task_${nanoid()}`;
  const node = {
    id: nodeId,
    type: 'task',
    title: params.title,
    description: params.description || '',
    status: 'open',
    priority: priorityToNumber(params.priority),
    archived: false,
    created_at: new Date().toISOString(),
    // Preserve coordination metadata for traceability
    _coordination: {
      assigned_by: params.assigned_by,
      assigned_to_swarm: params.assigned_to_swarm,
      hive_id: params.hive_id,
      deadline: params.deadline,
    },
    ...(params.context || {}),
  };

  appendFileSync(graphPath, JSON.stringify(node) + '\n');
  return nodeId;
}

/**
 * Translate a legacy task.status into an OpenTasks graph append.
 *
 * Finds the task node in the graph and appends a status update.
 * Returns true if the shim handled it, false if no OpenTasks resource was found.
 */
export function shimTaskStatus(
  params: TaskStatusParams,
  agentId: string,
): boolean {
  const resource = findOpenTasksResource(agentId);
  if (!resource) return false;

  const graphPath = resolveGraphPath(resource);
  if (!graphPath) return false;

  // Map coordination statuses to OpenTasks statuses
  const statusMap: Record<string, string> = {
    accepted: 'in_progress',
    in_progress: 'in_progress',
    completed: 'completed',
    failed: 'failed',
    rejected: 'failed',
  };

  const update: Record<string, unknown> = {
    id: params.task_id,
    type: 'task',
    status: statusMap[params.status] || params.status,
    updated_at: new Date().toISOString(),
  };
  if (params.result) update.result = params.result;
  if (params.error) update.error = params.error;
  if (params.progress !== undefined) update.progress = params.progress;

  appendFileSync(graphPath, JSON.stringify(update) + '\n');
  return true;
}

// ============================================================================
// Helpers
// ============================================================================

/** Find the first OpenTasks resource owned by or accessible to this agent */
function findOpenTasksResource(agentId: string): ReturnType<typeof resourcesDAL.findResourceById> {
  const { data } = resourcesDAL.listAccessibleResources({
    agentId,
    resourceType: 'task',
    limit: 1,
  });

  for (const r of data) {
    if (r.metadata && (r.metadata as Record<string, unknown>).opentasks) {
      return r;
    }
  }
  return null;
}

/** Resolve the graph.jsonl path for a resource */
function resolveGraphPath(resource: NonNullable<ReturnType<typeof resourcesDAL.findResourceById>>): string | null {
  const localPath = resource.local_path || resource.git_remote_url;
  if (!localPath || localPath.startsWith('http') || localPath.startsWith('git://') || localPath.startsWith('ssh://')) {
    return null;
  }

  const graphDirect = join(localPath, 'graph.jsonl');
  if (existsSync(graphDirect)) return graphDirect;

  const graphNested = join(localPath, '.opentasks', 'graph.jsonl');
  if (existsSync(graphNested)) return graphNested;

  return null;
}

/** Convert coordination priority string to numeric priority */
function priorityToNumber(priority?: string): number {
  switch (priority) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}
