/**
 * MAP Trajectory Protocol Types
 *
 * Server-side types for handling trajectory/checkpoint requests from agents.
 * Follows the MAP trajectory extension spec — agents send checkpoint data
 * via callExtension("trajectory/checkpoint"), the server auto-creates
 * session resources and stores checkpoint metadata.
 */

// ============================================================================
// JSON-RPC Method Names
// ============================================================================

export const TRAJECTORY_METHODS = {
  CHECKPOINT: 'trajectory/checkpoint',
} as const;

export type TrajectoryMethod = (typeof TRAJECTORY_METHODS)[keyof typeof TRAJECTORY_METHODS];

/** Set for fast lookup in handler registration */
export const TRAJECTORY_METHOD_SET = new Set<string>(Object.values(TRAJECTORY_METHODS));

// ============================================================================
// Request Parameter Types
// ============================================================================

/** Parameters for trajectory/checkpoint request */
export interface TrajectoryCheckpointParams {
  /** Checkpoint metadata (conforms to sessionlog SessionSyncCheckpoint wire format) */
  checkpoint: {
    id?: string;
    session_id?: string;
    agent?: string;
    branch?: string;
    files_touched?: string[];
    checkpoints_count?: number;
    token_usage?: Record<string, unknown>;
    summary?: Record<string, unknown>;
    attribution?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  /** Optional explicit resource_id — if provided, skips auto-creation */
  resource_id?: string;
}

// ============================================================================
// Response Types
// ============================================================================

/** Result returned to the client after storing a checkpoint */
export interface TrajectoryCheckpointResult {
  ok: boolean;
  /** The session resource ID (auto-created or existing) */
  resource_id: string;
  /** Whether the session resource was newly created */
  created: boolean;
  /** The stored checkpoint ID */
  checkpoint_id: string;
}
