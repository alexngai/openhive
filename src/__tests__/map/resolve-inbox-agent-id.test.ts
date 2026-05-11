/**
 * Unit tests for `resolveInboxAgentId` — the connection-registry helper
 * that resolves a MAP agent ID to its canonical inbox agent ID.
 *
 * Since the identity unification (dispatch-inbox-threads Phase 1), cc-swarm
 * agents register with MAP using their inbox-derived ID and include
 * `inboxAgentId` in metadata. This helper provides the fallback chain:
 *   1. metadata.inboxAgentId (explicit)
 *   2. mapAgentId (identity already unified, or backward compat)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import {
  registerInbound,
  unregisterInbound,
  resolveInboxAgentId,
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

function makeAgent(
  id: string,
  role: string,
  metadata?: Record<string, unknown>,
): RegisteredAgent {
  return {
    id,
    name: `agent-${id}`,
    role,
    state: 'idle',
    scopes: [],
    metadata,
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

const SWARM = 'swarm_inbox_resolve_test';

describe('resolveInboxAgentId', () => {
  afterEach(() => {
    unregisterInbound(SWARM);
  });

  it('returns mapAgentId when no inbound connection exists', () => {
    expect(resolveInboxAgentId('swarm_unknown', 'some-map-id')).toBe('some-map-id');
  });

  it('returns mapAgentId when agent has no metadata', () => {
    registerInbound(
      SWARM,
      makeConn(SWARM, [makeAgent('agent-abc', 'orchestrator')]),
    );
    expect(resolveInboxAgentId(SWARM, 'agent-abc')).toBe('agent-abc');
  });

  it('returns mapAgentId when agent is not found on the connection', () => {
    registerInbound(
      SWARM,
      makeConn(SWARM, [makeAgent('agent-abc', 'orchestrator')]),
    );
    expect(resolveInboxAgentId(SWARM, 'agent-unknown')).toBe('agent-unknown');
  });

  it('returns inboxAgentId from metadata when present', () => {
    registerInbound(
      SWARM,
      makeConn(SWARM, [
        makeAgent('myteam-main', 'orchestrator', {
          isMain: true,
          sessionId: 'session-123',
          inboxAgentId: 'myteam-main',
        }),
      ]),
    );
    expect(resolveInboxAgentId(SWARM, 'myteam-main')).toBe('myteam-main');
  });

  it('prefers inboxAgentId over mapAgentId when they differ', () => {
    // Backward compat scenario: old agent registered with sessionId as MAP ID
    // but has inboxAgentId metadata added later
    registerInbound(
      SWARM,
      makeConn(SWARM, [
        makeAgent('session-uuid-456', 'orchestrator', {
          isMain: true,
          sessionId: 'session-uuid-456',
          inboxAgentId: 'myteam-main',
        }),
      ]),
    );
    expect(resolveInboxAgentId(SWARM, 'session-uuid-456')).toBe('myteam-main');
  });

  it('falls back to mapAgentId when inboxAgentId is empty string', () => {
    registerInbound(
      SWARM,
      makeConn(SWARM, [
        makeAgent('agent-abc', 'worker', { inboxAgentId: '' }),
      ]),
    );
    expect(resolveInboxAgentId(SWARM, 'agent-abc')).toBe('agent-abc');
  });

  it('falls back to mapAgentId when inboxAgentId is not a string', () => {
    registerInbound(
      SWARM,
      makeConn(SWARM, [
        makeAgent('agent-abc', 'worker', { inboxAgentId: 42 }),
      ]),
    );
    expect(resolveInboxAgentId(SWARM, 'agent-abc')).toBe('agent-abc');
  });

  it('handles metadata with other fields but no inboxAgentId', () => {
    registerInbound(
      SWARM,
      makeConn(SWARM, [
        makeAgent('agent-abc', 'coordinator', {
          peerMapId: 'peer-123',
          sessionId: 'session-xyz',
        }),
      ]),
    );
    expect(resolveInboxAgentId(SWARM, 'agent-abc')).toBe('agent-abc');
  });
});
