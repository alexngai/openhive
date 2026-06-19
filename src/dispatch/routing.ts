/**
 * Dispatch routing pre-flight
 *
 * Answers "can we actually dispatch to this swarm right now?" before a
 * dispatch row is created. Used by POST /specs/:id/dispatch and
 * map/specs/dispatch to return an actionable error instead of queuing a
 * task that the orchestrator will fail at claim time.
 *
 * Route priority mirrors the orchestrator's `prefer-route` behaviour:
 *   - Codex executor targets win when the hub has the local swarm-codex
 *     executor branch enabled. These targets are hub-local workers, not
 *     inbound ACP/mail agents.
 *   - ACP (spawn path) wins when an ACP-capable agent exists AND the stream
 *     manager is available on the hub.
 *   - Mail fallback wins when any agent on the swarm declares `mail.canJoin`
 *     or `messaging.canReceive` (the cascade transport handles both).
 *   - Otherwise the swarm is unreachable for dispatch.
 *
 * The ACP stream-manager probe is registered at server startup so this
 * module doesn't reach into fastify or the orchestrator directly.
 */

import { findAcpAgentInfo, hasCapability } from '../map/connection-registry.js';

type AcpAvailabilityProbe = () => boolean;
type CodexExecutorProbe = (swarmId: string) => boolean;

let acpAvailable: AcpAvailabilityProbe = () => false;
let codexExecutorAvailable: CodexExecutorProbe = () => false;

export function setAcpAvailabilityProbe(probe: AcpAvailabilityProbe): void {
  acpAvailable = probe;
}

export function setCodexExecutorProbe(probe: CodexExecutorProbe): void {
  codexExecutorAvailable = probe;
}

export type DispatchRoute = 'codex' | 'acp' | 'mail' | 'none';

export interface RouteDecision {
  route: DispatchRoute;
  reason?: string;
}

export function canRouteToSwarm(swarmId: string): RouteDecision {
  if (codexExecutorAvailable(swarmId)) return { route: 'codex' };

  const acpAgent = findAcpAgentInfo(swarmId);
  if (acpAgent) {
    if (acpAvailable()) return { route: 'acp' };
    // ACP is the preferred shape but the hub can't drive it right now; mail
    // might still work if any agent on the swarm advertises it.
    if (hasCapability(swarmId, 'mail.canJoin') || hasCapability(swarmId, 'messaging.canReceive')) {
      return { route: 'mail' };
    }
    return {
      route: 'none',
      reason: 'ACP target found but the hub has no ACP stream manager (headless deployment)',
    };
  }

  if (hasCapability(swarmId, 'mail.canJoin') || hasCapability(swarmId, 'messaging.canReceive')) {
    return { route: 'mail' };
  }

  return {
    route: 'none',
    reason: 'Swarm exposes neither ACP nor mail/messaging capabilities',
  };
}

/** Test helper. */
export function _resetDispatchRouting(): void {
  acpAvailable = () => false;
  codexExecutorAvailable = () => false;
}
