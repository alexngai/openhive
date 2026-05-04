/**
 * Unit tests for `findSidecarAgentId` — the connection-registry helper
 * the mail port uses to force-route `mail_lifecycle: 'fresh'` dispatches
 * to the swarm's sidecar regardless of which agent prefer-route picked.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import {
  registerInbound,
  unregisterInbound,
  findSidecarAgentId,
  type MapInboundConnection,
  type RegisteredAgent,
} from '../../map/connection-registry.js';

function fakeWs(): WebSocket {
  const ee = new EventEmitter() as unknown as WebSocket;
  (ee as unknown as Record<string, unknown>).readyState = 1;
  (ee as unknown as Record<string, unknown>).send = () => {};
  (ee as unknown as Record<string, unknown>).close = () => {};
  (ee as unknown as Record<string, unknown>).terminate = () => {};
  return ee;
}

function makeAgent(id: string, role: string): RegisteredAgent {
  return {
    id,
    name: `agent-${id}`,
    role,
    state: 'idle',
    scopes: [],
  };
}

function makeConn(swarmId: string, agents: RegisteredAgent[]): MapInboundConnection {
  return {
    ws: fakeWs(),
    agentId: agents[0]?.id ?? 'placeholder',
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: new Map(agents.map((a) => [a.id, a])),
  };
}

const SWARM = 'swarm_sidecar_test';

describe('findSidecarAgentId', () => {
  afterEach(() => {
    unregisterInbound(SWARM);
  });

  it('returns null when no inbound connection is registered', () => {
    expect(findSidecarAgentId('swarm_unknown')).toBeNull();
  });

  it('returns null when the connection has no sidecar-role agent', () => {
    registerInbound(
      SWARM,
      makeConn(SWARM, [
        makeAgent('a-coord', 'coordinator'),
        makeAgent('a-worker', 'worker'),
      ]),
    );
    expect(findSidecarAgentId(SWARM)).toBeNull();
  });

  it('returns the sidecar agent id when present', () => {
    registerInbound(
      SWARM,
      makeConn(SWARM, [
        makeAgent('a-side', 'sidecar'),
        makeAgent('a-coord', 'coordinator'),
      ]),
    );
    expect(findSidecarAgentId(SWARM)).toBe('a-side');
  });

  it('returns the first sidecar agent if multiple are registered', () => {
    // Pathological — should be one sidecar per connection — but the helper
    // shouldn't blow up; first wins (Map iteration order = insertion order).
    registerInbound(
      SWARM,
      makeConn(SWARM, [
        makeAgent('a-side-1', 'sidecar'),
        makeAgent('a-side-2', 'sidecar'),
      ]),
    );
    expect(findSidecarAgentId(SWARM)).toBe('a-side-1');
  });
});
