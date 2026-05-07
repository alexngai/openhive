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
import { resolveLocalPath } from '../api/routes/_resource-helpers.js';
import { daemonAppendTaskFiles, resolveDaemonSocket } from './task-daemon-client.js';
import { createTrajectoryCheckpoint } from '../db/dal/trajectory-checkpoints.js';
import { broadcastToChannel } from '../realtime/index.js';
import { updateSwarm, findNodeBySwarmAndAgentId, ensureNodeWithId } from '../db/dal/map.js';
import * as repos from '../db/dal/repos.js';
import * as workspaces from '../db/dal/workspaces.js';
import { getDatabase } from '../db/index.js';
import { broadcastWorkspaceLifecycleEvent } from '../realtime/workspace-events.js';
import { getAggregateCapabilities } from './connection-registry.js';
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

  // ── Repo bootstrap (capability-gated) ────────────────────────────────
  // Capability-gated lazy upsert: agents that declared workspace.declare
  // but never explicitly called RepoClient.declare still appear in the
  // repo list once they start sending checkpoints. See
  // `agent-workspace/docs/design/agent-integration.md` "Trajectory-
  // bootstrap interaction" — and the Build-Order step 5 in
  // CLAUDE.md "Repos and Workspaces".
  // Fire-and-forget: never blocks checkpoint persistence.
  if (gitRemoteUrl && projectPath) {
    try {
      const bootstrap = bootstrapRepoFromCheckpoint({
        swarmId,
        agentId,
        gitRemoteUrl,
        projectPath,
        branch: checkpoint.branch as string | undefined,
        gitCommitHash,
        agentName: (checkpoint.agent as string | undefined) ?? undefined,
      });
      // Slice 8 prerequisite: stamp `metadata.repo_id` on the session
      // resource so future "show all sessions for this repo" queries are
      // a one-line FK lookup. Idempotent — overwrites with the same value
      // on every checkpoint. Skipped if bootstrap was capability-gated
      // off or the swarm row is missing.
      if (bootstrap) {
        // Stamp metadata.repo_id on the session resource (slice 8 prereq).
        try {
          const sessionMeta = (findResourceById(resourceId)?.metadata as Record<string, unknown>) || {};
          if (sessionMeta.repo_id !== bootstrap.repoId) {
            updateResource(resourceId, {
              metadata: { ...sessionMeta, repo_id: bootstrap.repoId },
            });
          }
        } catch { /* non-critical — repo_id linkage is advisory */ }

        // Path A — when the same checkpoint also carries `task_ref`, stamp
        // metadata.repo_id on that task resource too. Idempotent: skipped
        // if the task already has the same repo_id, and silently no-ops if
        // the task resource doesn't exist or isn't a task.
        const taskRef = meta?.task_ref as { resource_id?: string; node_id?: string } | undefined;
        if (taskRef?.resource_id) {
          try {
            const taskResource = findResourceById(taskRef.resource_id);
            if (taskResource && taskResource.resource_type === 'task') {
              const taskMeta = (taskResource.metadata as Record<string, unknown>) || {};
              if (taskMeta.repo_id !== bootstrap.repoId) {
                updateResource(taskRef.resource_id, {
                  metadata: { ...taskMeta, repo_id: bootstrap.repoId },
                });
              }
            }
          } catch { /* non-critical — repo_id linkage is advisory */ }
        }
      }
    } catch { /* non-critical — checkpoint succeeds regardless */ }
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

  // ── Enrich task graph with files_touched (Phase 3 files contract) ────
  //
  // Contract: an agent that knows the task it's working on can include
  //   checkpoint.metadata.task_ref = { resource_id, node_id }
  // in its trajectory checkpoint. When that + files_touched are present,
  // the hub merges those paths into task.metadata.files (deduped). This
  // unblocks the swarmcraft task overlay's centroid positioning for tasks
  // that originate from active coding sessions. Fire-and-forget.
  try {
    const touched = (checkpoint.files_touched as string[] | undefined) ?? [];
    const taskRef = meta?.task_ref as { resource_id?: string; node_id?: string } | undefined;
    if (touched.length > 0 && taskRef?.resource_id && taskRef.node_id) {
      void enrichTaskFiles(taskRef.resource_id, taskRef.node_id, touched);
    }
  } catch { /* non-critical */ }

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
// Repo Bootstrap (capability-gated)
// ============================================================================

interface BootstrapInput {
  swarmId: string;
  agentId: string;
  gitRemoteUrl: string;
  projectPath: string;
  branch?: string;
  gitCommitHash?: string;
  /** Agent self-reported name from the checkpoint, surfaced into the
   *  shim-inserted `map_nodes` row so UI panels don't render "Unknown". */
  agentName?: string;
}

/**
 * Lazily upsert a repo + workspace binding from a trajectory checkpoint.
 *
 * Gated on `workspace.declare.enabled === true` in the connection's
 * aggregated capabilities. Idempotent at every step: repeat checkpoints
 * for the same (agent, repo, projectPath) just refresh branch/HEAD on
 * the existing binding rather than creating duplicates.
 *
 * Owner-agent resolution mirrors `OpenHiveRepoHandler`: `map_swarms.
 * owner_agent_id` is the source of truth for repo ownership; the
 * connection's agentId can't own an `agents`-table-backed resource.
 */
function bootstrapRepoFromCheckpoint(input: BootstrapInput): { repoId: string } | null {
  const { swarmId, agentId, gitRemoteUrl, projectPath, branch, gitCommitHash, agentName } = input;

  // Capability check — aggregate across all registered agents on the swarm.
  const caps = getAggregateCapabilities(swarmId) ?? {};
  const ws = caps.workspace as { declare?: { enabled?: boolean } } | undefined;
  if (ws?.declare?.enabled !== true) return null;

  // Resolve repo owner from the swarm record (same pattern as workspace-handler).
  const db = getDatabase();
  const ownerRow = db.prepare(
    'SELECT owner_agent_id FROM map_swarms WHERE id = ?',
  ).get(swarmId) as { owner_agent_id: string } | undefined;
  if (!ownerRow) return null; // swarm not in DB — nothing to attribute the repo to

  // Upsert the repo. `trajectory_inferred` origin distinguishes from agents
  // that explicitly call declare; future paths can prefer explicit declares.
  const repo = repos.upsertRepoFromRemoteUrl(gitRemoteUrl, {
    origin: 'trajectory_inferred',
    visibility: 'hub_local',
    owner_agent_id: ownerRow.owner_agent_id,
  });

  // Workspace FK requires a map_nodes row keyed on agentId. Forward the
  // checkpoint's agent name so UI agent panels don't render "Unknown" for
  // shim-inserted rows.
  ensureNodeWithId({
    id: agentId,
    swarm_id: swarmId,
    map_agent_id: agentId,
    ...(agentName !== undefined && { name: agentName }),
  });

  // Upsert the per-agent binding. Branch + HEAD refresh on subsequent
  // checkpoints for the same (agent, repo, path) triple.
  const binding = workspaces.upsertWorkspace({
    repo_id: repo.id,
    agent_id: agentId,
    swarm_id: swarmId,
    local_path: projectPath,
    visibility: 'hub_local',
    ...(branch !== undefined && { current_branch: branch }),
    ...(gitCommitHash !== undefined && { head_sha: gitCommitHash }),
  });

  broadcastWorkspaceLifecycleEvent(repo.id, {
    type: 'workspace_added',
    data: { workspace: binding },
  });

  return { repoId: repo.id };
}

// ============================================================================
// Task File Enrichment
// ============================================================================

/**
 * Per-key serialization primitive. Returns a function that chains its input
 * onto the existing promise for `key` — operations with the same key run
 * sequentially; different keys run in parallel. Entries are garbage-collected
 * from `chains` once their tail settles.
 *
 * Exported for testing.
 */
export function createPerKeyMutex(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // on prev reject, still run fn (advisory)
    chains.set(key, next);
    // Cleanup must not produce an "unhandled rejection" when `next` rejects,
    // so swallow the settled value inside the bookkeeping chain. Callers
    // still see the original `next` and can `.catch()` or `await` it.
    next.catch(() => {}).finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
    return next;
  };
}

/**
 * Per-task mutex for the append pipeline. Bursts of checkpoints for the
 * same (resource_id, node_id) serialize here so read-modify-write operations
 * can't race. Different tasks remain parallel.
 */
const runSerialized = createPerKeyMutex();

/**
 * Append files_touched to a task's metadata.files. Resolves the OpenTasks
 * resource on disk, connects to the local daemon, and merges via the
 * daemonAppendTaskFiles helper. Silent on error — enrichment is advisory.
 *
 * Serialized per (resource_id, node_id) so bursts of checkpoints for the
 * same task can't race each other.
 *
 * Exported for testing; not part of the public trajectory-handler API.
 */
export function enrichTaskFiles(
  resourceId: string,
  taskNodeId: string,
  files: string[],
): Promise<void> {
  return runSerialized(`${resourceId}::${taskNodeId}`, async () => {
    try {
      const resource = findResourceById(resourceId);
      if (!resource || resource.resource_type !== 'task') return;
      const localPath = resolveLocalPath(resource);
      if (!localPath) return;
      const socketPath = resolveDaemonSocket(localPath);
      await daemonAppendTaskFiles(socketPath, taskNodeId, files, localPath);
    } catch {
      // Non-critical. Enrichment is opportunistic; the task remains valid without it.
    }
  });
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

  // 1. Explicit resource_id — honour it directly.
  //    The sidecar caches resource_id and sends it on subsequent checkpoints.
  //    Trust the agent: if it says "store here", store here.
  if (params.resource_id) {
    const existing = findResourceById(params.resource_id);
    if (!existing || existing.resource_type !== 'session') {
      throw new TrajectoryRequestError(-32602, `Resource not found or not a session: ${params.resource_id}`);
    }
    return { resourceId: params.resource_id, created: false };
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
