/**
 * Session scope resolution for MAP inbound connections.
 *
 * At `map/connect` time, we compute the agent's effective scopes and attach
 * them to the connection. Method handlers read the scopes via
 * `getSessionScopes(swarmId)` and enforce gates via `requireCapability`.
 *
 * The two trust modes resolve scopes differently:
 *
 * - **verified**: the agent presented an agent-iam token. Its signed scope
 *   list IS the session's scope set.
 * - **open**: the agent presented only an API key. Scopes come from the
 *   `agents.capabilities` DB column (plus `map:*` for admins).
 *
 * Admins in either mode carry `map:*` so wildcard-matching covers any
 * future capability string without an explicit enumeration.
 *
 * See docs/RFC_AGENT_CAPABILITIES.md v4 §"Session scope resolution".
 */

import { scopeMatches } from 'agent-iam';
import type { Agent } from '../types.js';
import { getAgentCapabilities } from '../db/dal/agents.js';
import { getInbound } from './connection-registry.js';

// ============================================================================
// Resolution
// ============================================================================

export interface ResolveScopesInput {
  /** The hub agent who owns this connection (always present). */
  agent: Agent;
  /** Scopes from the agent-iam token in verified mode. Undefined in open mode. */
  tokenScopes?: string[];
}

/**
 * Compute the scope list for a freshly-connected MAP session.
 *
 * - Admin agents always get `map:*` so scope checks succeed via wildcard
 *   matching without maintaining a per-admin grant list.
 * - Verified-mode sessions inherit the scopes carried by the agent-iam
 *   token. No DB lookup — the token is authoritative.
 * - Open-mode sessions look up the DB `capabilities` column. The grant
 *   ledger is the source of truth.
 */
export function resolveSessionScopes(input: ResolveScopesInput): string[] {
  if (input.agent.is_admin) {
    return ['map:*'];
  }
  if (input.tokenScopes && input.tokenScopes.length > 0) {
    return [...input.tokenScopes];
  }
  // Fall through to DB grant ledger for non-admin open-mode sessions.
  const caps = getAgentCapabilities(input.agent.id);
  return Object.keys(caps);
}

// ============================================================================
// Runtime queries
// ============================================================================

/**
 * Return the scope list attached to an active MAP session.
 *
 * Returns `undefined` only when the swarm is not connected. A connected
 * session that didn't populate `sessionScopes` (legacy / test fixture)
 * reads as an empty array — default-deny.
 */
export function getSessionScopes(swarmId: string): string[] | undefined {
  const conn = getInbound(swarmId);
  if (!conn) return undefined;
  return conn.sessionScopes ?? [];
}

/**
 * Check whether a session's scope list grants a specific capability.
 *
 * Uses agent-iam's `scopeMatches` so wildcards (`map:*`) cover narrower
 * capabilities (`map:agents:spawn`).
 */
export function sessionHasCapability(
  scopes: readonly string[] | undefined,
  required: string,
): boolean {
  if (!scopes) return false;
  return scopes.some((scope) => scopeMatches(scope, required));
}

// ============================================================================
// Enforcement
// ============================================================================

/** Thrown by `requireCapability` on denial. Maps to JSON-RPC -32403. */
export class CapabilityDeniedError extends Error {
  readonly code = -32403;
  constructor(public readonly capability: string, agentId?: string) {
    super(
      agentId
        ? `Agent ${agentId} is not authorized for '${capability}'`
        : `Required capability '${capability}' not held`,
    );
    this.name = 'CapabilityDeniedError';
  }
}

/**
 * Minimum shape the enforcement helper needs. MAP handler contexts vary
 * across dispatch sites (REST-mounted vs MAP-native), so we accept
 * anything that can produce a scope list or a swarm id.
 */
export interface CapabilityCheckCtx {
  swarmId?: string;
  agentId?: string;
  scopes?: readonly string[];
}

/**
 * Throw `CapabilityDeniedError` if the context's session scopes don't
 * satisfy the required capability.
 *
 * Prefers explicit `ctx.scopes` (e.g. passed through from an extended
 * handler context) and falls back to looking up from the registry by
 * `ctx.swarmId`.
 */
export function requireCapability(
  ctx: CapabilityCheckCtx,
  required: string,
): void {
  const scopes = ctx.scopes ?? (ctx.swarmId ? getSessionScopes(ctx.swarmId) : undefined);
  if (sessionHasCapability(scopes, required)) return;
  throw new CapabilityDeniedError(required, ctx.agentId);
}
