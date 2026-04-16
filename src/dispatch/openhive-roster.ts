/**
 * OpenHive Agent Roster — AgentRoster adapter
 *
 * Queries the MAP connection registry for agents available for routed dispatch.
 * Maps MAP agent states to swarm-dispatch PresenceState.
 */

import type { AgentRoster, AgentRef, PresenceState } from 'swarm-dispatch';
import { getAllInbound } from '../map/connection-registry.js';

function mapAgentState(state: string): PresenceState {
  switch (state) {
    case 'active':
    case 'idle':
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
      const refs: AgentRef[] = [];
      const connections = getAllInbound();

      for (const [, conn] of connections) {
        for (const [agentId, agent] of conn.registeredAgents) {
          const presence = mapAgentState(agent.state ?? 'registered');
          if (criteria.notBusy && presence !== 'active') continue;

          const agentRole = agent.role ?? 'worker';
          if (criteria.role && agentRole !== criteria.role) continue;

          refs.push({
            agentId,
            system: conn.swarmId,
          });
        }
      }

      return refs;
    },

    onAgentStateChanged(handler) {
      // No-op for now — MAP connection registry doesn't emit granular
      // agent state-change events. The orchestrator falls back to polling.
      void handler;
      return () => {};
    },
  };
}
