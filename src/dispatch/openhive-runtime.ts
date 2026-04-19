/**
 * OpenHive Agent Runtime — DispatchAgentRuntime adapter
 *
 * Composes swarm-dispatch's generic createStreamRuntime with OpenHive-specific
 * ACP stream manager and dispatch target resolution.
 */

import { createStreamRuntime } from 'swarm-dispatch/client';
import type { DispatchAgentRuntime } from 'swarm-dispatch';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { findAcpAgentInfo } from '../map/connection-registry.js';

export interface AcpStreamManager {
  createStream: (serverId: string, agentId: string) => Promise<{ streamId: string }>;
  closeStream: (id: string) => Promise<void>;
  initialize: (streamId: string) => Promise<unknown>;
  newSession: (
    streamId: string,
    input: { cwd: string; mcpServers: unknown[] },
  ) => Promise<{ sessionId: string }>;
  prompt: (
    streamId: string,
    input: { sessionId: string; prompt: Array<{ type: string; text?: string }> },
  ) => Promise<unknown>;
}

export interface OpenHiveRuntimeDeps {
  getAcpStreamManager: () => AcpStreamManager | undefined;
}

export function createOpenHiveAgentRuntime(
  deps: OpenHiveRuntimeDeps,
): DispatchAgentRuntime {
  return createStreamRuntime({
    async resolveTarget(taskId) {
      const acpStreamManager = deps.getAcpStreamManager();
      if (!acpStreamManager) throw new Error('ACP stream manager not available');

      const dispatch = dispatchesDAL.findDispatchById(taskId);
      if (!dispatch) throw new Error(`Dispatch ${taskId} not found`);

      const agentInfo = findAcpAgentInfo(dispatch.target_swarm_id);
      if (!agentInfo) {
        throw new Error(`No ACP-capable agent on swarm ${dispatch.target_swarm_id}`);
      }

      return {
        serverId: dispatch.target_swarm_id,
        agentId: agentInfo.targetId,
      };
    },

    createStream: (serverId, agentId) => {
      const mgr = deps.getAcpStreamManager()!;
      return mgr.createStream(serverId, agentId);
    },

    initializeStream: async (streamId) => {
      await deps.getAcpStreamManager()!.initialize(streamId);
    },

    createSession: async (streamId, cwd) => {
      return deps.getAcpStreamManager()!.newSession(streamId, { cwd, mcpServers: [] });
    },

    sendPrompt: async (streamId, sessionId, prompt) => {
      await deps.getAcpStreamManager()!.prompt(streamId, {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
    },

    closeStream: async (streamId) => {
      await deps.getAcpStreamManager()?.closeStream(streamId);
    },

    onSessionCreated: (taskId, sessionId) => {
      const dispatch = dispatchesDAL.findDispatchById(taskId);
      if (dispatch) {
        dispatchesDAL.setDispatchSessionIds(taskId, [
          ...dispatch.session_ids,
          sessionId,
        ]);
      }
    },
  });
}
