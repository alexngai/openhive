/**
 * MAP Trajectory Request Handler
 *
 * Handles trajectory/checkpoint JSON-RPC 2.0 requests from agents.
 * Auto-creates session resources when needed — agents don't need to
 * pre-register resources before sending checkpoints.
 *
 * Flow:
 *   1. Agent calls callExtension("trajectory/checkpoint", { checkpoint })
 *   2. MAPServer routes to this handler (registered as additionalHandler)
 *   3. Handler resolves or creates the session resource
 *   4. Stores the checkpoint via trajectory DAL
 *   5. Broadcasts trajectory:sync to WebSocket channels
 *   6. Returns { ok, resource_id, created, checkpoint_id } to the agent
 */

import { nanoid } from 'nanoid';
import { TRAJECTORY_METHODS } from './trajectory-types.js';
import type { TrajectoryCheckpointParams, TrajectoryCheckpointResult } from './trajectory-types.js';
import { findResourceById, findSessionResourceBySwarm, upsertDiscoveredResource, updateResource } from '../db/dal/syncable-resources.js';
import { createTrajectoryCheckpoint } from '../db/dal/trajectory-checkpoints.js';
import { broadcastToChannel } from '../realtime/index.js';

// ============================================================================
// Types
// ============================================================================

export interface TrajectoryRequestContext {
  swarmId: string;
  agentId: string;
}

export class TrajectoryRequestError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'TrajectoryRequestError';
  }
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle a trajectory/* JSON-RPC request.
 */
export function handleTrajectoryRequest(
  method: string,
  params: unknown,
  context: TrajectoryRequestContext,
): TrajectoryCheckpointResult {
  switch (method) {
    case TRAJECTORY_METHODS.CHECKPOINT:
      return handleCheckpoint(params as TrajectoryCheckpointParams, context);
    default:
      throw new TrajectoryRequestError(-32601, `Unknown trajectory method: ${method}`);
  }
}

// ============================================================================
// Checkpoint Handler
// ============================================================================

function handleCheckpoint(
  params: TrajectoryCheckpointParams,
  context: TrajectoryRequestContext,
): TrajectoryCheckpointResult {
  if (!params?.checkpoint || typeof params.checkpoint !== 'object') {
    throw new TrajectoryRequestError(-32602, 'Invalid params: missing checkpoint object');
  }

  const checkpoint = params.checkpoint;
  const { swarmId, agentId } = context;

  // ── Resolve session resource ─────────────────────────────────────────
  const { resourceId, created } = resolveSessionResource(params, context, checkpoint);

  // ── Generate commit hash (trajectory checkpoints aren't git-based) ───
  const commitHash = checkpoint.id
    ? `trajectory:${checkpoint.id}`
    : `trajectory:${nanoid(12)}`;

  // ── Store the checkpoint ─────────────────────────────────────────────
  const checkpointId = (checkpoint.id as string) || commitHash;

  const stored = createTrajectoryCheckpoint({
    session_resource_id: resourceId,
    checkpoint_id: checkpointId,
    commit_hash: commitHash,
    agent: (checkpoint.agent as string) || 'unknown',
    branch: checkpoint.branch as string | undefined,
    files_touched: checkpoint.files_touched as string[] | undefined,
    checkpoints_count: checkpoint.checkpoints_count as number | undefined,
    token_usage: checkpoint.token_usage as Record<string, unknown> | undefined,
    summary: checkpoint.summary as Record<string, unknown> | undefined,
    attribution: checkpoint.attribution as Record<string, unknown> | undefined,
    source_swarm_id: swarmId,
    source_agent_id: agentId,
  });

  // ── Invalidate cached trajectory content ────────────────────────────
  //    New checkpoint means the session has progressed. Clear the storage
  //    flag so the next /events request re-fetches from the swarm.
  try {
    const resource = findResourceById(resourceId);
    if (resource) {
      const existingMeta = (resource.metadata as Record<string, unknown>) || {};
      if (existingMeta.storage && (existingMeta.storage as Record<string, unknown>).backend === 'local') {
        updateResource(resourceId, {
          metadata: {
            ...existingMeta,
            storage: undefined, // clear storage flag → next request re-fetches
          },
        });
      }
    }
  } catch {
    // Non-critical
  }

  // ── Broadcast to WebSocket channels for UI ───────────────────────────
  try {
    broadcastToChannel(`resource:session:${resourceId}`, {
      type: 'trajectory:sync' as const,
      data: {
        resource_id: resourceId,
        resource_type: 'session',
        commit_hash: commitHash,
        agent_id: agentId,
        source_swarm_id: swarmId,
      },
    });
    // Also broadcast to global channel for session list invalidation
    broadcastToChannel('global', {
      type: 'trajectory:sync' as const,
      data: {
        resource_id: resourceId,
        resource_type: 'session',
        commit_hash: commitHash,
        agent_id: agentId,
        source_swarm_id: swarmId,
      },
    });
  } catch {
    // Non-critical — UI just won't update in realtime
  }

  return {
    ok: true,
    resource_id: resourceId,
    created,
    checkpoint_id: checkpointId,
  };
}

// ============================================================================
// Session Resource Resolution
// ============================================================================

/**
 * Resolve or create the session resource for a trajectory checkpoint.
 *
 * Strategy:
 * 1. If params.resource_id is provided → use it (explicit)
 * 2. Look up existing session resource by (owner_agent_id, swarm name pattern)
 * 3. Auto-create via upsertDiscoveredResource
 */
function resolveSessionResource(
  params: TrajectoryCheckpointParams,
  context: TrajectoryRequestContext,
  checkpoint: TrajectoryCheckpointParams['checkpoint'],
): { resourceId: string; created: boolean } {
  const { swarmId, agentId } = context;

  // 1. Explicit resource_id
  if (params.resource_id) {
    const existing = findResourceById(params.resource_id);
    if (!existing) {
      throw new TrajectoryRequestError(-32602, `Resource not found: ${params.resource_id}`);
    }
    if (existing.resource_type !== 'session') {
      throw new TrajectoryRequestError(-32602, `Resource ${params.resource_id} is not a session`);
    }
    return { resourceId: params.resource_id, created: false };
  }

  // 2. Look up by swarm pattern
  const sessionName = `session:${swarmId}`;
  const existing = findSessionResourceBySwarm(agentId, sessionName);
  if (existing) {
    return { resourceId: existing.id, created: false };
  }

  // 3. Auto-create
  const agentLabel = (checkpoint.agent as string) || swarmId;
  const { resource, created } = upsertDiscoveredResource({
    resource_type: 'session',
    name: sessionName,
    description: `Trajectory session for ${agentLabel}`,
    git_remote_url: `map://trajectory/${swarmId}`,
    owner_agent_id: agentId,
    scope: 'manual',
  });

  return { resourceId: resource.id, created };
}
