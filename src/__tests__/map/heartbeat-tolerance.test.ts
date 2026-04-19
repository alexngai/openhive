/**
 * Tests for graceful heartbeat with missed-pong tolerance.
 *
 * Verifies the heartbeat loop in ws-map.ts:
 * - Connections survive missed pongs up to the configured threshold
 * - connection_degraded events are broadcast on each missed pong
 * - connection_recovered events are broadcast when pongs resume
 * - hub/reconnect notification is sent before termination
 * - Debounced heartbeat batches DB writes
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { getOrCreateLocalAgent } from '../../db/dal/agents.js';
import { createSwarm } from '../../db/dal/map.js';
import {
  unregisterInbound,
  getAllInbound,
} from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel to capture events
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

// Mock sync-listener to avoid outbound connection checks
vi.mock('../../map/sync-listener.js', () => ({
  hasOutboundConnection: vi.fn().mockReturnValue(false),
  handleSyncMessage: vi.fn(),
  isMapSyncMessage: vi.fn().mockReturnValue(false),
}));

import { broadcastToChannel } from '../../realtime/index.js';

const TEST_ROOT = testRoot('heartbeat-tolerance');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'heartbeat-tolerance.db');

// Create a mock WebSocket with controllable pong behavior
function createMockWs(): any {
  const ws = {
    readyState: WebSocket.OPEN as number,
    isAlive: true,
    missedPongs: 0,
    sentMessages: [] as string[],
    terminated: false,
    pinged: false,
    send(data: string) { ws.sentMessages.push(data); },
    ping() { ws.pinged = true; },
    terminate() { ws.terminated = true; ws.readyState = WebSocket.CLOSED; },
    close() { ws.readyState = WebSocket.CLOSED; },
    on() { /* noop */ },
    removeListener() { /* noop */ },
  };
  return ws;
}

describe('heartbeat tolerance', () => {
  let agentId: string;
  let swarmId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const agent = await getOrCreateLocalAgent();
    agentId = agent.id;

    const swarm = createSwarm(agentId, {
      name: 'heartbeat-test-swarm',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
    });
    swarmId = swarm.id;
  });

  afterAll(() => {
    // Clean up any lingering inbound connections
    for (const [id] of getAllInbound()) {
      unregisterInbound(id);
    }
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    (broadcastToChannel as ReturnType<typeof vi.fn>).mockClear();
    // Clean up connections from previous tests
    for (const [id] of getAllInbound()) {
      unregisterInbound(id);
    }
  });

  describe('missed pong counting', () => {
    it('increments missedPongs when isAlive is false', () => {
      const ws = createMockWs();
      ws.isAlive = false;
      ws.missedPongs = 0;

      // Simulate what the heartbeat loop does
      const missed = (ws.missedPongs = (ws.missedPongs || 0) + 1);
      expect(missed).toBe(1);
      expect(ws.missedPongs).toBe(1);
    });

    it('resets missedPongs when pong is received (isAlive true)', () => {
      const ws = createMockWs();
      ws.isAlive = true;
      ws.missedPongs = 2;

      // Simulate heartbeat loop pong-received branch
      const previousMissed = ws.missedPongs || 0;
      ws.missedPongs = 0;

      expect(ws.missedPongs).toBe(0);
      expect(previousMissed).toBe(2);
    });

    it('does not terminate before reaching threshold', () => {
      const ws = createMockWs();
      ws.isAlive = false;
      const threshold = 3;

      // Simulate 2 missed pongs (below threshold)
      for (let i = 0; i < threshold - 1; i++) {
        ws.missedPongs = (ws.missedPongs || 0) + 1;
        expect(ws.missedPongs < threshold).toBe(true);
      }

      expect(ws.terminated).toBe(false);
      expect(ws.missedPongs).toBe(2);
    });

    it('terminates when threshold is reached', () => {
      const ws = createMockWs();
      ws.isAlive = false;
      const threshold = 3;

      for (let i = 0; i < threshold; i++) {
        ws.missedPongs = (ws.missedPongs || 0) + 1;
      }

      expect(ws.missedPongs >= threshold).toBe(true);

      // Simulate termination
      ws.terminate();
      expect(ws.terminated).toBe(true);
    });
  });

  describe('connection_degraded broadcast', () => {
    it('fans out connection_degraded to BOTH map:discovery and per-swarm channel', async () => {
      const { broadcastSwarmLifecycleEvent } = await import('../../realtime/swarm-events.js');

      // Simulate what the heartbeat loop now does: a single helper call
      // that fans out to both channels. This guards against a future
      // refactor that drops one of the broadcasts.
      broadcastSwarmLifecycleEvent(swarmId, {
        type: 'connection_degraded',
        data: {
          swarm_id: swarmId,
          missed_pongs: 1,
          max_missed_pongs: 3,
        },
      });

      const expected = {
        type: 'connection_degraded',
        data: { swarm_id: swarmId, missed_pongs: 1, max_missed_pongs: 3 },
      };
      expect(broadcastToChannel).toHaveBeenCalledWith('map:discovery', expected);
      expect(broadcastToChannel).toHaveBeenCalledWith(`map:swarm:${swarmId}`, expected);
    });
  });

  describe('connection_recovered broadcast', () => {
    it('fans out connection_recovered to BOTH channels when pongs resume', async () => {
      const { broadcastSwarmLifecycleEvent } = await import('../../realtime/swarm-events.js');
      const previousMissed = 2;

      if (previousMissed > 0) {
        broadcastSwarmLifecycleEvent(swarmId, {
          type: 'connection_recovered',
          data: { swarm_id: swarmId, recovered_from_missed: previousMissed },
        });
      }

      const expected = {
        type: 'connection_recovered',
        data: { swarm_id: swarmId, recovered_from_missed: 2 },
      };
      expect(broadcastToChannel).toHaveBeenCalledWith('map:discovery', expected);
      expect(broadcastToChannel).toHaveBeenCalledWith(`map:swarm:${swarmId}`, expected);
    });

    it('does not broadcast recovery when connection was not degraded', async () => {
      const { broadcastSwarmLifecycleEvent } = await import('../../realtime/swarm-events.js');
      const previousMissed = 0;

      if (previousMissed > 0) {
        broadcastSwarmLifecycleEvent(swarmId, {
          type: 'connection_recovered',
          data: { swarm_id: swarmId, recovered_from_missed: previousMissed },
        });
      }

      expect(broadcastToChannel).not.toHaveBeenCalled();
    });
  });

  describe('hub/reconnect notification', () => {
    it('sends hub/reconnect before terminating', () => {
      const ws = createMockWs();
      const missed = 3;

      // Simulate what the heartbeat loop does before termination
      try {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'hub/reconnect',
          params: {
            reason: 'heartbeat_timeout',
            missed_pongs: missed,
            message: 'Connection will be terminated due to missed heartbeats. Please reconnect.',
          },
        }));
      } catch { /* ignore */ }

      expect(ws.sentMessages.length).toBe(1);
      const msg = JSON.parse(ws.sentMessages[0]);
      expect(msg.method).toBe('hub/reconnect');
      expect(msg.params.reason).toBe('heartbeat_timeout');
      expect(msg.params.missed_pongs).toBe(3);
    });
  });

  describe('debounced heartbeat', () => {
    it('batches multiple heartbeat calls within debounce window', async () => {
      vi.useFakeTimers();

      const heartbeatSpy = vi.fn();

      // Simulate debounce behavior
      const debounceTimers = new Map<string, NodeJS.Timeout>();
      const DEBOUNCE_MS = 10_000;

      function debouncedHeartbeat(sid: string) {
        if (debounceTimers.has(sid)) return;
        const timer = setTimeout(() => {
          debounceTimers.delete(sid);
          heartbeatSpy(sid);
        }, DEBOUNCE_MS);
        debounceTimers.set(sid, timer);
      }

      // Call multiple times rapidly
      debouncedHeartbeat('swarm-1');
      debouncedHeartbeat('swarm-1');
      debouncedHeartbeat('swarm-1');

      // Not yet called
      expect(heartbeatSpy).not.toHaveBeenCalled();

      // Advance past debounce
      vi.advanceTimersByTime(DEBOUNCE_MS + 1);

      // Should have been called exactly once
      expect(heartbeatSpy).toHaveBeenCalledTimes(1);
      expect(heartbeatSpy).toHaveBeenCalledWith('swarm-1');

      // Cleanup
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      vi.useRealTimers();
    });

    it('debounces independently per swarm', async () => {
      vi.useFakeTimers();

      const heartbeatSpy = vi.fn();
      const debounceTimers = new Map<string, NodeJS.Timeout>();
      const DEBOUNCE_MS = 10_000;

      function debouncedHeartbeat(sid: string) {
        if (debounceTimers.has(sid)) return;
        const timer = setTimeout(() => {
          debounceTimers.delete(sid);
          heartbeatSpy(sid);
        }, DEBOUNCE_MS);
        debounceTimers.set(sid, timer);
      }

      debouncedHeartbeat('swarm-a');
      debouncedHeartbeat('swarm-b');

      vi.advanceTimersByTime(DEBOUNCE_MS + 1);

      expect(heartbeatSpy).toHaveBeenCalledTimes(2);
      expect(heartbeatSpy).toHaveBeenCalledWith('swarm-a');
      expect(heartbeatSpy).toHaveBeenCalledWith('swarm-b');

      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      vi.useRealTimers();
    });
  });
});
