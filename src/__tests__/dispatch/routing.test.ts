/**
 * Tests for canRouteToSwarm — the dispatch pre-flight gate.
 *
 * Verifies the route-priority ladder (ACP → mail → none) and that ACP-only
 * swarms are declared unreachable when the hub's ACP stream manager is
 * unavailable (headless deployment).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  canRouteToSwarm,
  setAcpAvailabilityProbe,
  _resetDispatchRouting,
} from '../../dispatch/routing.js';
import {
  registerInbound,
  unregisterInbound,
  type RegisteredAgent,
} from '../../map/connection-registry.js';

function fakeWs(): import('ws').WebSocket {
  return { readyState: 1, send() {}, close() {} } as unknown as import('ws').WebSocket;
}

function registerSwarm(
  swarmId: string,
  agents: Array<{ id: string; capabilities: Record<string, unknown> }>,
) {
  const registered = new Map<string, RegisteredAgent>();
  for (const a of agents) {
    registered.set(a.id, {
      id: a.id,
      name: a.id,
      role: 'worker',
      state: 'active',
      scopes: [],
      capabilities: a.capabilities,
    });
  }
  registerInbound(swarmId, {
    ws: fakeWs(),
    agentId: agents[0]?.id ?? 'primary',
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: registered,
  });
}

describe('canRouteToSwarm', () => {
  beforeEach(() => {
    _resetDispatchRouting();
  });

  afterEach(() => {
    unregisterInbound('swarm-acp');
    unregisterInbound('swarm-mail');
    unregisterInbound('swarm-msg');
    unregisterInbound('swarm-silent');
    unregisterInbound('swarm-hybrid');
    _resetDispatchRouting();
  });

  it('prefers ACP when agent supports it and the stream manager is available', () => {
    registerSwarm('swarm-acp', [
      {
        id: 'coordinator',
        capabilities: { protocols: ['acp'], messaging: { canReceive: true } },
      },
    ]);
    setAcpAvailabilityProbe(() => true);

    expect(canRouteToSwarm('swarm-acp')).toEqual({ route: 'acp' });
  });

  it('falls back to mail when ACP manager is unavailable but mail capability exists', () => {
    registerSwarm('swarm-hybrid', [
      {
        id: 'coordinator',
        capabilities: { protocols: ['acp'], mail: { canJoin: true } },
      },
    ]);
    setAcpAvailabilityProbe(() => false);

    expect(canRouteToSwarm('swarm-hybrid')).toEqual({ route: 'mail' });
  });

  it('returns none for ACP-only swarms when the stream manager is unavailable', () => {
    registerSwarm('swarm-acp', [
      { id: 'coordinator', capabilities: { protocols: ['acp'] } },
    ]);
    setAcpAvailabilityProbe(() => false);

    const decision = canRouteToSwarm('swarm-acp');
    expect(decision.route).toBe('none');
    expect(decision.reason).toMatch(/headless/);
  });

  it('routes mail-only swarms regardless of ACP probe', () => {
    registerSwarm('swarm-mail', [
      { id: 'worker', capabilities: { mail: { canJoin: true } } },
    ]);
    setAcpAvailabilityProbe(() => true);

    expect(canRouteToSwarm('swarm-mail')).toEqual({ route: 'mail' });
  });

  it('routes messaging-only swarms via mail', () => {
    registerSwarm('swarm-msg', [
      { id: 'worker', capabilities: { messaging: { canReceive: true } } },
    ]);

    expect(canRouteToSwarm('swarm-msg')).toEqual({ route: 'mail' });
  });

  it('returns none for swarms with no dispatchable capability', () => {
    registerSwarm('swarm-silent', [{ id: 'worker', capabilities: {} }]);

    const decision = canRouteToSwarm('swarm-silent');
    expect(decision.route).toBe('none');
    expect(decision.reason).toMatch(/neither ACP nor mail/);
  });

  it('returns none for unknown swarms', () => {
    const decision = canRouteToSwarm('swarm-does-not-exist');
    expect(decision.route).toBe('none');
  });
});
