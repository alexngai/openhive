/**
 * Spawn-credential delegation for `map/agents/spawn`.
 *
 * When an authorized agent calls `map/agents/spawn`, the hub mints a
 * delegated agent-iam token for the new child agent and returns it in
 * the response's `delegatedCredentials` field. The parent hands the
 * token to the child (e.g. via subprocess env vars) and the child uses
 * it to authenticate its own `map/connect`.
 *
 * Two entry shapes:
 *
 *  - **Operator bootstrap** (`admin onboard-token`): no parent token
 *    exists; admin authority is sovereign. Falls back to
 *    `createRootToken` with caller-chosen scopes. The minted token is
 *    still `delegatable: true` so the onboarded swarm can spawn its
 *    own children.
 *
 *  - **Agent-to-agent spawn** (`map/agents/spawn` over MAP WS): the
 *    caller's session carries a serialized agent-iam token. We use
 *    `TokenService.delegate(parentToken, ...)` so the child inherits
 *    agent-iam's native parent chain, enabling:
 *      * Scope attenuation enforced cryptographically
 *      * Depth limiting via `maxDelegationDepth`
 *      * Cascade revocation — revoking an ancestor's agentId
 *        transitively invalidates descendants via the chain registry
 *        in `token-service.ts`.
 *
 * See docs/RFC_AGENT_CAPABILITIES.md v4.
 */

import { scopeMatches } from 'agent-iam';
import type { AgentToken } from 'agent-iam';
import { getTokenService, recordParent } from './token-service.js';

// ============================================================================
// Types matching the MAP spec's DelegatedCredentials shape
// ============================================================================

export interface SpawnDelegationRequest {
  /**
   * The caller's (parent's) agent id. Used to stamp the parent chain
   * when no parent token is supplied (operator bootstrap); when
   * `parentSerializedToken` is present, the parent id is read off the
   * token instead.
   */
  parentAgentId: string;
  /**
   * The caller's effective scopes. Acts as the scope ceiling:
   * `requestedScopes` must be a subset (wildcards allowed).
   *
   * In verified MAP mode this is the agent-iam token's scopes. In open
   * mode it's what `resolveSessionScopes` computed from the DB + admin
   * flag at `map/connect` time.
   */
  parentScopes: readonly string[];
  /** The new child agent's id (allocated at spawn time). */
  childAgentId: string;
  /**
   * Scopes requested for the child. Empty array defaults to the full
   * parent scope set.
   */
  requestedScopes: readonly string[];
  /** Optional TTL override. Default 60; clamped to [1, 1440] minutes. */
  ttlMinutes?: number;
  /**
   * The caller's serialized agent-iam token, if one exists. When
   * present, delegation flows through `TokenService.delegate` so the
   * child inherits the full parent chain. When absent (operator
   * bootstrap path), we mint a root token instead.
   */
  parentSerializedToken?: string;
  /**
   * Whether the child itself should be allowed to spawn grandchildren.
   * Defaults to `true`. `delegate()` will cap this to the parent's
   * delegatable flag — a non-delegatable parent cannot produce a
   * delegatable child.
   */
  childDelegatable?: boolean;
}

export interface DelegatedCredentials {
  /** Auth method the child should use on its own `map/connect`. */
  method: string;
  /** Credential payload (opaque to the protocol; for agent-iam this is { token }). */
  credentials: { token: string };
  /**
   * Environment variables pre-formatted for subprocess injection.
   * Spec-defined per MAP schema.json.
   */
  env: Record<string, string>;
  /** Effective TTL of the minted token in minutes (after clamping). */
  ttlMinutes: number;
  /** ISO 8601 timestamp when the token expires. */
  expiresAt: string;
}

// ============================================================================
// TTL bounds
// ============================================================================

const DEFAULT_TTL_MINUTES = 60;
/**
 * Standard cap for agent-to-agent delegation. 24h balances practicality
 * for long-running hosted swarms against the RFC §"TTL bounds" guidance
 * that tokens should be refreshable within a reasonable window.
 */
const MAX_DELEGATED_TTL_MINUTES = 24 * 60; // 24 hours
/**
 * Extended cap for admin-authority bootstrap tokens (`admin onboard-
 * token`). Operators may legitimately need longer-lived credentials for
 * a hosted swarm that cannot easily be restarted. Capped at 30 days so
 * "forever" tokens are at least surfaced as a choice.
 */
const MAX_ROOT_TTL_MINUTES = 30 * 24 * 60; // 30 days
const MIN_TTL_MINUTES = 1;

function clampTtl(requested: number | undefined, max: number): number {
  if (requested === undefined) return Math.min(DEFAULT_TTL_MINUTES, max);
  return Math.max(MIN_TTL_MINUTES, Math.min(requested, max));
}

// ============================================================================
// Scope subset validation
// ============================================================================

/**
 * Thrown when a spawn request asks for scopes the parent doesn't hold.
 * agent-iam's `delegate()` also enforces this, but we check up front so
 * the error surfaces before the token service is called — cleaner
 * error reporting.
 */
export class ScopeNotGrantedError extends Error {
  readonly code = -32403;
  constructor(public readonly scope: string) {
    super(`Requested scope '${scope}' not covered by parent authority`);
    this.name = 'ScopeNotGrantedError';
  }
}

function assertScopeSubset(
  requested: readonly string[],
  parentScopes: readonly string[],
): void {
  for (const scope of requested) {
    const covered = parentScopes.some((p) => scopeMatches(p, scope));
    if (!covered) throw new ScopeNotGrantedError(scope);
  }
}

// ============================================================================
// Core delegation
// ============================================================================

/**
 * Mint a delegated agent-iam token for a child agent being spawned by
 * an authorized parent.
 *
 * Validates `requestedScopes ⊆ parentScopes` (pre-check), clamps the
 * TTL, and chooses the token-minting path based on whether a parent
 * token is available:
 *
 *  - **With parent token:** calls `TokenService.delegate(parent, ...)`.
 *    The child carries `parentId`, `currentDepth: parent.depth + 1`,
 *    and is recorded in the parent-chain registry so cascade
 *    revocation works.
 *
 *  - **Without parent token** (operator bootstrap): calls
 *    `createRootToken` with a fresh identity. No chain; revocation
 *    targets this agentId directly.
 *
 * Throws:
 * - `ScopeNotGrantedError` if any requested scope isn't covered by the
 *   parent's scopes
 * - agent-iam native errors from `delegate()` when the parent is
 *   non-delegatable or depth is exceeded
 */
export function delegateForSpawn(
  request: SpawnDelegationRequest,
): DelegatedCredentials {
  // Agent-to-agent delegation caps at 24h; operator-bootstrap caps at
  // 30d. The latter is gated by admin-key auth at the API layer, so
  // raising the ceiling doesn't change who can mint long-lived tokens.
  const ttlCap = request.parentSerializedToken
    ? MAX_DELEGATED_TTL_MINUTES
    : MAX_ROOT_TTL_MINUTES;
  const ttlMinutes = clampTtl(request.ttlMinutes, ttlCap);
  const requestedScopes =
    request.requestedScopes.length > 0
      ? [...request.requestedScopes]
      : [...request.parentScopes];

  assertScopeSubset(requestedScopes, request.parentScopes);

  const ts = getTokenService();
  let childToken: AgentToken;

  if (request.parentSerializedToken) {
    // Real delegation — agent-iam stamps parentId, currentDepth, and
    // caps delegatable/maxDelegationDepth against the parent.
    const parentToken = ts.deserialize(request.parentSerializedToken);
    childToken = ts.delegate(parentToken, {
      agentId: request.childAgentId,
      requestedScopes,
      ttlMinutes,
      delegatable: request.childDelegatable ?? false,
    });
    // Record the child→parent edge for cascade revocation lookup.
    recordParent(childToken.agentId, parentToken.agentId);
  } else {
    // Operator bootstrap — admin authority has no parent token.
    // delegatable defaults to true here so the onboarded swarm can
    // spawn its own children.
    childToken = ts.createRootToken({
      agentId: request.childAgentId,
      scopes: requestedScopes,
      ttlDays: ttlMinutes / (60 * 24),
      delegatable: request.childDelegatable ?? true,
    });
    // Even though there's no token parent, stamp the logical
    // parentAgentId edge so operator revocation still cascades if the
    // admin chose to revoke the onboarded agent's authority id.
    if (request.parentAgentId && request.parentAgentId !== 'admin-key') {
      recordParent(childToken.agentId, request.parentAgentId);
    }
  }

  const serialized = ts.serialize(childToken);

  return {
    // `bearer` matches the MAP spec's `DelegatedCredentials.method`
    // vocabulary. The child hands the token back via the same
    // `Authorization: Bearer <token>` header REST uses, and the
    // MAP-WS `?token=` gate accepts it identically.
    method: 'bearer',
    credentials: { token: serialized },
    env: {
      AGENT_TOKEN: serialized,
      MAP_CREDENTIAL: serialized,
    },
    ttlMinutes,
    expiresAt: childToken.expiresAt ?? new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
  };
}
