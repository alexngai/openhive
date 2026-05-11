/**
 * OpenHive MessagePort — mail-based dispatch routing
 *
 * Composes swarm-dispatch's generic createMailPort with OpenHive's
 * MAP connection registry for reachability checks and agent-inbox
 * transport for message delivery.
 *
 * Loadout metadata injection: swarm-dispatch's `MessagePort.deliver`
 * payload is fixed to `{ prompt, taskId, role }`. We wrap the transport's
 * `sendToAgent` so that any envelope with `body.taskId` matching a
 * registered materialized loadout (via the side-channel) gets the
 * loadout's structured fields (permissions, MCP metadata) injected into
 * `body.metadata` before the wire-level send. The mail-inbound consumer
 * on the swarm side reads `data.metadata` and passes the relevant fields
 * to `agentManager.spawn()`.
 */

import { createMailPort } from 'swarm-dispatch/client';
import type { MessagePort } from 'swarm-dispatch';
import { findSidecarAgentId, getInbound, resolveInboxAgentId } from '../map/connection-registry.js';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { countPendingThreadMessages } from './openhive-source.js';
import {
  consumeLoadoutForDispatch,
  peekHintsForDispatch,
} from './loadout-side-channel.js';
import { getRepoBindingForDispatch } from './repo-side-channel.js';
import { materializedLoadoutToWire } from './wire-loadout.js';

export interface MailTransport {
  sendToAgent(
    swarmId: string,
    agentId: string,
    message: { type: string; body: Record<string, unknown> },
  ): Promise<{ delivered: boolean; reason?: string }>;
  onMessage(
    handler: (from: { swarmId: string; agentId: string }, message: Record<string, unknown>) => void,
  ): () => void;
  /** Optional: tear down listeners owned by the transport. */
  destroy?(): void;
}

/**
 * Inject loadout-derived structured fields into an outgoing dispatch
 * envelope when the body's taskId matches a registered materialized
 * loadout. Returns the envelope unchanged when no loadout is in the
 * side-channel (cancel envelopes, non-dispatch messages, etc.).
 *
 * Wire shape (Step 3 of the ACP+lifecycle plan):
 *
 *   - `body.loadout` — the canonical structured slot, mirroring the
 *     `MaterializedLoadout` subset that ACP-routed dispatches carry in
 *     their `dispatch/spawn-agent` MAP request params. Both wire paths
 *     use the same shape; the worker-side runtime translates per its
 *     config model (macro-agent: `loadoutToSpawnOptions`).
 *
 *   - `body.metadata.permissions` / `body.metadata.mcpProviders` —
 *     legacy fields kept for one deprecation cycle so older
 *     `mail-inbound-consumer` builds continue to work. Removed in a
 *     follow-up PR after the new shape has rolled out.
 *
 * Other materialized fields (skills.rendered, promptAddendum) ride in
 * the prompt body for both routes and aren't included here.
 */
function injectLoadoutMetadata(envelope: {
  type: string;
  body: Record<string, unknown>;
}): { type: string; body: Record<string, unknown> } {
  const taskId = (envelope.body as { taskId?: string })?.taskId;
  if (!taskId) return envelope;
  const loadout = consumeLoadoutForDispatch(taskId);
  if (!loadout) return envelope;

  // Canonical wire shape — produced by the shared helper so this path
  // and the ACP `dispatch/spawn-agent` path can't drift.
  const wireLoadout = materializedLoadoutToWire(loadout) as Record<string, unknown>;

  // Legacy fields — removed once consumers across the fleet read from
  // body.loadout. Two writes during the transition window.
  const legacyMetadata: Record<string, unknown> = {
    ...((envelope.body.metadata as Record<string, unknown> | undefined) ?? {}),
  };
  if (wireLoadout.permissions !== undefined) {
    legacyMetadata.permissions = wireLoadout.permissions;
  }
  if (wireLoadout.mcpProviders !== undefined) {
    legacyMetadata.mcpProviders = wireLoadout.mcpProviders;
  }

  const hasNewSlot = Object.keys(wireLoadout).length > 0;
  const hasLegacy =
    Object.keys(legacyMetadata).length >
    Object.keys(
      (envelope.body.metadata as Record<string, unknown> | undefined) ?? {},
    ).length;

  if (!hasNewSlot && !hasLegacy) return envelope;

  return {
    ...envelope,
    body: {
      ...envelope.body,
      ...(hasNewSlot ? { loadout: wireLoadout } : {}),
      ...(hasLegacy ? { metadata: legacyMetadata } : {}),
    },
  };
}

/**
 * Inject repo binding fields into an outgoing dispatch envelope when the
 * body's taskId matches a registered repo binding in the side-channel.
 * The consumer reads these from `data.metadata` to set the worker's cwd
 * and optionally clone the repo pre-spawn.
 */
function injectRepoMetadata(envelope: {
  type: string;
  body: Record<string, unknown>;
}): { type: string; body: Record<string, unknown> } {
  const taskId = (envelope.body as { taskId?: string })?.taskId;
  if (!taskId) return envelope;
  const binding = getRepoBindingForDispatch(taskId);
  if (!binding) return envelope;

  const repoFields: Record<string, unknown> = { repo_id: binding.repoId };
  if (binding.canonicalUrl) repoFields.canonical_url = binding.canonicalUrl;
  if (binding.branch) repoFields.branch = binding.branch;
  if (binding.commitSha) repoFields.commit_sha = binding.commitSha;
  if (binding.clonePolicy && binding.clonePolicy !== 'none') {
    repoFields.clone_policy = binding.clonePolicy;
  }
  if (binding.clonePath) repoFields.clone_path = binding.clonePath;

  const existingMeta =
    (envelope.body.metadata as Record<string, unknown> | undefined) ?? {};

  return {
    ...envelope,
    body: {
      ...envelope.body,
      metadata: { ...existingMeta, ...repoFields },
    },
  };
}

export interface OpenHiveMailPortOptions {
  /**
   * Cluster-wide default for the mail-route lifecycle when a dispatch's
   * `mail_lifecycle` column is null. Wired from
   * `config.dispatch.mail_lifecycle_default` at server startup. Mirrors
   * `OpenHiveRuntimeDeps.acpLifecycleDefault`.
   */
  mailLifecycleDefault?: 'fresh' | 'reuse';
  /**
   * Optional mail RPC accessor for `checkThreadPending`. When provided,
   * enables the continuation policy to query pending thread messages.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getMailJsonRpc?: () => { handleRequest: (req: any) => Promise<any> };
}

/**
 * Read the per-dispatch mail lifecycle preference. Precedence:
 *
 *   1. Side-channel hint sourced from the dispatch row's `mail_lifecycle`
 *      column at enrichment time (set per-dispatch via REST).
 *   2. `configDefault` — cluster-wide operator default from
 *      `config.dispatch.mail_lifecycle_default`.
 *   3. Hardcoded `'reuse'` — backwards-compatible default.
 *
 * Mirrors `readDispatchLifecycle` for the ACP route.
 */
export function readMailLifecycle(
  hints: { mailLifecycle?: 'fresh' | 'reuse' } | null,
  configDefault?: 'fresh' | 'reuse',
): 'fresh' | 'reuse' {
  if (hints?.mailLifecycle === 'fresh' || hints?.mailLifecycle === 'reuse') {
    return hints.mailLifecycle;
  }
  if (configDefault === 'fresh' || configDefault === 'reuse') {
    return configDefault;
  }
  return 'reuse';
}

export function createOpenHiveMailPort(
  transport: MailTransport,
  opts: OpenHiveMailPortOptions = {},
): MessagePort {
  const port = createMailPort({
    send: async (system, agentId, envelope) => {
      // ACP-lifecycle-fresh dispatches must NOT take the mail route: the
      // mail-inbound consumer would spawn a fresh worker (correct
      // behavior) but bypasses the ACP path entirely. When a dispatch's
      // hint says 'fresh' AND we're inside `prefer-route`, returning
      // `delivered: false` here causes the orchestrator to fall through
      // to the runtime adapter (ACP), which honors the hint and calls
      // `dispatch/spawn-agent`.
      //
      // Peek (don't consume) so the runtime adapter still sees the
      // hint when it runs next.
      const { markDelivery } = await import('./delivery-tracker.js');
      const taskId = (envelope.body as { taskId?: string })?.taskId;

      let recipient = agentId;
      if (taskId) {
        const hints = peekHintsForDispatch(taskId);
        if (hints?.acpLifecycle === 'fresh') {
          return { delivered: false, reason: 'lifecycle_fresh' };
        }
        // Mail-lifecycle-fresh override: when a dispatch wants a fresh
        // spawn via the mail route, re-route to the connection's sidecar
        // regardless of whichever agent prefer-route picked. The
        // sidecar's mail-inbound-consumer always spawns a new ephemeral
        // worker per envelope (today's pre-this-work behavior). Falls
        // through silently when no sidecar is registered or the picked
        // agent already IS the sidecar.
        const lifecycle = readMailLifecycle(hints, opts.mailLifecycleDefault);
        if (lifecycle === 'fresh') {
          const sidecarId = findSidecarAgentId(system);
          if (sidecarId && sidecarId !== agentId) {
            recipient = sidecarId;
          }
        }
      }

      const enrichedEnvelope = injectRepoMetadata(injectLoadoutMetadata(envelope));
      const result = await transport.sendToAgent(
        system,
        recipient,
        enrichedEnvelope,
      );
      // Record the actual recipient + transport on the dispatch row's
      // attempts_history once the orchestrator's `dispatched` event fires.
      // We mark only on `delivered: true` — failed delivery falls through
      // to the runtime adapter (ACP path) and the runtime would then mark
      // its own attempt.
      if (taskId && result.delivered) {
        markDelivery(taskId, { transport: 'mail', agent_id: recipient });
      }
      return result;
    },

    onMessage: (handler) =>
      transport.onMessage((from, msg) =>
        handler({ system: from.swarmId, agentId: from.agentId }, msg),
      ),

    isReachable: (system, agentId) => {
      if (!getInbound(system)) return false;
      // The cascade transport probes per-agent caps at send time; here we
      // only need the connection to be alive so swarm-dispatch doesn't
      // short-circuit before the per-agent check runs.
      return !!agentId;
    },
  });

  // Extend with checkThreadPending when mail RPC is available
  if (opts.getMailJsonRpc) {
    const getMailRpc = opts.getMailJsonRpc;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (port as any).checkThreadPending = async (dispatchId: string) => {
      const dispatch = dispatchesDAL.findDispatchById(dispatchId);
      if (!dispatch?.conversation_id) return null;

      // Find current executor from latest running attempt
      const currentAttempt = dispatch.attempts_history
        ?.filter((a) => a.status === 'running')
        .pop();
      const executorId = currentAttempt?.agent_id;
      const inboxId = executorId
        ? resolveInboxAgentId(dispatch.target_swarm_id, executorId)
        : undefined;

      const count = await countPendingThreadMessages(
        dispatch.conversation_id,
        inboxId,
        getMailRpc(),
      );

      return {
        count,
        participants: inboxId ? [{ agentId: inboxId, unreadCount: count }] : [],
      };
    };
  }

  return port;
}
