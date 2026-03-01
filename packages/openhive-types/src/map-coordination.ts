/**
 * MAP Coordination Notifications (JSON-RPC 2.0)
 *
 * Wire format types for OpenHive coordination notifications between swarms.
 * Uses JSON-RPC 2.0 notification semantics with x-openhive/ vendor prefix.
 */

/** JSON-RPC 2.0 method names for coordination notifications */
export type MapCoordinationMethod =
  | 'x-openhive/task.assign'
  | 'x-openhive/task.status'
  | 'x-openhive/context.share'
  | 'x-openhive/message.send';

/** Set of valid coordination method names for fast validation */
export const COORDINATION_METHODS: Set<string> = new Set<string>([
  'x-openhive/task.assign',
  'x-openhive/task.status',
  'x-openhive/context.share',
  'x-openhive/message.send',
]);

/** Parameters for assigning a task to a swarm */
export interface TaskAssignParams {
  task_id: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assigned_by: string;
  assigned_to_swarm: string;
  hive_id: string;
  context?: Record<string, unknown>;
  deadline?: string;
}

/** Parameters for reporting task status updates */
export interface TaskStatusParams {
  task_id: string;
  status: 'accepted' | 'in_progress' | 'completed' | 'failed' | 'rejected';
  progress?: number;
  result?: Record<string, unknown>;
  error?: string;
}

/** Parameters for sharing context between swarms */
export interface ContextShareParams {
  context_id: string;
  source_swarm_id: string;
  target_swarm_ids: string[];
  hive_id: string;
  context_type: string;
  data: Record<string, unknown>;
  ttl_seconds?: number;
}

/** Parameters for sending a direct or broadcast message between swarms */
export interface MessageSendParams {
  message_id: string;
  from_swarm_id: string;
  to_swarm_id: string;
  hive_id?: string;
  content_type: 'text' | 'json' | 'binary_ref';
  content: unknown;
  reply_to?: string;
  metadata?: Record<string, unknown>;
}

/** Union of all coordination parameter types */
export type MapCoordinationParams =
  | TaskAssignParams
  | TaskStatusParams
  | ContextShareParams
  | MessageSendParams;

/**
 * MAP coordination notification emitted by swarms for task delegation,
 * context sharing, and inter-swarm messaging.
 * No `id` field = fire-and-forget notification (JSON-RPC 2.0 semantics).
 */
export interface MapCoordinationMessage {
  jsonrpc: '2.0';
  method: MapCoordinationMethod;
  params: MapCoordinationParams;
}

/** Create a well-formed coordination notification */
export function createCoordinationNotification(
  method: MapCoordinationMethod,
  params: MapCoordinationParams,
): MapCoordinationMessage {
  return { jsonrpc: '2.0', method, params };
}
