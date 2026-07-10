/**
 * Onboard-token minting, shared by the `POST /admin/onboard-token` route
 * and the setup engine's agent-access section. Resolves (or creates) the
 * child agent, then delegates a scoped token off the admin root.
 */

import * as agentsDAL from '../db/dal/agents.js';
import { delegateForSpawn } from './delegate-for-spawn.js';

export class AgentNotFoundError extends Error {}

export interface MintOnboardTokenInput {
  scopes: string[];
  ttlHours: number;
  agentName?: string;
  /** Re-issue for an existing agent instead of creating a new one */
  agentId?: string;
}

export interface MintedOnboardToken {
  agent_id: string;
  token: string;
  method: string;
  env: Record<string, string>;
  scopes: string[];
  /** Effective TTL after clamping (may be lower than requested) */
  ttl_hours: number;
  expires_at: string;
}

/**
 * Throws AgentNotFoundError for an unknown agentId and propagates
 * ScopeNotGrantedError from delegation — callers map those to 404/403.
 */
export async function mintOnboardToken(
  input: MintOnboardTokenInput,
): Promise<MintedOnboardToken> {
  let childAgentId: string;
  if (input.agentId) {
    const existing = agentsDAL.findAgentById(input.agentId);
    if (!existing) {
      throw new AgentNotFoundError(`Agent ${input.agentId} does not exist`);
    }
    childAgentId = existing.id;
  } else {
    const name = input.agentName ?? `onboarded-${Date.now()}`;
    const { agent } = await agentsDAL.createAgent({
      name,
      description: 'Onboarded via admin onboard-token',
      metadata: { onboarded_via: 'admin-token', onboarded_at: new Date().toISOString() },
    });
    childAgentId = agent.id;
  }

  // Admin is the "parent" with implicit map:* scope. Delegation still
  // runs the scope-subset check so typos in the scope list surface as
  // ScopeNotGrantedError. No parent token — the root-token path applies.
  const credentials = delegateForSpawn({
    parentAgentId: 'admin-key',
    parentScopes: ['map:*'],
    childAgentId,
    requestedScopes: input.scopes,
    ttlMinutes: input.ttlHours * 60,
    childDelegatable: true,
  });

  return {
    agent_id: childAgentId,
    token: credentials.credentials.token,
    method: credentials.method,
    env: credentials.env,
    scopes: input.scopes,
    ttl_hours: credentials.ttlMinutes / 60,
    expires_at: credentials.expiresAt,
  };
}
