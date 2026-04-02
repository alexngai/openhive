/**
 * Session Bridge
 *
 * Projects OpenHive session resources and their trajectory checkpoints
 * into SwarmCraft agents with trajectory turns and file-based positioning.
 */

import path from 'node:path';
import { mapHubEvents } from '../map/service.js';
import { listAllSessions, listCheckpointsForSession, getSessionStats } from '../db/dal/trajectory-checkpoints.js';
import { findResourceById } from '../db/dal/syncable-resources.js';
import { findSwarmById } from '../db/dal/map.js';
import {
  OPENHIVE_SESSION_SERVER_ID,
  agentIdFromSession,
} from './constants.js';
import type { BridgeContext } from './types.js';

interface SessionBridgeHandle {
  teardown(): void;
}

/**
 * Normalize a file path to be relative to the project root.
 * Trajectory data from Claude Code uses absolute paths (e.g., /Users/.../src/file.ts).
 * The code graph uses relative paths (e.g., src/file.ts).
 * This strips the project root prefix to align them.
 */
function normalizeFilePath(filePath: string, projectPath?: string): string {
  if (!filePath) return filePath;

  // If we have a project path, strip it to get a relative path
  if (projectPath) {
    const root = projectPath.endsWith('/') ? projectPath : projectPath + '/';
    if (filePath.startsWith(root)) {
      return filePath.slice(root.length);
    }
  }

  // Heuristic: if it looks absolute, try to extract the relative portion
  // by finding common project markers (src/, lib/, etc.)
  if (filePath.startsWith('/')) {
    // Try to find a relative portion after common root patterns
    const markers = ['/src/', '/lib/', '/test/', '/tests/', '/docs/', '/references/'];
    for (const marker of markers) {
      const idx = filePath.indexOf(marker);
      if (idx !== -1) {
        // Include the marker directory (e.g., "src/file.ts" not "/file.ts")
        return filePath.slice(idx + 1);
      }
    }
    // Last resort: use just the filename
    return path.basename(filePath);
  }

  return filePath;
}

export async function setupSessionBridge(ctx: BridgeContext): Promise<SessionBridgeHandle> {
  const listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  function on(event: string, fn: (...args: unknown[]) => void) {
    mapHubEvents.on(event, fn);
    listeners.push({ event, fn });
  }

  // ── Startup hydration ────────────────────────────────────────────────

  const { data: sessions } = listAllSessions(200);
  for (const session of sessions) {
    await hydrateSession(ctx, session.id, session.name);
  }

  // ── Real-time: trajectory checkpoints ────────────────────────────────

  on('trajectory_checkpoint', async (e: unknown) => {
    const ev = e as {
      session_resource_id: string;
      checkpoint_id: string;
      agent: string;
      branch?: string;
      files_touched?: string[];
      token_usage?: Record<string, unknown>;
      source_swarm_id?: string;
      source_agent_id?: string;
      projectPath?: string;
      created: boolean;
    };
    try {
      const agentId = agentIdFromSession(ev.session_resource_id);
      const existing = await ctx.db.agents.get(agentId);

      // Resolve session name
      let sessionName = ev.agent || 'session';
      const resource = findResourceById(ev.session_resource_id);
      if (resource) {
        sessionName = resource.name || sessionName;
      }

      if (!existing) {
        await ctx.db.agents.create({
          id: agentId,
          name: sessionName,
          type: 'session',
          capabilities: [],
          mapServerId: OPENHIVE_SESSION_SERVER_ID,
          state: 'active',
          stateMetadata: buildSessionMetadata(ev),
        });
        ctx.wsHub.broadcastAgentRegistered({ id: agentId, name: sessionName, type: 'session' });
      } else {
        await ctx.db.agents.update(agentId, {
          state: 'active',
          stateMetadata: buildSessionMetadata(ev),
        });
        const prevState = (existing as { state?: string }).state || 'idle';
        if (prevState !== 'active') {
          ctx.wsHub.broadcastAgentStateChanged(agentId, prevState, 'active');
        }
      }

      // Record trajectory turn and file accesses
      if (ev.files_touched) {
        if (ctx.trajectoryService) {
          await ctx.trajectoryService.startTurn({
            turnId: ev.checkpoint_id,
            agentId,
            sessionId: ev.session_resource_id,
            turnNumber: Date.now(),
            startedAt: Date.now(),
          });
        }

        for (const file of ev.files_touched) {
          const relPath = normalizeFilePath(file, ev.projectPath);
          await ctx.positionService.recordAccess(agentId, relPath, 'write');
          if (ctx.trajectoryService) {
            await ctx.trajectoryService.recordAction({
              agentId,
              tool: 'checkpoint',
              filePath: relPath,
              success: true,
              timestamp: Date.now(),
            });
          }

          // Broadcast per-file event for frontend position calculation
          ctx.wsHub.broadcast({
            type: 'agent.activity',
            payload: { agentId, filePath: relPath, accessType: 'write' },
          }, 'agents');
        }

        if (ctx.trajectoryService) {
          await ctx.trajectoryService.endCurrentTurn(agentId);
        }
      }

      // Broadcast summary activity event
      ctx.wsHub.broadcast({
        type: 'agent.activity',
        payload: {
          agentId,
          checkpoint: ev.checkpoint_id,
          filesTouched: ev.files_touched?.length || 0,
        },
      }, 'agents');
    } catch (err) {
      console.warn(`[swarmcraft-bridge] trajectory_checkpoint handler failed: ${(err as Error).message}`);
    }
  });

  return {
    teardown() {
      for (const { event, fn } of listeners) {
        mapHubEvents.removeListener(event, fn);
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function hydrateSession(
  ctx: BridgeContext,
  sessionResourceId: string,
  sessionName: string,
): Promise<void> {
  try {
    const agentId = agentIdFromSession(sessionResourceId);
    const stats = getSessionStats(sessionResourceId);

    // Upsert: create or update if already exists from a previous run
    const existing = await ctx.db.agents.get(agentId);
    if (existing) {
      await ctx.db.agents.update(agentId, {
        name: sessionName,
        state: 'idle',
        stateMetadata: {
          source: 'openhive-session',
          sessionResourceId,
          totalCheckpoints: stats.total_checkpoints,
          totalInputTokens: stats.total_input_tokens,
          totalOutputTokens: stats.total_output_tokens,
          totalFilesTouched: stats.total_files_touched,
          latestAgent: stats.latest_agent,
          lastSyncedAt: stats.last_synced_at,
        },
      });
    } else {
      await ctx.db.agents.create({
        id: agentId,
        name: sessionName,
        type: 'session',
        capabilities: [],
        mapServerId: OPENHIVE_SESSION_SERVER_ID,
        state: 'idle',
        stateMetadata: {
          source: 'openhive-session',
          sessionResourceId,
          totalCheckpoints: stats.total_checkpoints,
          totalInputTokens: stats.total_input_tokens,
          totalOutputTokens: stats.total_output_tokens,
          totalFilesTouched: stats.total_files_touched,
          latestAgent: stats.latest_agent,
          lastSyncedAt: stats.last_synced_at,
        },
      });
    }

    // Hydrate trajectory turns from checkpoints
    if (ctx.trajectoryService) {
      const { data: checkpoints } = listCheckpointsForSession(sessionResourceId, 50);

      // Resolve project path for path normalization
      let projectPath: string | undefined;
      if (checkpoints.length > 0 && checkpoints[0].source_swarm_id) {
        try {
          const swarm = findSwarmById(checkpoints[0].source_swarm_id);
          const meta = swarm?.metadata as Record<string, unknown> | null;
          projectPath = meta?.projectPath as string | undefined;
        } catch { /* best effort */ }
      }

      for (let i = 0; i < checkpoints.length; i++) {
        const cp = checkpoints[i];
        await ctx.trajectoryService.startTurn({
          turnId: cp.checkpoint_id,
          agentId,
          sessionId: sessionResourceId,
          turnNumber: i + 1,
          startedAt: new Date(cp.synced_at).getTime(),
        });

        for (const file of cp.files_touched) {
          const relPath = normalizeFilePath(file, projectPath);
          await ctx.positionService.recordAccess(agentId, relPath, 'write');
          await ctx.trajectoryService.recordAction({
            agentId,
            tool: 'checkpoint',
            filePath: relPath,
            success: true,
            timestamp: new Date(cp.synced_at).getTime(),
          });
        }

        await ctx.trajectoryService.endCurrentTurn(agentId);
      }
    }
  } catch (err) {
    console.warn(`[swarmcraft-bridge] hydrateSession ${sessionName} failed: ${(err as Error).message}`);
  }
}

function buildSessionMetadata(ev: {
  session_resource_id: string;
  agent: string;
  branch?: string;
  files_touched?: string[];
  token_usage?: Record<string, unknown>;
  source_swarm_id?: string;
}): Record<string, unknown> {
  return {
    source: 'openhive-session',
    sessionResourceId: ev.session_resource_id,
    agent: ev.agent,
    branch: ev.branch,
    filesTouchedCount: ev.files_touched?.length || 0,
    tokenUsage: ev.token_usage,
    sourceSwarmId: ev.source_swarm_id,
  };
}
