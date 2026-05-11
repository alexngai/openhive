/**
 * OpenHive Agent Runtime — DispatchAgentRuntime adapter
 *
 * Implements the swarm-dispatch `DispatchAgentRuntime` interface directly
 * (rather than via `createStreamRuntime`) so we can thread the dispatch id
 * through every step of the spawn pipeline — needed for Layer 3 loadout
 * materialization, which must consult the dispatch row to know which
 * `loadout_bundle_id` to fetch and feed into the ACP session.
 *
 * Pipeline per dispatch:
 *
 *   1. Resolve target swarm + ACP agent from the dispatch row.
 *   2. (Layer 3) materialize the loadout bundle if the row has one — the
 *      result is a list of ACP-shaped MCP servers + a prompt addendum.
 *   3. Open an ACP stream; initialize it.
 *   4. Create a new session with the materialized MCP servers (replaces
 *      the legacy hard-coded `mcpServers: []`).
 *   5. Send the seed prompt, prepended with `promptAddendum` when present.
 *   6. Record session ids on the dispatch row.
 *
 * Backwards compatibility: dispatches without `loadout_bundle_id` skip
 * step 2 and behave exactly like before Layer 3.
 */

import type {
  DispatchAgentRuntime,
  AgentStopReason,
  UsageReport,
} from 'swarm-dispatch';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { findAcpAgentInfo } from '../map/connection-registry.js';
import {
  materializeLoadoutById,
  LoadoutBundleNotFoundError,
} from '../openteams/loadout-materializer.js';
import type { MaterializedLoadout } from '../openteams/loadout-materializer.js';

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
  const stoppedCallbacks: Array<(agentId: string, reason: AgentStopReason) => void> = [];
  const usageCallbacks: Array<(agentId: string, usage: UsageReport) => void> = [];

  return {
    async spawn(opts) {
      const acpStreamManager = deps.getAcpStreamManager();
      if (!acpStreamManager) throw new Error('ACP stream manager not available');

      const dispatch = dispatchesDAL.findDispatchById(opts.taskId);
      if (!dispatch) throw new Error(`Dispatch ${opts.taskId} not found`);

      const agentInfo = findAcpAgentInfo(dispatch.target_swarm_id);
      if (!agentInfo) {
        throw new Error(`No ACP-capable agent on swarm ${dispatch.target_swarm_id}`);
      }

      // Layer 3 — materialize the loadout if the dispatch pins one. Missing
      // bundles are non-fatal: log and proceed without the binding so the
      // dispatch can still run with the legacy (spec-only) shape.
      let loadout: MaterializedLoadout | null = null;
      if (dispatch.loadout_bundle_id) {
        try {
          loadout = await materializeLoadoutById(dispatch.loadout_bundle_id);
          if (loadout.unresolvedRefs.length > 0) {
            console.warn(
              `[dispatch] loadout ${dispatch.loadout_bundle_id} has ${loadout.unresolvedRefs.length} unresolved MCP ref(s); skipping: ${loadout.unresolvedRefs.join(', ')}`,
            );
          }
        } catch (err) {
          if (err instanceof LoadoutBundleNotFoundError) {
            console.warn(
              `[dispatch] ${opts.taskId}: loadout bundle ${dispatch.loadout_bundle_id} not in store; dispatching without loadout`,
            );
          } else {
            console.warn(
              `[dispatch] ${opts.taskId}: failed to materialize loadout: ${(err as Error).message}`,
            );
          }
        }
      }

      const { streamId } = await acpStreamManager.createStream(
        dispatch.target_swarm_id,
        agentInfo.targetId,
      );
      await acpStreamManager.initialize(streamId);

      const { sessionId } = await acpStreamManager.newSession(streamId, {
        cwd: '.',
        // Forward the materialized MCP server list verbatim. Empty array
        // when no loadout is bound — same shape the runtime used pre-L3.
        mcpServers: loadout?.mcpServers ?? [],
      });

      // Prepend the loadout's prompt addendum (if any) ahead of the seed
      // prompt so the agent's first turn carries both the role-level
      // direction and the spec content. Separated by a blank line per
      // openteams's concatenation convention.
      const promptText = loadout?.promptAddendum
        ? `${loadout.promptAddendum}\n\n${opts.prompt}`
        : opts.prompt;
      await acpStreamManager.prompt(streamId, {
        sessionId,
        prompt: [{ type: 'text', text: promptText }],
      });

      // Persist the session id on the dispatch row so the API can surface it.
      const current = dispatchesDAL.findDispatchById(opts.taskId);
      if (current) {
        dispatchesDAL.setDispatchSessionIds(opts.taskId, [
          ...current.session_ids,
          sessionId,
        ]);
      }

      return { id: streamId, host: dispatch.target_swarm_id };
    },

    async terminate(agentId, _reason) {
      try {
        await deps.getAcpStreamManager()?.closeStream(agentId);
      } catch {
        // Stream already closed.
      }
    },

    onStopped(callback) {
      stoppedCallbacks.push(callback);
      return () => {
        const idx = stoppedCallbacks.indexOf(callback);
        if (idx >= 0) stoppedCallbacks.splice(idx, 1);
      };
    },

    onUsage(callback) {
      usageCallbacks.push(callback);
      return () => {
        const idx = usageCallbacks.indexOf(callback);
        if (idx >= 0) usageCallbacks.splice(idx, 1);
      };
    },
  };
}
