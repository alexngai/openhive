/**
 * Tests for MAP connection registry health functions.
 *
 * Verifies getConnectionHealth() and getAllConnectionHealth() return
 * correct structured data including missedPongs from WebSocket state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerInbound,
  unregisterInbound,
  getConnectionHealth,
  getAllConnectionHealth,
  getAllInbound,
  type MapInboundConnection,
} from '../../map/connection-registry.js';

// Minimal mock WebSocket with the properties the registry reads
function createMockWs(overrides: { missedPongs?: number; readyState?: number } = {}) {
  return {
    readyState: overrides.readyState ?? 1, // WebSocket.OPEN
    missedPongs: overrides.missedPongs ?? 0,
    isAlive: true,
    close() { /* noop */ },
    terminate() { /* noop */ },
    ping() { /* noop */ },
    send() { /* noop */ },
    on() { /* noop */ },
    removeListener() { /* noop */ },
  } as any;
}

function createConn(swarmId: string, overrides: Partial<MapInboundConnection> & { missedPongs?: number } = {}): MapInboundConnection {
  const ws = createMockWs({ missedPongs: overrides.missedPongs ?? 0 });
  return {
    ws,
    agentId: overrides.agentId ?? `agent-${swarmId}`,
    swarmId,
    connectedAt: overrides.connectedAt ?? '2026-04-06T10:00:00.000Z',
    lastMessageAt: overrides.lastMessageAt ?? '2026-04-06T10:05:00.000Z',
    registeredAgents: overrides.registeredAgents ?? new Map(),
    capabilities: overrides.capabilities,
    tokenExpiresAt: overrides.tokenExpiresAt,
  };
}

describe('connection-registry health', () => {
  // Clean up after each test
  afterEach(() => {
    for (const [swarmId] of getAllInbound()) {
      unregisterInbound(swarmId);
    }
  });

  describe('getConnectionHealth', () => {
    it('returns undefined for unknown swarm', () => {
      expect(getConnectionHealth('nonexistent', 3)).toBeUndefined();
    });

    it('returns correct health for a registered connection', () => {
      const conn = createConn('swarm-1', {
        tokenExpiresAt: '2026-04-06T12:00:00.000Z',
        capabilities: { trajectory: { canReport: true } },
      });
      registerInbound('swarm-1', conn);

      const health = getConnectionHealth('swarm-1', 3);
      expect(health).toBeDefined();
      expect(health!.swarmId).toBe('swarm-1');
      expect(health!.agentId).toBe('agent-swarm-1');
      expect(health!.transport).toBe('inbound');
      expect(health!.connectedAt).toBe('2026-04-06T10:00:00.000Z');
      expect(health!.lastMessageAt).toBe('2026-04-06T10:05:00.000Z');
      expect(health!.missedPongs).toBe(0);
      expect(health!.maxMissedPongs).toBe(3);
      expect(health!.tokenExpiresAt).toBe('2026-04-06T12:00:00.000Z');
      expect(health!.registeredAgentCount).toBe(0);
      expect(health!.registeredAgents).toEqual([]);
      expect(health!.capabilities).toEqual({ trajectory: { canReport: true } });
    });

    it('reflects missedPongs from WebSocket state', () => {
      const conn = createConn('swarm-miss', { missedPongs: 2 });
      registerInbound('swarm-miss', conn);

      const health = getConnectionHealth('swarm-miss', 3);
      expect(health!.missedPongs).toBe(2);
    });

    it('includes registered agents in health data', () => {
      const agents = new Map([
        ['agent-a', { id: 'agent-a', name: 'Alpha', role: 'worker', state: 'active', scopes: [] }],
        ['agent-b', { id: 'agent-b', name: 'Beta', role: 'reviewer', state: 'idle', scopes: [] }],
      ]);
      const conn = createConn('swarm-agents', { registeredAgents: agents });
      registerInbound('swarm-agents', conn);

      const health = getConnectionHealth('swarm-agents', 5);
      expect(health!.registeredAgentCount).toBe(2);
      expect(health!.registeredAgents).toEqual([
        { id: 'agent-a', name: 'Alpha', role: 'worker', state: 'active' },
        { id: 'agent-b', name: 'Beta', role: 'reviewer', state: 'idle' },
      ]);
    });
  });

  describe('getAllConnectionHealth', () => {
    it('returns empty array with no connections', () => {
      expect(getAllConnectionHealth(3)).toEqual([]);
    });

    it('returns health for all registered connections', () => {
      registerInbound('swarm-a', createConn('swarm-a'));
      registerInbound('swarm-b', createConn('swarm-b', { missedPongs: 1 }));
      registerInbound('swarm-c', createConn('swarm-c', { missedPongs: 2 }));

      const all = getAllConnectionHealth(3);
      expect(all.length).toBe(3);

      const ids = all.map(h => h.swarmId).sort();
      expect(ids).toEqual(['swarm-a', 'swarm-b', 'swarm-c']);

      const degraded = all.filter(h => h.missedPongs > 0);
      expect(degraded.length).toBe(2);
    });

    it('passes maxMissedPongs through to each entry', () => {
      registerInbound('swarm-x', createConn('swarm-x'));

      const all = getAllConnectionHealth(7);
      expect(all[0].maxMissedPongs).toBe(7);
    });
  });
});
