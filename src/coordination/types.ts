/**
 * Coordination Types
 *
 * TypeScript interfaces for inter-swarm coordination: task delegation,
 * direct messaging, and ephemeral shared contexts.
 *
 * Wire format types mirror packages/openhive-types/src/map-coordination.ts
 * and will be consolidated once the openhive-types package is republished.
 */

// ============================================================================
// Wire Format Types (JSON-RPC 2.0)
// ============================================================================

/** JSON-RPC 2.0 method names for coordination notifications */
export type MapCoordinationMethod =
  | 'x-openhive/task.assign'
  | 'x-openhive/task.status'
  | 'x-openhive/context.share'
  | 'x-openhive/message.send';

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

export interface TaskStatusParams {
  task_id: string;
  status: 'accepted' | 'in_progress' | 'completed' | 'failed' | 'rejected';
  progress?: number;
  result?: Record<string, unknown>;
  error?: string;
}

export interface ContextShareParams {
  context_id: string;
  source_swarm_id: string;
  target_swarm_ids: string[];
  hive_id: string;
  context_type: string;
  data: Record<string, unknown>;
  ttl_seconds?: number;
}

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

export type MapCoordinationParams =
  | TaskAssignParams
  | TaskStatusParams
  | ContextShareParams
  | MessageSendParams;

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

// ============================================================================
// Domain Models (match DB rows with JSON fields parsed)
// ============================================================================

export interface CoordinationTask {
  id: string;
  hive_id: string;
  title: string;
  description: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'failed' | 'rejected';
  assigned_by_agent_id: string;
  assigned_by_swarm_id: string | null;
  assigned_to_swarm_id: string | null;
  context: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  progress: number;
  deadline: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SwarmMessage {
  id: string;
  hive_id: string | null;
  from_swarm_id: string;
  to_swarm_id: string | null;
  content_type: 'text' | 'json' | 'binary_ref';
  content: string;
  reply_to: string | null;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

export interface SharedContext {
  id: string;
  hive_id: string;
  source_swarm_id: string;
  context_type: string;
  data: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
}

// ============================================================================
// Input Types (for create/update operations)
// ============================================================================

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assigned_by_agent_id: string;
  assigned_by_swarm_id?: string;
  assigned_to_swarm_id: string;
  context?: Record<string, unknown>;
  deadline?: string;
  /** Cross-instance origin tracking (set by materializer) */
  origin_instance_id?: string;
  origin_task_id?: string;
}

export interface UpdateTaskInput {
  status?: 'accepted' | 'in_progress' | 'completed' | 'failed' | 'rejected';
  progress?: number;
  result?: Record<string, unknown>;
  error?: string;
}

export interface CreateMessageInput {
  hive_id?: string;
  from_swarm_id: string;
  to_swarm_id: string;
  content_type?: 'text' | 'json' | 'binary_ref';
  content: string;
  reply_to?: string;
  metadata?: Record<string, unknown>;
  /** Cross-instance origin tracking (set by materializer) */
  origin_instance_id?: string;
  origin_message_id?: string;
}

export interface CreateContextInput {
  source_swarm_id: string;
  context_type: string;
  data: Record<string, unknown>;
  target_swarm_ids?: string[];
  ttl_seconds?: number;
}
