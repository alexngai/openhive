/**
 * Capability-handshake test: when a sidecar registers with the same shape
 * declared in `references/macro-agent/src/map/sidecar.ts:capabilities`,
 * the hub's `hasCapability(swarmId, 'cascade.canServeDiff')` returns true.
 *
 * Closes the seam between S1.10 (sidecar declaration) and the hub gate in
 * diff-resolver tier 2 / cascade-diff-protocol's offline check.
 *
 * Uses the real `registerInbound` + `hasCapability` (no mocking) — only
 * stubs `ws` since we don't need actual WebSocket I/O.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { WebSocket as WSType } from 'ws';
import {
  registerInbound,
  unregisterInbound,
  hasCapability,
  getInbound,
} from '../../map/connection-registry.js';
import type { MapInboundConnection } from '../../map/connection-registry.js';

function fakeWs(): WSType {
  // Only readyState is referenced anywhere on the path under test
  // (getInbound's caller in the resolver). Cast through unknown.
  return { readyState: 1 } as unknown as WSType;
}

function mkConn(
  swarmId: string,
  capabilities: Record<string, unknown> | undefined,
): MapInboundConnection {
  return {
    ws: fakeWs(),
    agentId: 'sidecar-agent',
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: new Map(),
    capabilities,
  };
}

describe('cascade.canServeDiff capability handshake', () => {
  const swarms: string[] = [];

  afterEach(() => {
    while (swarms.length) {
      const id = swarms.pop()!;
      unregisterInbound(id);
    }
  });

  it('hasCapability is true when sidecar declares cascade.canServeDiff at the connection level', () => {
    const swarmId = 'swarm-caps-yes';
    swarms.push(swarmId);
    registerInbound(
      swarmId,
      mkConn(swarmId, {
        // Mirror exactly what S1.10 puts on the wire when an adapter is wired.
        messaging: { canSend: true, canReceive: true },
        mail: { canCreate: true, canJoin: true, canViewHistory: true },
        trajectory: { canReport: true, canServeContent: false },
        cascade: { canServeDiff: true },
      }),
    );

    expect(hasCapability(swarmId, 'cascade.canServeDiff')).toBe(true);
  });

  it('hasCapability is false when sidecar omits the cascade block', () => {
    const swarmId = 'swarm-caps-no';
    swarms.push(swarmId);
    registerInbound(
      swarmId,
      mkConn(swarmId, {
        // Matches sidecar's no-adapter path: no `cascade` key declared.
        messaging: { canSend: true, canReceive: true },
        mail: { canCreate: true, canJoin: true, canViewHistory: true },
        trajectory: { canReport: true, canServeContent: false },
      }),
    );

    expect(hasCapability(swarmId, 'cascade.canServeDiff')).toBe(false);
  });

  it('hasCapability is false for an unknown swarm', () => {
    expect(hasCapability('never-registered-swarm', 'cascade.canServeDiff')).toBe(
      false,
    );
  });

  it('per-agent declaration also satisfies the capability (alternative shape)', () => {
    // Validates that should the sidecar ever shift the capability from
    // connection-level (current shape) to per-agent declarations, the
    // hub's "any agent has" semantics still resolve it correctly.
    const swarmId = 'swarm-caps-per-agent';
    swarms.push(swarmId);
    const conn = mkConn(swarmId, undefined);
    conn.registeredAgents.set('agent-1', {
      id: 'agent-1',
      role: 'sidecar',
      name: 'sidecar',
      capabilities: { cascade: { canServeDiff: true } },
    } as MapInboundConnection['registeredAgents'] extends Map<string, infer A> ? A : never);

    registerInbound(swarmId, conn);
    expect(hasCapability(swarmId, 'cascade.canServeDiff')).toBe(true);
  });

  it('cascade.canServeDiff: false is treated as not-declared (boolean true required)', () => {
    const swarmId = 'swarm-caps-explicit-false';
    swarms.push(swarmId);
    registerInbound(
      swarmId,
      mkConn(swarmId, { cascade: { canServeDiff: false } }),
    );

    expect(hasCapability(swarmId, 'cascade.canServeDiff')).toBe(false);
  });

  // Sanity: a registered connection is reachable via getInbound. The
  // resolver's tier-2 gate is `getInbound(...) && hasCapability(...)`, so
  // we want both halves to behave coherently.
  it('getInbound and hasCapability agree on a registered swarm', () => {
    const swarmId = 'swarm-coherent';
    swarms.push(swarmId);
    registerInbound(
      swarmId,
      mkConn(swarmId, { cascade: { canServeDiff: true } }),
    );

    expect(getInbound(swarmId)).toBeTruthy();
    expect(hasCapability(swarmId, 'cascade.canServeDiff')).toBe(true);

    unregisterInbound(swarmId);
    // After unregister, the connection is marked stale — both queries
    // should now report missing.
    expect(getInbound(swarmId)).toBeUndefined();
    expect(hasCapability(swarmId, 'cascade.canServeDiff')).toBe(false);
    // pop so afterEach doesn't unregister twice
    swarms.pop();
  });
});
