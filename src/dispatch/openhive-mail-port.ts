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
import { getInbound } from '../map/connection-registry.js';
import {
  consumeLoadoutForDispatch,
  peekHintsForDispatch,
} from './loadout-side-channel.js';
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

export function createOpenHiveMailPort(transport: MailTransport): MessagePort {
  return createMailPort({
    send: async (system, agentId, envelope) => {
      // Lifecycle-fresh dispatches must NOT take the mail route: the
      // mail-inbound consumer would spawn a fresh worker (correct
      // behavior) but bypasses the ACP path entirely. When a dispatch's
      // hint says 'fresh' AND we're inside `prefer-route`, returning
      // `delivered: false` here causes the orchestrator to fall through
      // to the runtime adapter (ACP), which honors the hint and calls
      // `dispatch/spawn-agent`.
      //
      // Peek (don't consume) so the runtime adapter still sees the
      // hint when it runs next.
      const taskId = (envelope.body as { taskId?: string })?.taskId;
      if (taskId) {
        const hints = peekHintsForDispatch(taskId);
        if (hints?.acpLifecycle === 'fresh') {
          return { delivered: false, reason: 'lifecycle_fresh' };
        }
      }
      return transport.sendToAgent(system, agentId, injectLoadoutMetadata(envelope));
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
}
