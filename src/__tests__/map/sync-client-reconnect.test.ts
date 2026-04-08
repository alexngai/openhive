/**
 * Tests for MapSyncClient hub/reconnect handling and connection state.
 *
 * Verifies:
 * - hub/reconnect triggers immediate reconnect with reset backoff
 * - ping/pong application-level response
 * - connectionState transitions (disconnected → connecting → connected → reconnecting)
 * - onConnectionStateChange callbacks fire correctly
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MapSyncClient } from '../../map/sync-client.js';
import type { MapSyncClientConfig, ConnectionState } from '../../map/sync-client.js';

// ============================================================================
// WebSocket Mock (reused pattern from sync-client.test.ts)
// ============================================================================

const { MockWebSocket, mockInstances } = vi.hoisted(() => {
  const instances: any[] = [];

  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    sentMessages: string[] = [];
    private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

    constructor() {
      instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(handler);
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers[event] || []) {
        handler(...args);
      }
    }
  }

  return { MockWebSocket, mockInstances: instances };
});

vi.mock('ws', () => ({
  default: MockWebSocket,
  WebSocket: MockWebSocket,
}));

describe('MapSyncClient reconnection', () => {
  const hubConfig: MapSyncClientConfig = {
    agent_id: 'agent_reconnect_test',
    hub_ws_url: 'ws://hub:3000/ws/map?token=test',
  };

  let client: MapSyncClient;

  beforeEach(() => {
    mockInstances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    client?.stop();
    vi.useRealTimers();
  });

  // ─── Connection State Tracking ───────────────────────────────────────────

  describe('connectionState', () => {
    it('starts as disconnected', () => {
      client = new MapSyncClient(hubConfig);
      expect(client.connectionState).toBe('disconnected');
    });

    it('transitions to connecting on start', () => {
      client = new MapSyncClient(hubConfig);

      const states: ConnectionState[] = [];
      client.onConnectionStateChange((state) => states.push(state));

      client.start();

      expect(states).toContain('connecting');
    });

    it('transitions to connected on WebSocket open', () => {
      client = new MapSyncClient(hubConfig);

      const states: ConnectionState[] = [];
      client.onConnectionStateChange((state) => states.push(state));

      client.start();

      // Simulate WebSocket open
      const hubWs = mockInstances[0];
      hubWs.emit('open');

      expect(client.connectionState).toBe('connected');
      expect(states).toContain('connected');
    });

    it('transitions to disconnected on stop', () => {
      client = new MapSyncClient(hubConfig);

      client.start();
      const hubWs = mockInstances[0];
      hubWs.emit('open');

      expect(client.connectionState).toBe('connected');

      client.stop();
      expect(client.connectionState).toBe('disconnected');
    });

    it('transitions to reconnecting on close', () => {
      client = new MapSyncClient(hubConfig);

      const states: ConnectionState[] = [];
      client.onConnectionStateChange((state) => states.push(state));

      client.start();
      const hubWs = mockInstances[0];
      hubWs.emit('open');

      // Simulate connection close
      hubWs.emit('close');

      expect(states).toContain('reconnecting');
    });
  });

  // ─── hub/reconnect handling ──────────────────────────────────────────────

  describe('hub/reconnect', () => {
    it('closes connection and reconnects on hub/reconnect', () => {
      client = new MapSyncClient(hubConfig);
      client.start();

      const hubWs = mockInstances[0];
      hubWs.emit('open');
      expect(client.connectionState).toBe('connected');

      // Simulate hub sending reconnect notification
      const reconnectMsg = JSON.stringify({
        jsonrpc: '2.0',
        method: 'hub/reconnect',
        params: { reason: 'heartbeat_timeout', missed_pongs: 3 },
      });
      hubWs.emit('message', Buffer.from(reconnectMsg));

      // WebSocket should be closed
      expect(hubWs.readyState).toBe(MockWebSocket.CLOSED);

      // Advance past reconnect timer — should reconnect immediately (0 backoff)
      vi.advanceTimersByTime(5_000); // RECONNECT_BASE_MS

      // A new WebSocket instance should have been created
      expect(mockInstances.length).toBe(2);
    });

    it('resets backoff counter on hub/reconnect', () => {
      client = new MapSyncClient(hubConfig);
      client.start();

      const hubWs1 = mockInstances[0];
      hubWs1.emit('open');

      // Simulate hub/reconnect
      hubWs1.emit('message', Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        method: 'hub/reconnect',
        params: { reason: 'heartbeat_timeout' },
      })));

      // First reconnect at base delay (5s)
      vi.advanceTimersByTime(5_000);
      expect(mockInstances.length).toBe(2);

      // Simulate the new connection opening and being told to reconnect again
      const hubWs2 = mockInstances[1];
      hubWs2.emit('open');
      hubWs2.emit('message', Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        method: 'hub/reconnect',
        params: { reason: 'heartbeat_timeout' },
      })));

      // Should reconnect again at base delay (not escalated), proving backoff was reset
      vi.advanceTimersByTime(5_000);
      expect(mockInstances.length).toBe(3);
    });
  });

  // ─── hub/welcome handling ────────────────────────────────────────────────

  describe('hub/welcome', () => {
    it('sets state to connected on hub/welcome', () => {
      client = new MapSyncClient(hubConfig);
      client.start();

      const hubWs = mockInstances[0];

      // Simulate hub/welcome (before 'open' event)
      hubWs.emit('message', Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        method: 'hub/welcome',
        params: { swarm_id: 'swarm-1', agent_id: 'a1' },
      })));

      expect(client.connectionState).toBe('connected');
    });
  });

  // ─── ping/pong handling ──────────────────────────────────────────────────

  describe('ping/pong', () => {
    it('responds to application-level ping with pong', () => {
      client = new MapSyncClient(hubConfig);
      client.start();

      const hubWs = mockInstances[0];
      hubWs.emit('open');

      // Simulate ping from hub
      hubWs.emit('message', Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        method: 'ping',
        params: {},
      })));

      // Should have sent a pong response
      const pongMsg = hubWs.sentMessages.find((m: string) => {
        const parsed = JSON.parse(m);
        return parsed.method === 'pong';
      });
      expect(pongMsg).toBeDefined();
      const parsed = JSON.parse(pongMsg!);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.method).toBe('pong');
    });

    it('does not respond to ping when WebSocket is closed', () => {
      client = new MapSyncClient(hubConfig);
      client.start();

      const hubWs = mockInstances[0];
      hubWs.readyState = MockWebSocket.CLOSED;

      hubWs.emit('message', Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        method: 'ping',
        params: {},
      })));

      expect(hubWs.sentMessages.length).toBe(0);
    });
  });

  // ─── onConnectionStateChange ─────────────────────────────────────────────

  describe('onConnectionStateChange', () => {
    it('fires handler with state and detail', () => {
      client = new MapSyncClient(hubConfig);

      const calls: Array<{ state: ConnectionState; detail?: unknown }> = [];
      client.onConnectionStateChange((state, detail) => {
        calls.push({ state, detail });
      });

      client.start();

      // Should have fired 'connecting'
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].state).toBe('connecting');
    });

    it('does not fire for duplicate state transitions', () => {
      client = new MapSyncClient(hubConfig);

      const states: ConnectionState[] = [];
      client.onConnectionStateChange((state) => states.push(state));

      client.start();
      const hubWs = mockInstances[0];
      hubWs.emit('open');

      // Send hub/welcome which also sets 'connected' — should not fire again
      hubWs.emit('message', Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        method: 'hub/welcome',
        params: {},
      })));

      const connectedCount = states.filter(s => s === 'connected').length;
      expect(connectedCount).toBe(1); // Only once from 'open', not again from 'welcome'
    });

    it('handles errors in state change handlers gracefully', () => {
      client = new MapSyncClient(hubConfig);

      client.onConnectionStateChange(() => {
        throw new Error('Handler error');
      });

      // Should not throw
      expect(() => client.start()).not.toThrow();
    });
  });
});
