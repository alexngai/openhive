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
import { consumeLoadoutForDispatch } from './loadout-side-channel.js';

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

  const hasPermissions =
    (loadout.permissions.allow?.length ?? 0) +
      (loadout.permissions.deny?.length ?? 0) +
      (loadout.permissions.ask?.length ?? 0) >
    0;

  // Build the canonical `body.loadout` slot — runtime-translatable wire
  // shape consumed by both mail-inbound (this path) and the new
  // dispatch/spawn-agent ACP path.
  const wireLoadout: Record<string, unknown> = {};
  if (hasPermissions) {
    wireLoadout.permissions = {
      ...(loadout.permissions.allow?.length ? { allow: loadout.permissions.allow } : {}),
      ...(loadout.permissions.deny?.length ? { deny: loadout.permissions.deny } : {}),
      ...(loadout.permissions.ask?.length ? { ask: loadout.permissions.ask } : {}),
    };
  }
  if (loadout.mcpProviders?.length) {
    wireLoadout.mcpProviders = loadout.mcpProviders;
  }
  if (loadout.mcpScope?.length) {
    wireLoadout.mcpScope = loadout.mcpScope;
  }
  if (loadout.capabilities?.length) {
    wireLoadout.capabilities = loadout.capabilities;
  }

  // Legacy fields — removed once consumers across the fleet read from
  // body.loadout. Two writes during the transition window.
  const legacyMetadata: Record<string, unknown> = {
    ...((envelope.body.metadata as Record<string, unknown> | undefined) ?? {}),
  };
  if (hasPermissions) {
    legacyMetadata.permissions = wireLoadout.permissions;
  }
  if (loadout.mcpProviders?.length) {
    legacyMetadata.mcpProviders = loadout.mcpProviders;
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
    send: (system, agentId, envelope) =>
      transport.sendToAgent(system, agentId, injectLoadoutMetadata(envelope)),

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
