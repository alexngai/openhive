/**
 * Contexts Types
 *
 * Domain models and input types for ephemeral shared contexts between swarms.
 * Extracted from src/coordination/types.ts as a standalone module.
 */

export interface SharedContext {
  id: string;
  hive_id: string;
  source_swarm_id: string;
  context_type: string;
  data: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
}

export interface CreateContextInput {
  source_swarm_id: string;
  context_type: string;
  data: Record<string, unknown>;
  target_swarm_ids?: string[];
  ttl_seconds?: number;
}

/** Context share parameters (used internally for DAL persistence) */
export interface ContextShareParams {
  context_id: string;
  source_swarm_id: string;
  target_swarm_ids: string[];
  hive_id: string;
  context_type: string;
  data: Record<string, unknown>;
  ttl_seconds?: number;
}
