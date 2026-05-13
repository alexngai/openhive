/**
 * OpenHive Agent Roster — AgentRoster adapter
 *
 * Walks OpenHive's MAP connection registry and surfaces eligible agents to
 * swarm-dispatch's executor chooser. Implements the AgentRoster contract
 * directly (not via `createRegistryRoster`) because the sidecar's role
 * needs to behave as a wildcard fallback rather than a single string.
 *
 * Sidecar-fallback semantics:
 *   1. Exact role matches are preferred. When the spec's `team_role_ref`
 *      surfaces a role onto `task.metadata.role` (added by commit 3439b55
 *      in `openhive-source.ts`), the orchestrator filters by that role.
 *   2. On sidecar-only swarms (no coordinator, no specialized worker
 *      registered yet), the exact-role filter would eliminate every
 *      agent, the orchestrator would fall through to the ACP runtime,
 *      and dispatch would die without ever reaching the mail port.
 *   3. To keep mail routing alive on sidecar-only swarms, the sidecar is
 *      surfaced as a universal fallback: returned only when no
 *      exact-role agent matches. Real workers/coordinators always win
 *      when present.
 *
 * Without this fallback, dispatching a spec with `team_role_ref.role:
 * 'executor'` to a swarm whose only registered agent is the sidecar
 * silently never delivers — the regression captured in
 * `live-loadout-dispatch-e2e.test.ts`.
 */

import type { AgentRoster, AgentRef, PresenceState } from 'swarm-dispatch';
import { getAllInbound } from '../map/connection-registry.js';
import { getActiveDispatchRepoId } from './repo-side-channel.js';
import { getDatabase } from '../db/index.js';

function mapAgentState(state: string): PresenceState {
  switch (state) {
    case 'active':
    case 'idle':
    // Agents that have just connected and declared capabilities sit in
    // 'registered' until their first state.changed event. They are
    // available for routing — without this case they map to 'dormant'
    // and the orchestrator's notBusy filter eliminates them silently.
    case 'registered':
      return 'active';
    case 'busy':
      return 'away';
    case 'stopped':
    case 'failed':
      return 'expired';
    default:
      return 'dormant';
  }
}

export function createOpenHiveRoster(): AgentRoster {
  return {
    async findAvailable(criteria) {
      const exact: AgentRef[] = [];
      const sidecarFallbacks: AgentRef[] = [];

      for (const [, conn] of getAllInbound()) {
        for (const [agentId, agent] of conn.registeredAgents) {
          const presence = mapAgentState(agent.state ?? 'registered');
          if (criteria.notBusy && presence !== 'active') continue;

          const isSidecar = agent.role === 'sidecar';
          // Project sidecar to 'worker' for exact-role matching when no
          // specific role was requested — preserves the pre-3439b55
          // behavior where role-less dispatches routed to the sidecar
          // via the default 'worker' role.
          const projectedRole = isSidecar ? 'worker' : (agent.role ?? 'worker');

          // Tags must match exactly. Sidecars carry no tags, so a
          // tagged-criteria dispatch never falls back to one — that
          // would defeat the tag scoping.
          if (criteria.tags && criteria.tags.length > 0) {
            const agentTags = new Set<string>(
              (agent as { tags?: string[] }).tags ?? [],
            );
            if (!criteria.tags.every((t) => agentTags.has(t))) continue;
          }

          if (criteria.role && projectedRole !== criteria.role) {
            // Exact role mismatch — but if this is a sidecar, hold it
            // as a fallback in case nothing else matches on this swarm.
            if (isSidecar) {
              sidecarFallbacks.push({
                agentId,
                system: conn.swarmId,
              });
            }
            continue;
          }

          exact.push({
            agentId,
            system: conn.swarmId,
          });
        }
      }

      const candidates = exact.length > 0 ? exact : sidecarFallbacks;
      if (candidates.length <= 1) return candidates;

      const repoId = getActiveDispatchRepoId();
      if (!repoId) return candidates;

      const boundSwarms = swarmsWithRepoBindings(repoId);
      if (boundSwarms.size === 0) return candidates;

      const bound: AgentRef[] = [];
      const unbound: AgentRef[] = [];
      for (const c of candidates) {
        if (c.system && boundSwarms.has(c.system)) {
          bound.push(c);
        } else {
          unbound.push(c);
        }
      }
      return [...bound, ...unbound];
    },
  };
}

function swarmsWithRepoBindings(repoId: string): Set<string> {
  try {
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT DISTINCT swarm_id FROM workspaces
       WHERE repo_id = ? AND is_active = 1`,
    ).all(repoId) as Array<{ swarm_id: string }>;
    return new Set(rows.map((r) => r.swarm_id));
  } catch {
    return new Set();
  }
}
