/**
 * OpenHive Agent Runtime — DispatchAgentRuntime adapter
 *
 * Composes swarm-dispatch's generic createStreamRuntime with OpenHive-specific
 * ACP stream manager and dispatch target resolution.
 *
 * Lifecycle branching (see docs/LOADOUTS_DESIGN.md → "Propagation channels"):
 *
 *   - `lifecycle: 'reuse'` (default) — uses an existing ACP-capable agent
 *     on the swarm via `findAcpAgentInfo`. Loadout permissions are
 *     advisory only (the agent's session was created earlier with
 *     whatever rules it had then). Backwards-compatible with the
 *     pre-this-work ACP path.
 *
 *   - `lifecycle: 'fresh'` — calls `dispatch/spawn-agent` over the
 *     notification-pair RPC to spawn a fresh coordinator on the swarm
 *     with the loadout's structured fields applied to its spawn config.
 *     Loadout permissions are enforced at spawn time.
 *
 * Lifecycle precedence (`readDispatchLifecycle`):
 *   1. Side-channel hint sourced from the dispatch row's `acp_lifecycle`
 *      column (V47 schema). Set per-dispatch via REST `acp_lifecycle`.
 *   2. Cluster default from `config.dispatch.acp_lifecycle_default`
 *      (wired via `OpenHiveRuntimeDeps.acpLifecycleDefault`).
 *   3. Hardcoded `'reuse'` fallback.
 */

import { createStreamRuntime } from 'swarm-dispatch/client';
import type { DispatchAgentRuntime } from 'swarm-dispatch';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import type { Dispatch } from '../db/dal/dispatches.js';
import { findAcpAgentInfo } from '../map/connection-registry.js';
import { callViaNotificationPair } from '../map/notification-rpc.js';
import {
  peekHintsForDispatch,
  consumeLoadoutForDispatch,
} from './loadout-side-channel.js';
import { materializedLoadoutToWire } from './wire-loadout.js';
import type { MaterializedLoadout } from '../openteams/types.js';

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
  /**
   * Timeout for the `dispatch/spawn-agent` notification-pair RPC, in
   * milliseconds. Defaults to 30 seconds. Configurable so operators can
   * tune for slow agent spawns or constrained environments.
   */
  spawnAgentTimeoutMs?: number;
  /**
   * Cluster-wide default ACP lifecycle. Used when a dispatch row's
   * `acp_lifecycle` column is null. Defaults to `'reuse'` for backwards
   * compatibility with the pre-this-work ACP behavior. Wired from
   * `config.dispatch.acp_lifecycle_default` at orchestrator setup time.
   */
  acpLifecycleDefault?: 'fresh' | 'reuse';
}

/**
 * Read the per-dispatch ACP lifecycle preference. Precedence:
 *
 *   1. Side-channel hints (sourced from the dispatch row's
 *      `acp_lifecycle` column at enrichment time — set per-dispatch via
 *      the REST request body's `acp_lifecycle` field).
 *   2. `configDefault` — cluster-wide operator default from
 *      `config.dispatch.acp_lifecycle_default`.
 *   3. Hardcoded `'reuse'` — backwards-compatible with the pre-this-work
 *      ACP path (orchestrator routes to an existing ACP-capable agent
 *      via findAcpAgentInfo).
 *
 * Loadout-level lifecycle was explicitly rejected: ACP routing is a
 * transport concern, not a role-bundle authoring concern. Loadouts
 * declare what's IN a role; the dispatch caller decides HOW to talk
 * to the worker.
 */
export function readDispatchLifecycle(
  dispatch: Dispatch,
  loadout: MaterializedLoadout | null,
  hints: { acpLifecycle?: 'fresh' | 'reuse' } | null,
  configDefault?: 'fresh' | 'reuse',
): 'fresh' | 'reuse' {
  void dispatch;
  void loadout;
  if (hints?.acpLifecycle === 'fresh' || hints?.acpLifecycle === 'reuse') {
    return hints.acpLifecycle;
  }
  if (configDefault === 'fresh' || configDefault === 'reuse') {
    return configDefault;
  }
  return 'reuse';
}

/**
 * @deprecated — use `materializedLoadoutToWire` from `./wire-loadout.js`
 * directly. This re-export preserves the old name for the unit tests
 * in `src/__tests__/dispatch/openhive-runtime-lifecycle.test.ts`.
 */
export const toWireLoadout = materializedLoadoutToWire;

export function createOpenHiveAgentRuntime(
  deps: OpenHiveRuntimeDeps,
): DispatchAgentRuntime {
  return createStreamRuntime({
    async resolveTarget(taskId) {
      const acpStreamManager = deps.getAcpStreamManager();
      if (!acpStreamManager) throw new Error('ACP stream manager not available');

      const dispatch = dispatchesDAL.findDispatchById(taskId);
      if (!dispatch) throw new Error(`Dispatch ${taskId} not found`);

      // ACP route consumes the side-channel entry — both the loadout
      // and any hints. The mail port has its own consume on its
      // delivery path; if a dispatch is mail-routed, it never reaches
      // here. If we peeked instead of consumed, ACP-routed dispatches
      // would leak entries (cache holds the MaterializedLoadout for the
      // 5-min TTL even after the dispatch is fully delivered).
      const hints = peekHintsForDispatch(taskId);
      const loadout = consumeLoadoutForDispatch(taskId);
      const lifecycle = readDispatchLifecycle(
        dispatch,
        loadout,
        hints,
        deps.acpLifecycleDefault,
      );

      if (lifecycle === 'fresh') {
        // Notification-pair RPC — AgentConnection doesn't expose
        // setRequestHandler so we simulate request/response over
        // notifications. See src/map/notification-rpc.ts.
        //
        // Default role is 'coordinator' (the only role that registers
        // `protocols: ['acp']` per macro-agent's lifecycle-bridge);
        // cwd defaults to the swarm's process.cwd() via the handler's
        // own fallback to agentManager's defaultCwd.
        const result = await callViaNotificationPair<
          Record<string, unknown>,
          { agentId: string }
        >(
          dispatch.target_swarm_id,
          'dispatch/spawn-agent',
          {
            role: 'coordinator',
            capabilities_required: ['acp'],
            lifecycle: 'fresh',
            ...(loadout ? { loadout: materializedLoadoutToWire(loadout) } : {}),
            fullAutonomous: true,
          },
          { timeoutMs: deps.spawnAgentTimeoutMs ?? 30_000 },
        );
        return {
          serverId: dispatch.target_swarm_id,
          agentId: result.agentId,
        };
      }

      // lifecycle === 'reuse' — use an existing ACP-capable agent.
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
