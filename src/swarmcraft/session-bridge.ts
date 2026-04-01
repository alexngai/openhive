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

      // Resolve project name prefix for merged graph alignment
      // In merged graphs, file paths are prefixed: "projectName/src/file.ts"
      // We record both the prefixed and unprefixed path so positioning works
      // whether the graph is single-project or merged
      const projectPrefix = ev.projectPath
        ? path.basename(ev.projectPath) + '/'
        : '';

      // Record trajectory turn
      if (ctx.trajectoryService) {
        await ctx.trajectoryService.startTurn({
          turnId: ev.checkpoint_id,
          agentId,
          sessionId: ev.session_resource_id,
          turnNumber: Date.now(),
          startedAt: Date.now(),
        });

        if (ev.files_touched) {
          for (const file of ev.files_touched) {
            // Record with project prefix (for merged graph positioning)
            if (projectPrefix) {
              await ctx.positionService.recordAccess(agentId, projectPrefix + file, 'write');
            }
            // Also record without prefix (for single-project positioning)
            await ctx.positionService.recordAccess(agentId, file, 'write');
            await ctx.trajectoryService.recordAction({
              agentId,
              tool: 'checkpoint',
              filePath: projectPrefix + file,
              success: true,
              timestamp: Date.now(),
            });
          }
        }

        await ctx.trajectoryService.endCurrentTurn(agentId);
      } else if (ev.files_touched) {
        for (const file of ev.files_touched) {
          if (projectPrefix) {
            await ctx.positionService.recordAccess(agentId, projectPrefix + file, 'write');
          }
          await ctx.positionService.recordAccess(agentId, file, 'write');
        }
      }

      // Broadcast activity
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

      // Resolve project prefix for merged graph alignment
      let projectPrefix = '';
      if (checkpoints.length > 0 && checkpoints[0].source_swarm_id) {
        try {
          const swarm = findSwarmById(checkpoints[0].source_swarm_id);
          const meta = swarm?.metadata as Record<string, unknown> | null;
          const project = meta?.project as string | undefined;
          if (project) projectPrefix = project + '/';
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
          if (projectPrefix) {
            await ctx.positionService.recordAccess(agentId, projectPrefix + file, 'write');
          }
          await ctx.positionService.recordAccess(agentId, file, 'write');
          await ctx.trajectoryService.recordAction({
            agentId,
            tool: 'checkpoint',
            filePath: projectPrefix + file,
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
