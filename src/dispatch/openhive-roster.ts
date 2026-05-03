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
    // Agents that have just connected and declared capabilities sit in
    // 'registered' until their first state.changed event. They are
    // available for routing — without this case they map to 'dormant'
    // and the orchestrator's notBusy filter eliminates them silently.
    // The bug it fixed: any sidecar-only swarm (the default for a
    // freshly-spawned macro-agent before coordinators boot) had every
    // dispatch fall through to spawn-then-fail, never reaching the
    // mail port.
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
  return createRegistryRoster({
    listAgents: () => {
      const agents: Array<{ id: string; system: string; role: string; state: string }> = [];
      for (const [, conn] of getAllInbound()) {
        for (const [agentId, agent] of conn.registeredAgents) {
          // Sidecars are the mail-delivery target for sidecar-only swarms.
          // The orchestrator's role filter defaults to 'worker'; project
          // the sidecar role as 'worker' so dispatches actually route to
          // it. The agent identifies itself as 'sidecar' on the MAP bus
          // (and elsewhere); this projection only affects roster routing.
          const projectedRole =
            agent.role === 'sidecar' ? 'worker' : (agent.role ?? 'worker');
          agents.push({
            id: agentId,
            system: conn.swarmId,
            role: projectedRole,
            state: agent.state ?? 'registered',
          });
        }
      }
      return agents;
    },
    stateMapper: mapAgentState,
  });
}
