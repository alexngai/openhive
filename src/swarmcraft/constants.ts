/**
 * SwarmCraft Bridge Constants
 *
 * Virtual MAP server IDs and deterministic ID generators for projecting
 * OpenHive domain data into SwarmCraft's agent/task model.
 */

// Virtual MAP server IDs — namespace bridged agents by data source
export const OPENHIVE_MAP_SERVER_ID = 'openhive-hub';
export const OPENHIVE_SESSION_SERVER_ID = 'openhive-session';

// ── Deterministic ID generators ──────────────────────────────────────────

export function agentIdFromSwarm(swarmId: string): string {
  return `oh-swarm-${swarmId}`;
}

export function agentIdFromNode(swarmId: string, mapAgentId: string): string {
  return `oh-node-${swarmId}-${mapAgentId}`;
}

export function agentIdFromSession(sessionResourceId: string): string {
  return `oh-session-${sessionResourceId}`;
}

// ── State mapping ────────────────────────────────────────────────────────

/** Map OpenHive swarm status → SwarmCraft agent state */
export function mapSwarmStatusToState(status: string): string {
  switch (status) {
    case 'online': return 'active';
    case 'unreachable': return 'suspended';
    case 'offline': return 'stopped';
    default: return 'idle';
  }
}

/** Map OpenHive node state → SwarmCraft agent state */
export function mapNodeStateToState(state: string): string {
  switch (state) {
    case 'registered': return 'registered';
    case 'active': return 'active';
    case 'busy': return 'busy';
    case 'idle': return 'idle';
    case 'suspended': return 'suspended';
    case 'stopped': return 'stopped';
    case 'failed': return 'failed';
    default: return 'idle';
  }
}

