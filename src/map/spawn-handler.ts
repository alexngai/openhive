/**
 * Handler for `map/agents/spawn` (PR 3 of the v4 capability rollout).
 *
 * The caller (a connected swarm holding the `map:agents:spawn` capability)
 * asks the hub to create a child agent. The hub:
 *   1. Checks the caller's session has the `map:agents:spawn` scope
 *   2. Validates the `parent` param matches the calling agent
 *   3. Creates a DB agent row for the child
 *   4. Mints a delegated agent-iam token for the child via
 *      `delegateForSpawn`
 *   5. Returns `{ agent, delegatedCredentials }` per MAP spec
 *
 * The parent hands `delegatedCredentials.credentials.token` (or the
 * `env` payload) to the child subprocess; the subprocess uses it as
 * its credential on `map/connect`.
 *
 * See docs/RFC_AGENT_CAPABILITIES.md v4.
 */

import { z } from 'zod';
import * as agentsDAL from '../db/dal/agents.js';
import { getSessionScopes, requireCapability, CapabilityDeniedError } from './session-scopes.js';
import { delegateForSpawn, ScopeNotGrantedError } from './delegate-for-spawn.js';
import type { DelegatedCredentials } from './delegate-for-spawn.js';
import { getInbound } from './connection-registry.js';

// ============================================================================
// Types & validation
// ============================================================================

/**
 * Request params for `map/agents/spawn`. Matches the MAP spec
 * (schema/schema.json) for the fields OpenHive actually uses.
 *
 * `parent`, `name`, `requestedScopes` are required by our handler even
 * though the spec marks most as optional — we want the caller to be
 * explicit about the child's authority.
 */
const SpawnParamsSchema = z.object({
  parent: z.string().min(1),
  name: z.string().min(1).max(200),
  role: z.string().max(100).optional(),
  requestedScopes: z.array(z.string()).default([]),
  ttlMinutes: z.number().int().optional(),
  capabilities: z.record(z.unknown()).optional(),
  capabilityDescriptor: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type SpawnParams = z.infer<typeof SpawnParamsSchema>;

export interface SpawnHandlerCtx {
  /** The inbound swarm session performing the spawn. */
  swarmId: string;
  /** The hub agent who owns the WS connection (i.e. the API-key holder). */
  hubAgentId: string;
}

export interface SpawnResult {
  agent: {
    id: string;
    name: string;
    role?: string;
    metadata?: Record<string, unknown>;
    capabilityDescriptor?: Record<string, unknown>;
    visibility: 'public';
    state: 'ready';
  };
  delegatedCredentials: DelegatedCredentials;
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle a single `map/agents/spawn` request. Throws on any failure
 * with an attached JSON-RPC `code` field so the MAP server can surface
 * the right error to the caller.
 */
export async function handleSpawnRequest(
  rawParams: unknown,
  ctx: SpawnHandlerCtx,
): Promise<SpawnResult> {
  // ── Param validation ─────────────────────────────────────────────
  let params: SpawnParams;
  try {
    params = SpawnParamsSchema.parse(rawParams);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw Object.assign(new Error(`Invalid spawn params: ${err.errors.map((e) => e.message).join('; ')}`), {
        code: -32602, // JSON-RPC: Invalid params
      });
    }
    throw err;
  }

  // ── Scope check ──────────────────────────────────────────────────
  // Capability lives on the WS session, which is identified by the hub
  // agent (API-key holder / token subject). `params.parent` is a
  // MAP-registered agent that the session manages; we do not require
  // it to equal the hub agent — a sidecar may register multiple MAP
  // agents and any of them can be named as the spawn parent.
  try {
    requireCapability(
      { swarmId: ctx.swarmId, agentId: ctx.hubAgentId },
      'map:agents:spawn',
    );
  } catch (err) {
    if (err instanceof CapabilityDeniedError) {
      throw Object.assign(new Error(err.message), { code: err.code });
    }
    throw err;
  }

  // ── Delegatable check ────────────────────────────────────────────
  // If the caller's session was authenticated with an agent-iam token
  // that was itself marked non-delegatable (i.e. the caller is a
  // delegated child with `delegatable: false`), reject the spawn. This
  // is the enforcement side of the RFC §"children cannot delegate
  // further" contract — the flag is set at mint time by
  // `delegate-for-spawn.ts` and consumed here.
  const conn = getInbound(ctx.swarmId);
  if (conn?.tokenDelegatable === false) {
    throw Object.assign(
      new Error('Caller token is not delegatable — cannot spawn child agents'),
      { code: -32403 },
    );
  }

  // ── Validate parent is one of the session's registered agents ─────
  // Prevents audit-log spoofing. A session can only name as `parent`
  // an agent it has registered on this WS connection (via
  // map/agents/register). The hubAgentId (API-key / token subject)
  // always counts as a valid "parent" even if no map/agents/register
  // has been issued yet — this supports the operator-bootstrap case
  // where the onboarded swarm spawns before registering itself.
  const registered = conn?.registeredAgents;
  const isKnownParent =
    params.parent === ctx.hubAgentId
    || (registered?.has(params.parent) ?? false);
  if (!isKnownParent) {
    throw Object.assign(
      new Error(`Parent '${params.parent}' is not registered on this session`),
      { code: -32602 },
    );
  }

  // ── Create child agent row ────────────────────────────────────────
  // The generated api_key is intentionally discarded — the child
  // authenticates exclusively via the delegated agent-iam token. The
  // row exists so future `findAgentById` lookups (e.g. at the child's
  // own map/connect) resolve.
  const { agent: childAgent } = await agentsDAL.createAgent({
    name: params.name,
    description: `Spawned from ${params.parent}`,
    metadata: {
      ...(params.metadata ?? {}),
      spawned_by: params.parent,
      spawned_at: new Date().toISOString(),
    },
  });

  // ── Mint delegated credentials ────────────────────────────────────
  // When the session carries an agent-iam token (conn.tokenSerialized),
  // pass it through so `delegateForSpawn` uses the real chain-walking
  // `TokenService.delegate`. Without a token (open-mode API-key
  // sessions), fall back to the scope-set minted via createRootToken.
  const parentScopes = getSessionScopes(ctx.swarmId) ?? [];
  let delegatedCredentials: DelegatedCredentials;
  try {
    delegatedCredentials = delegateForSpawn({
      parentAgentId: params.parent,
      parentScopes,
      childAgentId: childAgent.id,
      requestedScopes: params.requestedScopes,
      ttlMinutes: params.ttlMinutes,
      parentSerializedToken: conn?.tokenSerialized,
      childDelegatable: false,
    });
  } catch (err) {
    // Roll back the child agent row — delegation failed, don't leave
    // an orphan behind.
    try {
      agentsDAL.deleteAgent(childAgent.id);
    } catch {
      /* best-effort cleanup */
    }
    if (err instanceof ScopeNotGrantedError) {
      throw Object.assign(new Error(err.message), { code: err.code });
    }
    throw err;
  }

  return {
    agent: {
      id: childAgent.id,
      name: childAgent.name,
      role: params.role,
      metadata: {
        ...(params.metadata ?? {}),
        parentId: params.parent,
      },
      capabilityDescriptor: params.capabilityDescriptor,
      visibility: 'public',
      state: 'ready',
    },
    delegatedCredentials,
  };
}

// Exported for registration via `additionalHandlers` in
// `map-server-setup.ts`.
export const SPAWN_METHOD = 'map/agents/spawn';
