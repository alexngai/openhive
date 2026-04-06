/**
 * Coordination Types
 *
 * TypeScript interfaces for inter-swarm coordination.
 *
 * Task events use generic MAP scope messages (task.created, task.assigned,
 * task.status). Context sharing and messaging use agent-inbox.
 *
 * The TaskAssignParams and TaskStatusParams types are kept for the OpenTasks
 * compat shim (coordination/compat.ts).
 */

// ============================================================================
// Task Parameter Types (used by compat shim → OpenTasks)
// ============================================================================

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

// ============================================================================
// Domain Models (match DB rows with JSON fields parsed)
// ============================================================================

// CoordinationTask removed — tasks now route through OpenTasks graphs.
// The coordination_tasks table has been dropped (migration V28).

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

// CreateTaskInput and UpdateTaskInput removed — use OpenTasks mutations instead.

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
