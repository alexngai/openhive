/**
 * forwardTurnToSwarms — retry queue + drain semantics
 *
 * Covers the hub-side path that reliably delivers `mail/turn.received`
 * notifications even across transient WS disconnects:
 *
 *   - Always-queue alongside live sends (so a flapping connection never
 *     silently drops a notification once it's been written to a stale
 *     stream that the sidecar never reads).
 *   - Hub-side dedup by turn_id so duplicate `mail.turn.added` events
 *     don't grow the queue unbounded.
 *   - Drain on `swarm_online`, gated on `node_registered` (sidecar has
 *     completed its MAP handshake) with a 2s fallback timer for buggy
 *     sidecars that never register.
 *
 * These were added in this session and had no direct test coverage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { initMail, getMailEvents } from '../../mail/index.js';
import {
  registerInbound,
  unregisterInbound,
  type MapInboundConnection,
} from '../../map/connection-registry.js';
import { mapHubEvents } from '../../map/service.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('mail-forward-retry');
const TEST_DB = testDbPath(TEST_ROOT, 'forward.db');
const SWARM = 'swarm_test_xyz';

interface SendCapture {
  count: number;
  payloads: object[];
}

function fakeWs(capture: SendCapture): WebSocket {
  return {
    readyState: 1, // OPEN
    send(data: string | Buffer): void {
      capture.count++;
      try { capture.payloads.push(JSON.parse(String(data))); } catch { /* ignore */ }
    },
    close(): void { /* */ },
  } as unknown as WebSocket;
}

function makeConn(swarmId: string, capture: SendCapture, opts?: {
  isStale?: boolean;
  capabilities?: Record<string, unknown>;
}): MapInboundConnection {
  return {
    ws: fakeWs(capture),
    agentId: 'sidecar-1',
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: new Map([
      ['sidecar-1', {
        id: 'sidecar-1',
        name: 'sidecar',
        role: 'sidecar',
        state: 'registered',
        scopes: [],
        capabilities: opts?.capabilities ?? { mail: { canJoin: true } },
      }],
    ]),
    capabilities: opts?.capabilities ?? { mail: { canJoin: true } },
    isStale: opts?.isStale,
    tokenDelegatable: true,
  };
}

function fireTurn(turn: {
  id?: string;
  conversation_id?: string;
  participant_id?: string;
  content?: unknown;
  thread_id?: string;
  created_at?: string;
  content_type?: string;
}): void {
  getMailEvents().emit('mail.turn.added', {
    id: turn.id ?? `turn_${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: turn.conversation_id ?? 'conv_1',
    participant_id: turn.participant_id ?? 'openhive:dispatcher',
    content_type: turn.content_type ?? 'application/json',
    content: turn.content ?? '{"schema":"x-dispatch/work"}',
    thread_id: turn.thread_id,
    created_at: turn.created_at ?? new Date().toISOString(),
  });
}

describe('forwardTurnToSwarms — retry queue', () => {
  beforeEach(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB);
    await initMail();
  });

  afterEach(() => {
    unregisterInbound(SWARM);
    // Drain any pending retry-queue entries left over from this test so
    // they don't leak into the next one. The swarm_online listener
    // synchronously deletes pendingNotifications[swarmId] before firing
    // any sends. Subsequent sendToSwarm calls fail silently because we've
    // unregistered. Result: queue is cleared, no I/O bleed.
    mapHubEvents.emit('swarm_online', { swarm_id: SWARM });
    // NOTE: Don't removeAllListeners('swarm_online') — the
    // forwardTurnToSwarms retry queue installs its swarm_online listener
    // exactly once via a module-scoped `_pendingRetryListenerInstalled`
    // flag. Removing it would leave subsequent tests without a drain
    // handler.
    mapHubEvents.removeAllListeners('node_registered');
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('happy path: live conn with mail.canJoin gets the notification on first send', () => {
    const cap: SendCapture = { count: 0, payloads: [] };
    registerInbound(SWARM, makeConn(SWARM, cap));

    fireTurn({ id: 'turn_a', participant_id: 'openhive:dispatcher' });

    expect(cap.count).toBe(1);
    expect(cap.payloads[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'mail/turn.received',
      params: { turn_id: 'turn_a', conversation_id: 'conv_1' },
    });
  });

  /**
   * Simulate sidecar reconnect: queue a stale notification, then swap the
   * stale conn for a fresh live one (mirroring registerInbound's behavior
   * on reconnect) before triggering drain. sendToSwarm only writes to live
   * connections, so the conn must be un-staled first or the drain is a
   * silent no-op.
   */
  function reconnect(cap: SendCapture): void {
    unregisterInbound(SWARM);
    registerInbound(SWARM, makeConn(SWARM, cap));
  }

  it('hub-side dedup: same turn_id queued twice → only one entry drains on reconnect', () => {
    const cap: SendCapture = { count: 0, payloads: [] };
    registerInbound(SWARM, makeConn(SWARM, cap, { isStale: true }));

    fireTurn({ id: 'turn_b' });
    fireTurn({ id: 'turn_b' }); // duplicate — should not double-queue
    expect(cap.count).toBe(0); // stale path, no live send

    // Reconnect → fresh live conn → drain
    reconnect(cap);
    mapHubEvents.emit('swarm_online', { swarm_id: SWARM });
    mapHubEvents.emit('node_registered', { swarm_id: SWARM });

    // Single drain delivery despite two fires (dedup by turn_id)
    expect(cap.count).toBe(1);
  });

  it('stale conn: notification queued, drained on swarm_online + node_registered after reconnect', () => {
    const cap: SendCapture = { count: 0, payloads: [] };
    registerInbound(SWARM, makeConn(SWARM, cap, { isStale: true }));

    fireTurn({ id: 'turn_c' });
    expect(cap.count).toBe(0);

    reconnect(cap);
    mapHubEvents.emit('swarm_online', { swarm_id: SWARM });
    mapHubEvents.emit('node_registered', { swarm_id: SWARM });

    expect(cap.count).toBe(1);
    expect(cap.payloads[0]).toMatchObject({
      method: 'mail/turn.received',
      params: { turn_id: 'turn_c' },
    });
  });

  it('drain fallback: swarm_online without node_registered drains after 2s', async () => {
    vi.useFakeTimers();
    try {
      const cap: SendCapture = { count: 0, payloads: [] };
      registerInbound(SWARM, makeConn(SWARM, cap, { isStale: true }));

      fireTurn({ id: 'turn_d' });
      expect(cap.count).toBe(0);

      reconnect(cap);
      mapHubEvents.emit('swarm_online', { swarm_id: SWARM });
      // No node_registered — drain should fire via fallback timer
      expect(cap.count).toBe(0);

      // Just before fallback
      vi.advanceTimersByTime(1_900);
      expect(cap.count).toBe(0);

      // Past fallback
      vi.advanceTimersByTime(200);
      expect(cap.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('node_registered for a different swarm does not drain our queue', () => {
    const cap: SendCapture = { count: 0, payloads: [] };
    registerInbound(SWARM, makeConn(SWARM, cap, { isStale: true }));

    fireTurn({ id: 'turn_e' });
    reconnect(cap);
    mapHubEvents.emit('swarm_online', { swarm_id: SWARM });
    mapHubEvents.emit('node_registered', { swarm_id: 'unrelated_swarm' });

    // Still queued — not drained because the registered swarm doesn't match
    expect(cap.count).toBe(0);

    // Real registered event for our swarm now drains
    mapHubEvents.emit('node_registered', { swarm_id: SWARM });
    expect(cap.count).toBe(1);
  });

  it('skip-self: turn from a participant registered on the swarm is not echoed back', () => {
    const cap: SendCapture = { count: 0, payloads: [] };
    const conn = makeConn(SWARM, cap);
    // Add 'agent_worker' as registered so the skip-self branch fires
    conn.registeredAgents.set('agent_worker', {
      id: 'agent_worker',
      name: 'worker',
      role: 'worker',
      state: 'registered',
      scopes: [],
      capabilities: {},
    });
    registerInbound(SWARM, conn);

    fireTurn({ id: 'turn_f', participant_id: 'agent_worker' });

    expect(cap.count).toBe(0);
  });
});
