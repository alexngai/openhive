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
import { updateSwarm, findNodeBySwarmAndAgentId } from '../db/dal/map.js';
import { mapHubEvents } from './service.js';
import { fetchTranscriptFromSwarm } from './trajectory-content.js';
import { isSessionStorageInitialized, getSessionStorage } from '../sessions/storage/index.js';

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

  createTrajectoryCheckpoint({
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

  // ── Enrich swarm record with project context ────────────────────────
  const meta = checkpoint.metadata as Record<string, unknown> | undefined;
  const project = meta?.project as string | undefined;
  const projectPath = meta?.projectPath as string | undefined;
  const gitRemoteUrl = meta?.gitRemoteUrl as string | undefined;
  const gitCommitHash = meta?.gitCommitHash as string | undefined;
  if (project && swarmId) {
    try {
      const branch = checkpoint.branch as string | undefined;
      const template = meta?.template as string | undefined;
      const swarmName = branch ? `${project} (${branch})` : project;
      updateSwarm(swarmId, {
        name: swarmName,
        metadata: { project, branch, template, projectPath, gitRemoteUrl, gitCommitHash, type: (checkpoint.agent as string) || 'sidecar' },
      });
    } catch { /* non-critical */ }
  }

  // Emit for SwarmCraft bridge (after enrichment so projectPath is available)
  mapHubEvents.emit('trajectory_checkpoint', {
    session_resource_id: resourceId,
    checkpoint_id: checkpointId,
    agent: (checkpoint.agent as string) || 'unknown',
    branch: checkpoint.branch as string | undefined,
    files_touched: checkpoint.files_touched as string[] | undefined,
    token_usage: checkpoint.token_usage as Record<string, unknown> | undefined,
    source_swarm_id: swarmId,
    source_agent_id: agentId,
    projectPath,
    gitRemoteUrl,
    gitCommitHash,
    created,
  });

  // ── Proactively cache transcript content ─────────────────────────────
  //    Fetch the transcript from the (still-connected) swarm and cache it
  //    so the UI can load it even after the swarm disconnects.
  //    Fire-and-forget: runs in the background, doesn't block the response.
  if (isSessionStorageInitialized()) {
    void (async () => {
      try {
        const transcript = await fetchTranscriptFromSwarm(resourceId);
        if (!transcript) return;

        const storage = getSessionStorage();
        await storage.store(
          { sessionId: resourceId, agentId },
          [{ path: 'session.jsonl', content: transcript }],
        );
        updateResource(resourceId, {
          metadata: {
            ...((findResourceById(resourceId)?.metadata as Record<string, unknown>) || {}),
            format: { id: 'claude_jsonl_v1' },
            storage: { backend: 'local', cachedAt: new Date().toISOString() },
            trajectory: { source: 'swarm' },
          },
        });
      } catch {
        // Non-critical — cache miss just means on-demand fetch at view time
      }
    })();
  }

  // ── Broadcast to WebSocket channels for UI ───────────────────────────
  try {
    // Two signals for attention detection:
    // 1. MAP node state (updated by agent.state_changed eventBus handler)
    const agentNode = findNodeBySwarmAndAgentId(swarmId, agentId);
    const agentState = agentNode?.state || null;
    // 2. Sessionlog phase from checkpoint metadata (idle = turn complete)
    const checkpointPhase = (meta?.phase as string) || null;

    const syncData = {
      resource_id: resourceId,
      resource_type: 'session',
      commit_hash: commitHash,
      agent_id: agentId,
      source_swarm_id: swarmId,
      agent_state: agentState,
      checkpoint_phase: checkpointPhase,
    };
    broadcastToChannel(`resource:session:${resourceId}`, {
      type: 'trajectory:sync' as const,
      data: syncData,
    });
    broadcastToChannel('global', {
      type: 'trajectory:sync' as const,
      data: syncData,
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

  // 1. Explicit resource_id — but verify session_id matches if provided.
  //    The sidecar caches resource_id, but the sessionlog may switch to a
  //    different session between checkpoints. If session_id doesn't match,
  //    fall through to resolution.
  if (params.resource_id) {
    const existing = findResourceById(params.resource_id);
    if (existing && existing.resource_type === 'session') {
      const sessionId = checkpoint.session_id as string | undefined;
      const existingSessionId = (existing.metadata as Record<string, unknown>)?.sessionId as string | undefined;
      if (!sessionId || !existingSessionId || sessionId === existingSessionId) {
        return { resourceId: params.resource_id, created: false };
      }
      // session_id mismatch — fall through to resolve the correct resource
    }
  }

  // Extract context from checkpoint metadata for display
  const meta = checkpoint.metadata as Record<string, unknown> | undefined;
  const project = meta?.project as string | undefined;
  const branch = checkpoint.branch as string | undefined;
  const firstPrompt = meta?.firstPrompt as string | undefined;
  const template = meta?.template as string | undefined;
  const projectPath = meta?.projectPath as string | undefined;
  const sessionId = checkpoint.session_id as string | undefined;

  // Build a human-readable session name and description.
  // Include a short session/swarm suffix to avoid UNIQUE constraint collisions
  // when multiple sessions exist for the same project/branch.
  const shortId = (sessionId ?? swarmId).slice(-8);
  const sessionName = `session:${swarmId}`;
  const displayName = project
    ? (branch ? `${project} (${branch}) [${shortId}]` : `${project} [${shortId}]`)
    : sessionName;
  const description = firstPrompt
    ? firstPrompt.slice(0, 200)
    : `Trajectory session for ${(checkpoint.agent as string) || swarmId}`;

  // 2. Look up by swarm + session_id (via git_remote_url pattern)
  const existing = findSessionResourceBySwarm(agentId, swarmId, sessionId);
  if (existing) {
    // Update name/description with latest context (first prompt, branch may arrive after creation)
    const existingMeta = (existing.metadata as Record<string, unknown>) || {};
    const needsUpdate = existing.name === sessionName
      || !existingMeta.project
      || (firstPrompt && !existingMeta.firstPrompt)
      || (projectPath && !existingMeta.projectPath);
    if (needsUpdate) {
      try {
        updateResource(existing.id, {
          name: displayName,
          description,
          metadata: {
            ...existingMeta,
            project,
            branch,
            template,
            projectPath,
            firstPrompt: firstPrompt?.slice(0, 200),
            source_swarm_id: swarmId,
          },
        });
      } catch { /* non-critical */ }
    }
    return { resourceId: existing.id, created: false };
  }

  // 3. Auto-create with enriched context
  //    Use session_id as the canonical key — the same session may be reported by
  //    different swarms (sessionlog sync picks up the most recently active session
  //    on the machine, regardless of which sidecar is reporting).
  const remoteUrl = sessionId
    ? `map://session/${sessionId}`
    : `map://trajectory/${swarmId}`;
  const { resource, created } = upsertDiscoveredResource({
    resource_type: 'session',
    name: displayName,
    description,
    git_remote_url: remoteUrl,
    owner_agent_id: agentId,
    scope: 'manual',
    metadata: { project, branch, template, projectPath, sessionId, firstPrompt: firstPrompt?.slice(0, 200), source_swarm_id: swarmId },
  });

  return { resourceId: resource.id, created };
}
