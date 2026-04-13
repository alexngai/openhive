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

  describe('stale grace period (Fix C)', () => {
    it('unregister marks connection stale but keeps metadata for grace period', async () => {
      const { registerInbound, unregisterInbound, getInbound, getInboundIncludingStale, findAcpAgentInfo } =
        await import('../../map/connection-registry.js');

      // Register a connection with ACP-capable agent metadata
      const agents = new Map();
      agents.set('coord-1', {
        id: 'coord-1',
        name: 'coordinator',
        role: 'coordinator',
        state: 'registered',
        scopes: [],
        capabilities: { protocols: ['acp'], acp: { version: '2024-10-07' } },
        metadata: { localMapId: 'map-local-1', provider_session_id: 'uuid-xyz' },
      });
      registerInbound('swarm-stale', createConn('swarm-stale', { registeredAgents: agents }));

      // Baseline: findAcpAgentInfo returns the agent
      expect(findAcpAgentInfo('swarm-stale')?.targetId).toBe('map-local-1');

      // Unregister (simulates WS close). Active queries return undefined
      unregisterInbound('swarm-stale');
      expect(getInbound('swarm-stale')).toBeUndefined();
      expect(findAcpAgentInfo('swarm-stale')).toBeUndefined();

      // But metadata is still preserved for grace-period access
      const stale = getInboundIncludingStale('swarm-stale');
      expect(stale).toBeDefined();
      expect(stale!.isStale).toBe(true);
      expect(stale!.registeredAgents.get('coord-1')?.metadata?.provider_session_id).toBe('uuid-xyz');
    });

    it('reconnecting with same swarmId carries over registeredAgents from stale', async () => {
      const { registerInbound, unregisterInbound, findAcpAgentInfo } =
        await import('../../map/connection-registry.js');

      // First connection with coordinator
      const agents = new Map();
      agents.set('coord-2', {
        id: 'coord-2',
        name: 'coordinator',
        role: 'coordinator',
        state: 'registered',
        scopes: [],
        capabilities: { protocols: ['acp'], acp: { version: '2024-10-07' } },
        metadata: { localMapId: 'map-local-2', provider_session_id: 'uuid-abc' },
      });
      registerInbound('swarm-reconnect', createConn('swarm-reconnect', { registeredAgents: agents }));

      // Disconnect (marks stale)
      unregisterInbound('swarm-reconnect');
      expect(findAcpAgentInfo('swarm-reconnect')).toBeUndefined();

      // Reconnect with fresh (empty) registeredAgents — emulating a new sidecar WS
      // before the lifecycle bridge has had a chance to re-register agents.
      registerInbound(
        'swarm-reconnect',
        createConn('swarm-reconnect', { registeredAgents: new Map() }),
      );

      // The prior metadata should be carried over — findAcpAgentInfo works immediately
      const info = findAcpAgentInfo('swarm-reconnect');
      expect(info).toBeDefined();
      expect(info!.targetId).toBe('map-local-2');
      expect(info!.metadata?.provider_session_id).toBe('uuid-abc');
    });

    it('re-registration clears stale flag', async () => {
      const { registerInbound, unregisterInbound, getInbound, getInboundIncludingStale } =
        await import('../../map/connection-registry.js');

      registerInbound('swarm-clear', createConn('swarm-clear'));
      unregisterInbound('swarm-clear');
      expect(getInboundIncludingStale('swarm-clear')?.isStale).toBe(true);

      // Reconnect — the new connection should be active (not stale)
      registerInbound('swarm-clear', createConn('swarm-clear'));
      expect(getInbound('swarm-clear')).toBeDefined();
      expect(getInboundIncludingStale('swarm-clear')?.isStale).toBeUndefined();
    });
  });
});
