/**
 * OpenHive Agent Roster — AgentRoster adapter
 *
 * Composes swarm-dispatch's generic createRegistryRoster with OpenHive's
 * MAP connection registry for agent discovery.
 */

import { createRegistryRoster } from 'swarm-dispatch/client';
import type { AgentRoster, PresenceState } from 'swarm-dispatch';
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
  return createRegistryRoster({
    listAgents: () => {
      const agents: Array<{ id: string; system: string; role: string; state: string }> = [];
      for (const [, conn] of getAllInbound()) {
        for (const [agentId, agent] of conn.registeredAgents) {
          agents.push({
            id: agentId,
            system: conn.swarmId,
            role: agent.role ?? 'worker',
            state: agent.state ?? 'registered',
          });
        }
      }
      return agents;
    },
    stateMapper: mapAgentState,
  });
}
