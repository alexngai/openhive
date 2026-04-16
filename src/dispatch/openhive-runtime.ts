/**
 * OpenHive Agent Runtime — DispatchAgentRuntime adapter
 *
 * Wraps SwarmCraft's ACP stream manager to spawn agents on target swarms.
 * The orchestrator calls spawn() with a prompt; we open an ACP stream,
 * create a session, and send the prompt as the first user message.
 */

import type {
  DispatchAgentRuntime,
  SpawnedAgent,
  AgentStopReason,
  UsageReport,
} from 'swarm-dispatch';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { findAcpAgentInfo } from '../map/connection-registry.js';

type AcpStreamManager = {
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
};

export interface OpenHiveRuntimeDeps {
  getAcpStreamManager: () => AcpStreamManager | undefined;
}

export function createOpenHiveAgentRuntime(
  deps: OpenHiveRuntimeDeps,
): DispatchAgentRuntime {
  const stoppedCallbacks: Array<(agentId: string, reason: AgentStopReason) => void> = [];
  const usageCallbacks: Array<(agentId: string, usage: UsageReport) => void> = [];

  return {
    async spawn(opts): Promise<SpawnedAgent> {
      const acpStreamManager = deps.getAcpStreamManager();
      if (!acpStreamManager) {
        throw new Error('ACP stream manager not available');
      }

      const dispatchId = opts.taskId;
      const dispatch = dispatchesDAL.findDispatchById(dispatchId);
      if (!dispatch) {
        throw new Error(`Dispatch ${dispatchId} not found`);
      }

      const swarmId = dispatch.target_swarm_id;
      const agentInfo = findAcpAgentInfo(swarmId);
      if (!agentInfo) {
        throw new Error(`No ACP-capable agent on swarm ${swarmId}`);
      }

      const { streamId } = await acpStreamManager.createStream(
        swarmId,
        agentInfo.targetId,
      );

      await acpStreamManager.initialize(streamId);

      const swarmMeta = {} as Record<string, unknown>;
      const cwd = (typeof swarmMeta.projectPath === 'string' ? swarmMeta.projectPath : undefined) ?? '.';

      const { sessionId } = await acpStreamManager.newSession(streamId, {
        cwd,
        mcpServers: [],
      });

      await acpStreamManager.prompt(streamId, {
        sessionId,
        prompt: [{ type: 'text', text: opts.prompt }],
      });

      dispatchesDAL.setDispatchSessionIds(dispatchId, [
        ...dispatch.session_ids,
        sessionId,
      ]);

      return { id: streamId };
    },

    async terminate(agentId: string, _reason: AgentStopReason): Promise<void> {
      const acpStreamManager = deps.getAcpStreamManager();
      if (acpStreamManager) {
        try {
          await acpStreamManager.closeStream(agentId);
        } catch {
          // Stream already closed
        }
      }
    },

    onStopped(callback: (agentId: string, reason: AgentStopReason) => void): () => void {
      stoppedCallbacks.push(callback);
      return () => {
        const idx = stoppedCallbacks.indexOf(callback);
        if (idx >= 0) stoppedCallbacks.splice(idx, 1);
      };
    },

    onUsage(callback: (agentId: string, usage: UsageReport) => void): () => void {
      usageCallbacks.push(callback);
      return () => {
        const idx = usageCallbacks.indexOf(callback);
        if (idx >= 0) usageCallbacks.splice(idx, 1);
      };
    },
  };
}

