import { describe, it, expect } from 'vitest';
import {
  OPENHIVE_MAP_SERVER_ID,
  OPENHIVE_SESSION_SERVER_ID,
  agentIdFromSwarm,
  agentIdFromNode,
  agentIdFromSession,
  mapSwarmStatusToState,
  mapNodeStateToState,
} from '../../swarmcraft/constants.js';

describe('SwarmCraft Bridge Constants', () => {
  describe('server IDs', () => {
    it('should have distinct server IDs', () => {
      expect(OPENHIVE_MAP_SERVER_ID).toBe('openhive-hub');
      expect(OPENHIVE_SESSION_SERVER_ID).toBe('openhive-session');
      expect(OPENHIVE_MAP_SERVER_ID).not.toBe(OPENHIVE_SESSION_SERVER_ID);
    });
  });

  describe('agentIdFromSwarm', () => {
    it('should generate deterministic IDs', () => {
      expect(agentIdFromSwarm('swarm-123')).toBe('oh-swarm-swarm-123');
      expect(agentIdFromSwarm('swarm-123')).toBe(agentIdFromSwarm('swarm-123'));
    });

    it('should generate unique IDs per swarm', () => {
      expect(agentIdFromSwarm('a')).not.toBe(agentIdFromSwarm('b'));
    });
  });

  describe('agentIdFromNode', () => {
    it('should include both swarm and agent IDs', () => {
      const id = agentIdFromNode('swarm-1', 'agent-x');
      expect(id).toBe('oh-node-swarm-1-agent-x');
    });

    it('should be deterministic', () => {
      expect(agentIdFromNode('s', 'a')).toBe(agentIdFromNode('s', 'a'));
    });

    it('should be unique across different swarms/agents', () => {
      expect(agentIdFromNode('s1', 'a')).not.toBe(agentIdFromNode('s2', 'a'));
      expect(agentIdFromNode('s', 'a1')).not.toBe(agentIdFromNode('s', 'a2'));
    });
  });

  describe('agentIdFromSession', () => {
    it('should generate session-prefixed IDs', () => {
      expect(agentIdFromSession('res_abc123')).toBe('oh-session-res_abc123');
    });
  });

  describe('mapSwarmStatusToState', () => {
    it('should map online to active', () => {
      expect(mapSwarmStatusToState('online')).toBe('active');
    });

    it('should map unreachable to suspended', () => {
      expect(mapSwarmStatusToState('unreachable')).toBe('suspended');
    });

    it('should map offline to stopped', () => {
      expect(mapSwarmStatusToState('offline')).toBe('stopped');
    });

    it('should default to idle for unknown states', () => {
      expect(mapSwarmStatusToState('weird')).toBe('idle');
    });
  });

  describe('mapNodeStateToState', () => {
    it('should pass through known states', () => {
      expect(mapNodeStateToState('active')).toBe('active');
      expect(mapNodeStateToState('busy')).toBe('busy');
      expect(mapNodeStateToState('idle')).toBe('idle');
      expect(mapNodeStateToState('registered')).toBe('registered');
      expect(mapNodeStateToState('suspended')).toBe('suspended');
      expect(mapNodeStateToState('stopped')).toBe('stopped');
      expect(mapNodeStateToState('failed')).toBe('failed');
    });

    it('should default to idle for unknown states', () => {
      expect(mapNodeStateToState('unknown')).toBe('idle');
    });
  });
});
