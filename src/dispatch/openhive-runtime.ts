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
import { callSpawnAgent } from 'swarm-dispatch/client';
import { getOpenHiveNotificationPairRegistry } from '../map/notification-rpc.js';
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

// ─────────────────────────────────────────────────────────────────────
// Permission overlay staging (ACP+reuse path).
//
// Two-phase wiring because the runtime contract splits target resolution
// from stream creation:
//   - resolveTarget gets the loadout (consumed from cache) and the agent
//     id, but no streamId yet.
//   - createStream gets the streamId. Once we have it, we can pair the
//     pending overlay with the stream and send `permissions.set` to the
//     swarm via the x-dispatch notification-pair RPC.
//   - closeStream tears down the stream — clears the overlay first so
//     the long-lived agent isn't left with stale dispatch deny rules.
//
// Stage 1 (resolveTarget → stagePendingOverlay): Map<`${swarmId}::${agentId}`, ...>
// Stage 2 (createStream → activatePendingOverlay): Map<streamId, ...>
//
// Cross-stream collisions are unlikely (one dispatch ↔ one stream ↔ one
// overlay) but handled defensively: a re-stage overwrites the prior
// pending entry on the same (swarmId, agentId) key. Stale pending
// entries that never get activated leak — fine, they're tiny and time-
// bounded by the orchestrator's reconcile cycle.
// ─────────────────────────────────────────────────────────────────────

interface StagedOverlay {
  swarmId: string;
  agentId: string;
  deny: string[];
  allow: string[];
}

interface ActiveOverlay {
  swarmId: string;
  agentId: string;
}

const pendingOverlays = new Map<string, StagedOverlay>();
const activeOverlays = new Map<string, ActiveOverlay>();
const PERMISSIONS_RPC_TIMEOUT_MS = 5_000;

function pendingKey(swarmId: string, agentId: string): string {
  return `${swarmId}::${agentId}`;
}

export function stagePendingOverlay(staged: StagedOverlay): void {
  pendingOverlays.set(pendingKey(staged.swarmId, staged.agentId), staged);
}

export async function activatePendingOverlay(args: {
  swarmId: string;
  agentId: string;
  streamId: string;
}): Promise<void> {
  const key = pendingKey(args.swarmId, args.agentId);
  const staged = pendingOverlays.get(key);
  if (!staged) return; // No pending overlay — nothing to activate.
  pendingOverlays.delete(key);

  // Registry convention: pass the BASE method name; the registry appends
  // `.request` for the outgoing notification and listens for `.response`.
  // Mirrors `callSpawnAgent`'s `SPAWN_AGENT_BASE` shape.
  const { callViaNotificationPair } = await import(
    '../map/notification-rpc.js'
  );
  await callViaNotificationPair<
    { agent_id: string; deny: string[]; allow: string[] },
    { ok: boolean; error?: string }
  >(
    args.swarmId,
    'x-dispatch/permissions.set',
    {
      agent_id: args.agentId,
      deny: staged.deny,
      allow: staged.allow,
    },
    { timeoutMs: PERMISSIONS_RPC_TIMEOUT_MS },
  );
  activeOverlays.set(args.streamId, {
    swarmId: args.swarmId,
    agentId: args.agentId,
  });
}

export async function deactivateOverlay(streamId: string): Promise<void> {
  const active = activeOverlays.get(streamId);
  if (!active) return; // No active overlay for this stream — nothing to clear.
  activeOverlays.delete(streamId);

  const { callViaNotificationPair } = await import(
    '../map/notification-rpc.js'
  );
  await callViaNotificationPair<
    { agent_id: string },
    { ok: boolean; error?: string }
  >(
    active.swarmId,
    'x-dispatch/permissions.clear',
    { agent_id: active.agentId },
    { timeoutMs: PERMISSIONS_RPC_TIMEOUT_MS },
  );
}

/** Test helper — reset all in-memory overlay state. */
export function _resetOverlayStateForTest(): void {
  pendingOverlays.clear();
  activeOverlays.clear();
}

export function createOpenHiveAgentRuntime(
  deps: OpenHiveRuntimeDeps,
): DispatchAgentRuntime {
  // Bridge loadout from `resolveTarget` (knows taskId) through
  // `createStream` (gets streamId) to `createSession` / `sendPrompt`
  // (only see streamId). swarm-dispatch's `createStreamRuntime` calls
  // these sequentially per spawn but doesn't thread context, so we
  // stash here. FIFO queue keyed by `${serverId}:${agentId}` handles
  // concurrent spawns to the same target without collision.
  const pendingByTarget = new Map<string, MaterializedLoadout[]>();
  const loadoutByStream = new Map<string, MaterializedLoadout>();
  const targetKey = (serverId: string, agentId: string) => `${serverId}:${agentId}`;

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

      // Lazy import to avoid binding setup.ts ↔ runtime ↔ mail-port
      // into a cycle.
      const { markDelivery } = await import('./delivery-tracker.js');

      if (lifecycle === 'fresh') {
        // Notification-pair RPC via swarm-dispatch's `callSpawnAgent`.
        // The MAP SDK's AgentConnection doesn't expose
        // setRequestHandler, so the helper sends an
        // `x-dispatch/spawn-agent.request` notification with a
        // correlation_id and awaits the matching `.response`.
        //
        // Library-shape fields (role, capabilities, lifecycle,
        // fullAutonomous) ride at the top level; OpenHive-specific
        // payload (the materialized loadout) goes under
        // `consumer_extensions.openhive` so consumers from other hubs
        // running their own dispatch can co-exist on the same wire.
        //
        // Default role is 'coordinator' (the only role that registers
        // `protocols: ['acp']` per macro-agent's lifecycle-bridge); cwd
        // defaults to the swarm's process.cwd() via the handler's own
        // fallback to agentManager's defaultCwd.
        const result = await callSpawnAgent(
          getOpenHiveNotificationPairRegistry(),
          dispatch.target_swarm_id,
          {
            role: 'coordinator',
            capabilities_required: ['acp'],
            lifecycle: 'fresh',
            fullAutonomous: true,
            ...(loadout
              ? {
                  consumer_extensions: {
                    openhive: { loadout: materializedLoadoutToWire(loadout) },
                  },
                }
              : {}),
          },
          { timeoutMs: deps.spawnAgentTimeoutMs ?? 30_000 },
        );
        markDelivery(taskId, { transport: 'acp', agent_id: result.agentId });
        if (loadout) {
          const key = targetKey(dispatch.target_swarm_id, result.agentId);
          const queue = pendingByTarget.get(key) ?? [];
          queue.push(loadout);
          pendingByTarget.set(key, queue);
        }
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
      markDelivery(taskId, { transport: 'acp', agent_id: agentInfo.targetId });

      // Capture the loadout's permission rules to apply via the swarm-side
      // overlay registry once the ACP stream is created. ACP+reuse uses
      // the existing long-lived agent's session — so loadout permissions
      // can't be wired at session-creation time the way ACP+fresh does.
      // Instead, we send `x-dispatch/permissions.set` over MAP after
      // createStream, and `permissions.clear` before closeStream. The
      // swarm-side prompt iterator (in macro-agent's agent-manager-v2)
      // enforces the overlay against permission_request session updates.
      // See docs/PERMISSION_OVERLAY_ACP_DESIGN.md.
      if (loadout?.permissions?.deny?.length || loadout?.permissions?.allow?.length) {
        stagePendingOverlay({
          swarmId: dispatch.target_swarm_id,
          agentId: agentInfo.targetId,
          deny: loadout.permissions.deny ?? [],
          allow: loadout.permissions.allow ?? [],
        });
      }

      if (loadout) {
        const key = targetKey(dispatch.target_swarm_id, agentInfo.targetId);
        const queue = pendingByTarget.get(key) ?? [];
        queue.push(loadout);
        pendingByTarget.set(key, queue);
      }
      return {
        serverId: dispatch.target_swarm_id,
        agentId: agentInfo.targetId,
      };
    },

    createStream: async (serverId, agentId) => {
      const mgr = deps.getAcpStreamManager()!;
      const result = await mgr.createStream(serverId, agentId);
      // Move the queued loadout (set by resolveTarget) under streamId so
      // createSession + sendPrompt can read it without needing taskId.
      const key = targetKey(serverId, agentId);
      const queue = pendingByTarget.get(key);
      const loadout = queue?.shift();
      if (queue && queue.length === 0) pendingByTarget.delete(key);
      if (loadout) loadoutByStream.set(result.streamId, loadout);
      // After the stream is wired, push any staged overlay onto the
      // swarm via the x-dispatch/permissions.set notification-pair RPC.
      // We bind the staged entry to the new streamId so closeStream can
      // pair it with a clear later.
      await activatePendingOverlay({
        swarmId: serverId,
        agentId,
        streamId: result.streamId,
      }).catch((err) => {
        console.warn(
          `[openhive-runtime] permissions.set failed swarm=${serverId} agent=${agentId}: ${
            (err as Error).message
          } (continuing without overlay enforcement)`,
        );
      });
      return result;
    },

    initializeStream: async (streamId) => {
      await deps.getAcpStreamManager()!.initialize(streamId);
    },

    createSession: async (streamId, cwd) => {
      const loadout = loadoutByStream.get(streamId);
      return deps.getAcpStreamManager()!.newSession(streamId, {
        cwd,
        mcpServers: loadout?.mcpProviders ?? [],
      });
    },

    sendPrompt: async (streamId, sessionId, prompt) => {
      const loadout = loadoutByStream.get(streamId);
      const text = loadout?.promptAddendum
        ? `${loadout.promptAddendum}\n\n${prompt}`
        : prompt;
      await deps.getAcpStreamManager()!.prompt(streamId, {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
    },

    closeStream: async (streamId) => {
      loadoutByStream.delete(streamId);
      // Clear any active overlay before tearing down the stream so the
      // long-lived agent isn't left with stale dispatch deny rules.
      // Errors here are non-fatal — the overlay times out / gets
      // overwritten by the next dispatch anyway.
      await deactivateOverlay(streamId).catch((err) => {
        console.warn(
          `[openhive-runtime] permissions.clear failed stream=${streamId}: ${
            (err as Error).message
          }`,
        );
      });
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
